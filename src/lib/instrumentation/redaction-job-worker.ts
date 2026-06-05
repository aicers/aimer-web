// Retroactive re-redact background worker (issue #253).
//
// Drains the redaction_jobs queue per RFC 0001 §"Retroactive re-redact
// job". On each polled queued row the worker:
//
//   1. Acquires a per-customer session-scope advisory lock on a
//      dedicated auth_db client.
//   2. Materialises a frozen item set into redaction_job_items (one
//      row per stale (table, pk) tuple) and freezes the customer's
//      CIDR set into redaction_jobs.range_snapshot.
//   3. Processes each item: reconstruct the row's original entity
//      values by substituting <<REDACTED_*>> tokens against the
//      existing map, re-run the redaction engine under the frozen
//      target, UPDATE the customer-db referent, and UPSERT the map
//      when new tokens are appended.
//   4. Emits retroactive_started / completed / failed audit rows.
//
// The session-scope advisory lock is bound to the dedicated client
// connection — every state mutation on the job row reuses the same
// client so a hand-off back to the pool does not silently release the
// lock and let another replica steal the job mid-flight.

import "server-only";

import { createHash } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { z } from "zod";
import { auditLog } from "../audit";
import { getAuthPool } from "../db/client";
import { getCustomerRuntimePool } from "../db/customer-runtime-pool";
import { buildOwnedDomainSet } from "../redaction/domains";
import { ENGINE_VERSION, redact } from "../redaction/engine";
import {
  decryptRedactionMap,
  encryptRedactionMap,
} from "../redaction/envelope-adapter";
import { buildRangeSet } from "../redaction/ranges";
import {
  REDACTION_VERSIONED_TABLES,
  type RedactionVersionedTable,
} from "../redaction/stale-scan";
import type {
  OwnedDomainSet,
  RangeSet,
  RedactionMap,
} from "../redaction/types";

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

/**
 * Heuristic per-row processing cost used to estimate the worker's
 * duration. Consumed by the preview endpoint (#252) for the operator's
 * duration estimate before the worker is started.
 */
export const PER_ROW_SECONDS = 0.05;

const DEFAULT_POLL_INTERVAL_MS = 5000;
const DEFAULT_BATCH_SIZE = 50;
const DEFAULT_FAILURE_THRESHOLD = 0.1;

const POLL_INTERVAL_MS = resolveInt(
  process.env.REDACTION_JOB_POLL_INTERVAL_MS,
  DEFAULT_POLL_INTERVAL_MS,
);
const BATCH_SIZE = resolveInt(
  process.env.REDACTION_JOB_BATCH_SIZE,
  DEFAULT_BATCH_SIZE,
);
const FAILURE_THRESHOLD = resolveFloat(
  process.env.REDACTION_JOB_FAILURE_THRESHOLD,
  DEFAULT_FAILURE_THRESHOLD,
);

function resolveInt(raw: string | undefined, fallback: number): number {
  if (!raw) return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}

function resolveFloat(raw: string | undefined, fallback: number): number {
  if (!raw) return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

const SYSTEM_ACTOR = "system";

interface JobRow {
  id: string;
  customer_id: string;
  status: string;
  target_policy_version: string;
  total_rows: number | null;
  processed_rows: number;
  failed_rows: number;
  running_started_at: Date | null;
  started_at: Date;
  range_snapshot: RangeSnapshot | null;
  range_snapshot_ranges_hash: string | null;
  triggered_by: string;
  cancelled_by: string | null;
  cancellation_reason: string | null;
}

// pg returns BIGINT as strings; the worker arithmetic
// (`processed += 1`) would string-concatenate without this normalisation
// and the eventual write back to the BIGINT column would overflow.
interface RawJobRow
  extends Omit<JobRow, "total_rows" | "processed_rows" | "failed_rows"> {
  total_rows: string | null;
  processed_rows: string;
  failed_rows: string;
}

function normaliseJobRow(raw: RawJobRow): JobRow {
  return {
    ...raw,
    total_rows: raw.total_rows == null ? null : Number(raw.total_rows),
    processed_rows: Number(raw.processed_rows),
    failed_rows: Number(raw.failed_rows),
  };
}

interface RangeSnapshot {
  engine_semver: string;
  cidrs: Array<{ cidr: string; ip_version: 4 | 6 }>;
}

interface JobItem {
  job_id: string;
  seq: string;
  source_table: RedactionVersionedTable;
  primary_key: Record<string, string>;
  resolved_aice_id: string;
  resolved_event_key: string;
  status: string;
}

// Per-table primary-key shape validators. The JSONB stored in
// `redaction_job_items.primary_key` must match the exact set of keys for
// each `source_table` — a missing or extra field would propagate as
// `undefined` into the table-specific UPDATE/SELECT casts and surface
// later as a generic per-row failure (or worse, a silently wrong row
// touched). Validate at write (`rowToCandidate` materialisation) and at
// read (per-item batch fetch) so schema-incompatible rows fail loudly
// with the originating source_table / seq in the error.
const PRIMARY_KEY_SCHEMAS = {
  detection_events: z.strictObject({ id: z.string().min(1) }),
  baseline_event: z.strictObject({
    baseline_version: z.string().min(1),
    event_key: z.string().min(1),
  }),
  story_member: z.strictObject({
    story_id: z.string().min(1),
    story_version: z.string().min(1),
    member_event_key: z.string().min(1),
  }),
  policy_event: z.strictObject({
    run_id: z.string().min(1),
    event_key: z.string().min(1),
  }),
  event_analysis_result: z.strictObject({
    aice_id: z.string().min(1),
    event_key: z.string().min(1),
    lang: z.string().min(1),
    model_name: z.string().min(1),
    model: z.string().min(1),
  }),
} as const satisfies Record<RedactionVersionedTable, z.ZodTypeAny>;

export class PrimaryKeyShapeError extends Error {
  readonly table: RedactionVersionedTable;
  constructor(table: RedactionVersionedTable, detail: string) {
    super(`primary_key shape mismatch for ${table}: ${detail}`);
    this.name = "PrimaryKeyShapeError";
    this.table = table;
  }
}

function validatePrimaryKey(
  table: RedactionVersionedTable,
  raw: unknown,
): Record<string, string> {
  const schema = PRIMARY_KEY_SCHEMAS[table];
  const result = schema.safeParse(raw);
  if (!result.success) {
    const issues = result.error.issues
      .map((i) => `${i.path.join(".") || "<root>"}: ${i.message}`)
      .join("; ");
    throw new PrimaryKeyShapeError(table, issues);
  }
  return result.data as Record<string, string>;
}

export interface WorkerDeps {
  authPool: Pool;
  /**
   * Acquire a dedicated auth_db client to be held for the lifetime of
   * the job. Released only after the terminal status flip + advisory
   * unlock.
   */
  acquireAuthClient: () => Promise<PoolClient>;
  /**
   * Open a customer-db pool client; released after the per-item
   * transaction completes.
   */
  connectCustomer: (customerId: string) => Promise<PoolClient>;
}

// ---------------------------------------------------------------------------
// Default deps
// ---------------------------------------------------------------------------

function defaultDeps(): WorkerDeps {
  const authPool = getAuthPool();
  return {
    authPool,
    acquireAuthClient: () => authPool.connect(),
    connectCustomer: (customerId) =>
      getCustomerRuntimePool(customerId).connect(),
  };
}

// ---------------------------------------------------------------------------
// Hash + range snapshot helpers
// ---------------------------------------------------------------------------

function shortRangesHash(normalisedCidrs: readonly string[]): string {
  if (normalisedCidrs.length === 0) return "empty";
  const json = JSON.stringify(normalisedCidrs);
  return createHash("sha256").update(json).digest("hex").slice(0, 12);
}

function rangeSetFromSnapshot(snapshot: RangeSnapshot): RangeSet {
  return buildRangeSet(snapshot.cidrs.map((c) => c.cidr));
}

function snapshotFromCidrs(cidrs: string[]): {
  snapshot: RangeSnapshot;
  hash: string;
  rangeSet: RangeSet;
} {
  const rangeSet = buildRangeSet(cidrs);
  const cidrEntries = rangeSet.ranges.map((r) => ({
    cidr: r.cidr,
    ip_version: r.ipVersion,
  }));
  const snapshot: RangeSnapshot = {
    engine_semver: ENGINE_VERSION,
    cidrs: cidrEntries,
  };
  const hash = shortRangesHash(rangeSet.normalisedCidrs);
  return { snapshot, hash, rangeSet };
}

function targetHashFragment(targetPolicyVersion: string): string {
  const idx = targetPolicyVersion.indexOf("|ranges:");
  if (idx === -1) return "";
  const after = targetPolicyVersion.slice(idx + "|ranges:".length);
  // Isolate the ranges hash only: a `|domains:<short>` segment (RFC
  // 0001 Amendment A.2) now follows it, so stop at the next `|`.
  // Without this the fragment would greedily include the domains
  // segment and never match the recomputed ranges hash.
  const nextPipe = after.indexOf("|");
  return nextPipe === -1 ? after : after.slice(0, nextPipe);
}

function validateRangeSnapshot(job: JobRow): RangeSet {
  if (!job.range_snapshot) {
    throw new SnapshotError("range_snapshot_missing");
  }
  if (!job.range_snapshot_ranges_hash) {
    throw new SnapshotError("range_snapshot_missing");
  }
  if (job.range_snapshot.engine_semver !== ENGINE_VERSION) {
    throw new SnapshotError("engine_version_unavailable");
  }
  const rangeSet = rangeSetFromSnapshot(job.range_snapshot);
  const recomputed = shortRangesHash(rangeSet.normalisedCidrs);
  if (
    recomputed !== job.range_snapshot_ranges_hash ||
    recomputed !== targetHashFragment(job.target_policy_version)
  ) {
    throw new SnapshotError("range_snapshot_corrupt");
  }
  return rangeSet;
}

class SnapshotError extends Error {
  readonly code: string;
  constructor(code: string) {
    super(code);
    this.code = code;
  }
}

// Compute `completed_at - running_started_at` strictly from persisted
// timestamps. Returns 0 if either timestamp is missing — the caller
// reaches this with a freshly-written `completed_at` returned by the
// terminal UPDATE, so the null branch only triggers if the running edge
// never wrote `running_started_at` (which would itself be a bug worth
// surfacing as zero rather than a fabricated app-clock value).
function durationFromTimestamps(
  runningStartedAt: Date | null,
  completedAt: Date | null,
): number {
  if (!runningStartedAt || !completedAt) return 0;
  return completedAt.getTime() - runningStartedAt.getTime();
}

// ---------------------------------------------------------------------------
// Token reconstruction
// ---------------------------------------------------------------------------

const TOKEN_RE = /<<REDACTED_(IP|EMAIL|MAC|DOMAIN)_\d{3,}>>/g;

/**
 * Walk a JSON value substituting every <<REDACTED_*>> token in string
 * leaves with the matching map value. A token without a map entry is
 * treated as an invariant violation by the caller.
 */
function substituteTokens(
  value: unknown,
  map: RedactionMap,
  missing: Set<string>,
): unknown {
  if (typeof value === "string") {
    return value.replace(TOKEN_RE, (token) => {
      const entry = map[token];
      if (!entry) {
        missing.add(token);
        return token;
      }
      return entry.value;
    });
  }
  if (Array.isArray(value)) {
    return value.map((v) => substituteTokens(v, map, missing));
  }
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = substituteTokens(v, map, missing);
    }
    return out;
  }
  return value;
}

// ---------------------------------------------------------------------------
// Materialization queries
// ---------------------------------------------------------------------------

interface CandidateRow {
  primary_key: Record<string, string>;
  resolved_aice_id: string;
  resolved_event_key: string;
}

function staleRowsSelectSql(table: RedactionVersionedTable): string {
  switch (table) {
    case "detection_events":
      return `SELECT id, aice_id, event_key::text AS event_key
                FROM detection_events
               WHERE redaction_policy_version <> $1
               ORDER BY id`;
    case "baseline_event":
      return `SELECT baseline_version, event_key::text AS event_key,
                     source_aice_id
                FROM baseline_event
               WHERE redaction_policy_version <> $1
               ORDER BY baseline_version, event_key`;
    case "story_member":
      return `SELECT sm.story_id::text AS story_id,
                     sm.story_version,
                     sm.member_event_key::text AS member_event_key,
                     s.source_aice_id
                FROM story_member sm
                JOIN story s ON s.story_id = sm.story_id
                            AND s.story_version = sm.story_version
               WHERE sm.redaction_policy_version <> $1
               ORDER BY sm.story_id, sm.story_version, sm.member_event_key`;
    case "policy_event":
      return `SELECT pe.run_id::text AS run_id,
                     pe.event_key::text AS event_key,
                     pr.source_aice_id
                FROM policy_event pe
                JOIN policy_run pr ON pr.run_id = pe.run_id
               WHERE pe.redaction_policy_version <> $1
               ORDER BY pe.run_id, pe.event_key`;
    case "event_analysis_result":
      return `SELECT aice_id, event_key::text AS event_key,
                     lang, model_name, model
                FROM event_analysis_result
               WHERE redaction_policy_version <> $1
               ORDER BY aice_id, event_key, lang, model_name, model`;
  }
}

function stringifyKey(table: RedactionVersionedTable, value: unknown): string {
  if (value === null || value === undefined) {
    throw new PrimaryKeyShapeError(table, "null/undefined primary-key field");
  }
  return String(value);
}

function rowToCandidate(
  table: RedactionVersionedTable,
  row: Record<string, unknown>,
): CandidateRow {
  let pk: Record<string, string>;
  let resolvedAiceId: string;
  let resolvedEventKey: string;
  switch (table) {
    case "detection_events":
      pk = { id: stringifyKey(table, row.id) };
      resolvedAiceId = stringifyKey(table, row.aice_id);
      resolvedEventKey = stringifyKey(table, row.event_key);
      break;
    case "baseline_event":
      pk = {
        baseline_version: stringifyKey(table, row.baseline_version),
        event_key: stringifyKey(table, row.event_key),
      };
      resolvedAiceId = stringifyKey(table, row.source_aice_id);
      resolvedEventKey = stringifyKey(table, row.event_key);
      break;
    case "story_member":
      pk = {
        story_id: stringifyKey(table, row.story_id),
        story_version: stringifyKey(table, row.story_version),
        member_event_key: stringifyKey(table, row.member_event_key),
      };
      resolvedAiceId = stringifyKey(table, row.source_aice_id);
      resolvedEventKey = stringifyKey(table, row.member_event_key);
      break;
    case "policy_event":
      pk = {
        run_id: stringifyKey(table, row.run_id),
        event_key: stringifyKey(table, row.event_key),
      };
      resolvedAiceId = stringifyKey(table, row.source_aice_id);
      resolvedEventKey = stringifyKey(table, row.event_key);
      break;
    case "event_analysis_result":
      pk = {
        aice_id: stringifyKey(table, row.aice_id),
        event_key: stringifyKey(table, row.event_key),
        lang: stringifyKey(table, row.lang),
        model_name: stringifyKey(table, row.model_name),
        model: stringifyKey(table, row.model),
      };
      resolvedAiceId = stringifyKey(table, row.aice_id);
      resolvedEventKey = stringifyKey(table, row.event_key);
      break;
  }
  // Defence-in-depth: parse through the same Zod schema that gates the
  // read side, so a future refactor that adds a field on one side
  // tripwires immediately.
  validatePrimaryKey(table, pk);
  return {
    primary_key: pk,
    resolved_aice_id: resolvedAiceId,
    resolved_event_key: resolvedEventKey,
  };
}

async function materializeJobItems(
  authClient: PoolClient,
  customerPool: Pool,
  jobId: string,
  targetPolicyVersion: string,
): Promise<number> {
  let seq = 0;
  for (const table of REDACTION_VERSIONED_TABLES) {
    const { rows } = await customerPool.query<Record<string, unknown>>(
      staleRowsSelectSql(table),
      [targetPolicyVersion],
    );
    for (const raw of rows) {
      seq += 1;
      const candidate = rowToCandidate(table, raw);
      await authClient.query(
        `INSERT INTO redaction_job_items
           (job_id, seq, source_table, primary_key,
            resolved_aice_id, resolved_event_key)
         VALUES ($1, $2, $3, $4::jsonb, $5, $6::numeric)`,
        [
          jobId,
          seq,
          table,
          JSON.stringify(candidate.primary_key),
          candidate.resolved_aice_id,
          candidate.resolved_event_key,
        ],
      );
    }
  }
  return seq;
}

// ---------------------------------------------------------------------------
// Per-item processing
// ---------------------------------------------------------------------------

interface FetchResult {
  exists: boolean;
  policyVersion: string;
  redacted: Record<string, unknown>;
}

async function fetchRedactedRow(
  client: PoolClient,
  table: RedactionVersionedTable,
  pk: Record<string, string>,
): Promise<FetchResult | null> {
  switch (table) {
    case "detection_events": {
      const { rows } = await client.query<{
        redacted_event: Record<string, unknown>;
        redaction_policy_version: string;
      }>(
        `SELECT redacted_event, redaction_policy_version
           FROM detection_events WHERE id = $1`,
        [pk.id],
      );
      if (rows.length === 0) return null;
      return {
        exists: true,
        policyVersion: rows[0].redaction_policy_version,
        redacted: { redacted_event: rows[0].redacted_event },
      };
    }
    case "baseline_event": {
      const { rows } = await client.query<{
        raw_event: Record<string, unknown>;
        redaction_policy_version: string;
      }>(
        `SELECT raw_event, redaction_policy_version
           FROM baseline_event
          WHERE baseline_version = $1 AND event_key = $2::numeric`,
        [pk.baseline_version, pk.event_key],
      );
      if (rows.length === 0) return null;
      return {
        exists: true,
        policyVersion: rows[0].redaction_policy_version,
        redacted: { raw_event: rows[0].raw_event },
      };
    }
    case "story_member": {
      const { rows } = await client.query<{
        event: Record<string, unknown>;
        redaction_policy_version: string;
      }>(
        `SELECT event, redaction_policy_version
           FROM story_member
          WHERE story_id = $1::bigint AND story_version = $2
            AND member_event_key = $3::numeric`,
        [pk.story_id, pk.story_version, pk.member_event_key],
      );
      if (rows.length === 0) return null;
      return {
        exists: true,
        policyVersion: rows[0].redaction_policy_version,
        redacted: { event: rows[0].event },
      };
    }
    case "policy_event": {
      const { rows } = await client.query<{
        orig_addr: string | null;
        resp_addr: string | null;
        host: string | null;
        dns_query: string | null;
        uri: string | null;
        policy_triage_snapshot: unknown;
        redaction_policy_version: string;
      }>(
        `SELECT orig_addr, resp_addr, host, dns_query, uri,
                policy_triage_snapshot, redaction_policy_version
           FROM policy_event
          WHERE run_id = $1::bigint AND event_key = $2::numeric`,
        [pk.run_id, pk.event_key],
      );
      if (rows.length === 0) return null;
      const r = rows[0];
      return {
        exists: true,
        policyVersion: r.redaction_policy_version,
        redacted: {
          orig_addr: r.orig_addr,
          resp_addr: r.resp_addr,
          host: r.host,
          dns_query: r.dns_query,
          uri: r.uri,
          policy_triage_snapshot: r.policy_triage_snapshot,
        },
      };
    }
    case "event_analysis_result": {
      const { rows } = await client.query<{
        analysis_text: string;
        redaction_policy_version: string;
      }>(
        `SELECT analysis_text, redaction_policy_version
           FROM event_analysis_result
          WHERE aice_id = $1 AND event_key = $2::numeric
            AND lang = $3 AND model_name = $4 AND model = $5`,
        [pk.aice_id, pk.event_key, pk.lang, pk.model_name, pk.model],
      );
      if (rows.length === 0) return null;
      return {
        exists: true,
        policyVersion: rows[0].redaction_policy_version,
        redacted: { analysis_text: rows[0].analysis_text },
      };
    }
  }
}

// Returns the number of rows actually updated. The caller treats a zero
// result as "row was deleted between our fetch and update" (e.g. a
// retention or cascade delete races with the worker between the SELECT
// and the UPDATE inside the per-item customer-db transaction) and
// converts that into a `skipped` outcome, matching the `row_missing`
// semantic for a referent that was never fetched.
async function updateRedactedRow(
  client: PoolClient,
  table: RedactionVersionedTable,
  pk: Record<string, string>,
  redacted: Record<string, unknown>,
  targetPolicyVersion: string,
): Promise<number> {
  switch (table) {
    case "detection_events": {
      const r = await client.query(
        `UPDATE detection_events
            SET redacted_event = $1::jsonb,
                redaction_policy_version = $2
          WHERE id = $3`,
        [JSON.stringify(redacted.redacted_event), targetPolicyVersion, pk.id],
      );
      return r.rowCount ?? 0;
    }
    case "baseline_event": {
      const r = await client.query(
        `UPDATE baseline_event
            SET raw_event = $1::jsonb,
                redaction_policy_version = $2
          WHERE baseline_version = $3 AND event_key = $4::numeric`,
        [
          JSON.stringify(redacted.raw_event),
          targetPolicyVersion,
          pk.baseline_version,
          pk.event_key,
        ],
      );
      return r.rowCount ?? 0;
    }
    case "story_member": {
      const r = await client.query(
        `UPDATE story_member
            SET event = $1::jsonb,
                redaction_policy_version = $2
          WHERE story_id = $3::bigint AND story_version = $4
            AND member_event_key = $5::numeric`,
        [
          JSON.stringify(redacted.event),
          targetPolicyVersion,
          pk.story_id,
          pk.story_version,
          pk.member_event_key,
        ],
      );
      return r.rowCount ?? 0;
    }
    case "policy_event": {
      const r = await client.query(
        `UPDATE policy_event
            SET orig_addr = $1, resp_addr = $2, host = $3,
                dns_query = $4, uri = $5,
                policy_triage_snapshot = $6::jsonb,
                redaction_policy_version = $7
          WHERE run_id = $8::bigint AND event_key = $9::numeric`,
        [
          redacted.orig_addr ?? null,
          redacted.resp_addr ?? null,
          redacted.host ?? null,
          redacted.dns_query ?? null,
          redacted.uri ?? null,
          JSON.stringify(redacted.policy_triage_snapshot),
          targetPolicyVersion,
          pk.run_id,
          pk.event_key,
        ],
      );
      return r.rowCount ?? 0;
    }
    case "event_analysis_result": {
      const r = await client.query(
        `UPDATE event_analysis_result
            SET analysis_text = $1,
                redaction_policy_version = $2
          WHERE aice_id = $3 AND event_key = $4::numeric
            AND lang = $5 AND model_name = $6 AND model = $7`,
        [
          String(redacted.analysis_text),
          targetPolicyVersion,
          pk.aice_id,
          pk.event_key,
          pk.lang,
          pk.model_name,
          pk.model,
        ],
      );
      return r.rowCount ?? 0;
    }
  }
}

// ---------------------------------------------------------------------------
// Map helpers (acquire advisory xact lock; read/upsert raw payload)
// ---------------------------------------------------------------------------

// Acquire the per-event advisory lock that serializes the worker against
// live ingestion for `(aice_id, event_key)`. Must be called immediately
// after BEGIN — before any per-row fetch — so the worker's view of the
// referent row and the map are taken under the lock and a concurrent
// live-ingest write cannot land between fetch and update.
async function acquireEventLock(
  client: PoolClient,
  aiceId: string,
  eventKey: string,
): Promise<void> {
  await client.query(
    "SELECT pg_advisory_xact_lock(hashtextextended($1 || '|' || $2::text, 0))",
    [aiceId, eventKey],
  );
}

async function readMap(
  client: PoolClient,
  customerId: string,
  aiceId: string,
  eventKey: string,
): Promise<RedactionMap | null> {
  const { rows } = await client.query<{
    ciphertext: Buffer;
    wrapped_dek: string;
  }>(
    `SELECT ciphertext, wrapped_dek
       FROM event_redaction_map
      WHERE aice_id = $1 AND event_key = $2::numeric`,
    [aiceId, eventKey],
  );
  if (rows.length === 0) return null;
  return decryptRedactionMap(
    customerId,
    rows[0].ciphertext,
    rows[0].wrapped_dek,
  );
}

async function upsertMap(
  client: PoolClient,
  customerId: string,
  aiceId: string,
  eventKey: string,
  map: RedactionMap,
): Promise<void> {
  const { ciphertext, wrappedDek } = await encryptRedactionMap(customerId, map);
  await client.query(
    `INSERT INTO event_redaction_map
       (aice_id, event_key, ciphertext, wrapped_dek)
     VALUES ($1, $2::numeric, $3, $4)
     ON CONFLICT (aice_id, event_key)
     DO UPDATE SET
       ciphertext = EXCLUDED.ciphertext,
       wrapped_dek = EXCLUDED.wrapped_dek,
       updated_at = NOW()`,
    [aiceId, eventKey, ciphertext, wrappedDek],
  );
}

// ---------------------------------------------------------------------------
// Job processing
// ---------------------------------------------------------------------------

interface ProcessOutcome {
  status: "completed" | "failed" | "cancelled";
  processedRows: number;
  failedRows: number;
  skippedRows: number;
  errorMessage?: string;
}

type ProcessItemResult = "done" | "failed" | "skipped" | "deferred";

async function processItem(
  authClient: PoolClient,
  job: JobRow,
  item: JobItem,
  ranges: RangeSet,
  ownedDomains: OwnedDomainSet,
  targetPolicyVersion: string,
  deps: WorkerDeps,
): Promise<ProcessItemResult> {
  const customerClient = await deps.connectCustomer(job.customer_id);
  // Set true once the customer-db side is consistent with "done": either
  // we COMMIT a successful re-redact, or the idempotency short-circuit
  // observes that the row is already stamped with the target policy.
  // After that point a failure of the auth-side mark MUST NOT downgrade
  // the item to status='failed' — leaving it pending lets the next pass
  // re-enter the short-circuit and mark it done, preserving the
  // documented cross-DB idempotency recovery.
  let customerCompleted = false;
  // Action decided inside the customer-db transaction; performed against
  // the auth-db afterwards so that an auth-side error is distinguishable
  // from a customer-db error.
  type Action =
    | { kind: "done" }
    | { kind: "skipped"; reason: string }
    | {
        kind: "failed";
        reason: string;
        injectivity?: { missing: string[] };
      };
  let action: Action;
  try {
    try {
      await customerClient.query("BEGIN");
      // Acquire the per-event advisory lock BEFORE fetching the referent
      // row. The same lock is taken by live-ingest paths
      // (`readMapWithLock`) so this serializes the worker's
      // fetch/idempotency-check/update against any concurrent ingest for
      // the same `(aice_id, event_key)`. Without it, the worker could
      // read a stale pre-ingest snapshot, the ingest could then commit
      // under the live policy, and the worker would overwrite that fresh
      // row with the frozen job target — an old-target downgrade.
      await acquireEventLock(
        customerClient,
        item.resolved_aice_id,
        item.resolved_event_key,
      );
      const fetched = await fetchRedactedRow(
        customerClient,
        item.source_table,
        item.primary_key,
      );
      if (!fetched) {
        await customerClient.query("ROLLBACK");
        action = { kind: "skipped", reason: "row_missing" };
      } else if (fetched.policyVersion === targetPolicyVersion) {
        await customerClient.query("ROLLBACK");
        customerCompleted = true;
        action = { kind: "done" };
      } else {
        const existing = await readMap(
          customerClient,
          job.customer_id,
          item.resolved_aice_id,
          item.resolved_event_key,
        );
        const map = existing ?? {};

        const missing = new Set<string>();
        const reconstructed = substituteTokens(fetched.redacted, map, missing);

        // For event_analysis_result, the analysis_text is LLM-produced
        // and may legitimately reference tokens that have no map entry
        // (hallucinations); leaving the literal token in place is the
        // documented behaviour. For the four ingestion tables a missing
        // token is an invariant violation, audited via the shared
        // redaction.injectivity_violation action so operators can locate
        // the failing event without grepping per-item error_code values.
        if (missing.size > 0 && item.source_table !== "event_analysis_result") {
          await customerClient.query("ROLLBACK");
          action = {
            kind: "failed",
            reason: "missing_token",
            injectivity: { missing: [...missing] },
          };
        } else {
          const out = redact({
            payload: reconstructed,
            existingMap: map,
            ranges,
            // Thread the customer's current owned domains so a payload
            // carrying a `<<REDACTED_DOMAIN_NNN>>` token round-trips
            // cleanly: substituteTokens restores it to plaintext and
            // this re-redact re-tokenises it via the existing map.
            // Without it the restored domain plaintext would leak back
            // into the stored payload (RFC 0001 Amendment A.2).
            ownedDomains,
            engineVersion: ENGINE_VERSION,
          });

          const updated = await updateRedactedRow(
            customerClient,
            item.source_table,
            item.primary_key,
            out.redacted as Record<string, unknown>,
            targetPolicyVersion,
          );

          if (updated === 0) {
            // The referent row was deleted (e.g. retention or cascade
            // delete) between our fetch and update inside the same
            // customer-db transaction. The per-event advisory lock
            // serializes against live ingest, not against deletes from
            // other paths. Treat this as `row_missing` skipped so we do
            // not recreate / overwrite an event_redaction_map row for a
            // referent that no longer exists.
            await customerClient.query("ROLLBACK");
            action = { kind: "skipped", reason: "row_missing" };
          } else {
            if (existing === null || out.mapChanged) {
              await upsertMap(
                customerClient,
                job.customer_id,
                item.resolved_aice_id,
                item.resolved_event_key,
                out.mergedMap,
              );
            }

            await customerClient.query("COMMIT");
            customerCompleted = true;
            action = { kind: "done" };
          }
        }
      }
    } catch (err) {
      await customerClient.query("ROLLBACK").catch(() => {});
      // Pre-commit failure inside the customer-db transaction.
      // `customerCompleted` cannot be true here — the only paths that
      // set it (COMMIT or the idempotency short-circuit) both write
      // `action` before this catch can fire.
      //
      // The auth-side `markItem('failed')` write must succeed before
      // the batch loop bumps the `failed` counter — otherwise a
      // transient auth-db blip would advance `redaction_jobs.failed_rows`
      // ahead of the durable `redaction_job_items.status` and could
      // trip the failure threshold on attempts that aren't reflected
      // in the work list. If the mark fails, return "deferred" so the
      // counter stays put and the item is retried on the next pass.
      const code = err instanceof Error ? err.message.slice(0, 200) : "error";
      try {
        await markItem(authClient, job.id, item.seq, "failed", code);
        return "failed";
      } catch (markErr) {
        console.error(
          "[redaction-job] markItem('failed') after customer-db error failed; leaving item pending for retry:",
          markErr,
        );
        return "deferred";
      }
    }

    // Customer-db side resolved; now apply the auth-side mark. A failure
    // of the mark write — for any action kind — must leave the item
    // pending and return "deferred", not bump a counter and not fail
    // the whole job:
    //   - kind='done':    customer-db committed; next pass hits the
    //                     idempotency short-circuit and marks done.
    //   - kind='failed':  customer-db rolled back; next pass re-runs
    //                     the per-item flow and retries the mark.
    //   - kind='skipped': customer-db rolled back; next pass re-runs
    //                     the row-missing check and retries the mark.
    // Bubbling the auth-db failure up to runJobInner would convert a
    // transient blip while writing a per-row mark into a job-wide
    // `retroactive_failed` — even though no item status was durably
    // recorded.
    try {
      if (action.kind === "skipped") {
        await markItem(authClient, job.id, item.seq, "skipped", action.reason);
        return "skipped";
      }
      if (action.kind === "failed") {
        await markItem(authClient, job.id, item.seq, "failed", action.reason);
        if (action.injectivity) {
          const missingTokens = action.injectivity.missing;
          await auditLog({
            actorId: SYSTEM_ACTOR,
            action: "redaction.injectivity_violation",
            targetType: "customer",
            targetId: job.customer_id,
            customerId: job.customer_id,
            aiceId: item.resolved_aice_id,
            details: {
              customerId: job.customer_id,
              jobId: job.id,
              sourceTable: item.source_table,
              primaryKey: item.primary_key,
              aiceId: item.resolved_aice_id,
              eventKey: item.resolved_event_key,
              missingTokens,
              reason: "missing_token",
            },
          }).catch((err) => {
            console.error(
              "[redaction-job] injectivity_violation audit failed:",
              err,
            );
          });
        }
        return "failed";
      }
      await markItem(authClient, job.id, item.seq, "done");
      return "done";
    } catch (markErr) {
      // `customerCompleted` is true only for the kind='done' path; for
      // the rolled-back kind='failed' / kind='skipped' paths it stays
      // false but the item is still safe to retry (the customer-db
      // transaction left no side effect). Either way: leave pending,
      // defer the counter bump to the next pass.
      console.error(
        `[redaction-job] markItem('${action.kind}') failed (customerCompleted=${customerCompleted}); leaving item pending for retry:`,
        markErr,
      );
      return "deferred";
    }
  } finally {
    customerClient.release();
  }
}

async function markItem(
  authClient: PoolClient,
  jobId: string,
  seq: string,
  status: "done" | "failed" | "skipped",
  errorCode?: string,
): Promise<void> {
  await authClient.query(
    `UPDATE redaction_job_items
        SET status = $1,
            error_code = $2,
            processed_at = NOW()
      WHERE job_id = $3 AND seq = $4`,
    [status, errorCode ?? null, jobId, seq],
  );
}

async function countSkippedItems(
  authClient: PoolClient,
  jobId: string,
): Promise<number> {
  // Skipped items are durable in `redaction_job_items.status='skipped'`,
  // but the in-process `skipped` counter only sees rows skipped in the
  // current worker run. Reading from the table at finalize time keeps
  // the completed/cancelled audit's `skippedRows` correct across
  // crash/recovery boundaries.
  const { rows } = await authClient.query<{ n: string }>(
    `SELECT COUNT(*)::text AS n
       FROM redaction_job_items
      WHERE job_id = $1 AND status = 'skipped'`,
    [jobId],
  );
  return rows[0] ? Number(rows[0].n) : 0;
}

async function loadJob(
  authClient: PoolClient,
  jobId: string,
): Promise<JobRow | null> {
  const { rows } = await authClient.query<RawJobRow>(
    `SELECT id, customer_id, status, target_policy_version,
            total_rows, processed_rows, failed_rows,
            running_started_at, started_at,
            range_snapshot, range_snapshot_ranges_hash, triggered_by,
            cancelled_by, cancellation_reason
       FROM redaction_jobs WHERE id = $1`,
    [jobId],
  );
  return rows[0] ? normaliseJobRow(rows[0]) : null;
}

async function processJobItems(
  authClient: PoolClient,
  job: JobRow,
  ranges: RangeSet,
  ownedDomains: OwnedDomainSet,
  deps: WorkerDeps,
): Promise<ProcessOutcome> {
  let processed = job.processed_rows;
  let failed = job.failed_rows;
  // `skipped` only tracks rows skipped in *this* worker run. The durable
  // count is read from redaction_job_items.status='skipped' when the
  // outcome is finalized so a crash/recovery does not drop skipped rows
  // from earlier runs out of the completed/cancelled audit details.
  let skipped = 0;

  while (true) {
    // Check cancellation BEFORE selecting the next batch. The previous
    // iteration's bottom-of-loop check can pass (status='running') and
    // then a DELETE can land before the next SELECT; without this top
    // check the worker would process a full additional batch beyond the
    // documented "next batch checkpoint" boundary.
    const preBatch = await loadJob(authClient, job.id);
    if (preBatch?.status === "cancelled") {
      return {
        status: "cancelled",
        processedRows: processed,
        failedRows: failed,
        skippedRows: skipped,
      };
    }

    const { rows } = await authClient.query<JobItem>(
      `SELECT job_id, seq::text AS seq, source_table, primary_key,
              resolved_aice_id, resolved_event_key::text AS resolved_event_key,
              status
         FROM redaction_job_items
        WHERE job_id = $1 AND status = 'pending'
        ORDER BY seq
        LIMIT $2`,
      [job.id, BATCH_SIZE],
    );
    if (rows.length === 0) break;

    for (const item of rows) {
      // Read-site validation: a malformed `primary_key` JSONB must fail
      // loudly with the source_table / seq surfaced, rather than
      // silently propagating `undefined` into the table-specific casts.
      try {
        item.primary_key = validatePrimaryKey(
          item.source_table,
          item.primary_key,
        );
      } catch (err) {
        const code =
          err instanceof PrimaryKeyShapeError
            ? err.message.slice(0, 200)
            : "primary_key_invalid";
        // The auth-side mark must succeed before the counter is bumped
        // — otherwise a transient auth-db error could advance
        // `failed_rows` ahead of the durable `redaction_job_items.status`
        // and trip the failure threshold on attempts that aren't
        // reflected in the work list. If the mark fails, leave the item
        // pending without bumping the counter; the next pass will
        // re-validate and try the mark again.
        try {
          await markItem(authClient, job.id, item.seq, "failed", code);
          failed += 1;
        } catch (markErr) {
          console.error(
            "[redaction-job] markItem('failed') for primary_key validation failed; leaving item pending for retry:",
            markErr,
          );
        }
        continue;
      }
      const result = await processItem(
        authClient,
        job,
        item,
        ranges,
        ownedDomains,
        job.target_policy_version,
        deps,
      );
      if (result === "done") processed += 1;
      else if (result === "failed") failed += 1;
      else if (result === "skipped") skipped += 1;
      // "deferred": customer-db side already consistent with "done" but
      // the auth-side mark failed. Item stays pending and is replayed on
      // the next pass via the idempotency short-circuit — no counter
      // bump this batch to avoid double-counting.
    }

    // Checkpoint counters + check cancellation / failure-threshold.
    await authClient.query(
      `UPDATE redaction_jobs
          SET processed_rows = $1,
              failed_rows = $2,
              last_progress_at = NOW()
        WHERE id = $3`,
      [processed, failed, job.id],
    );

    const total = job.total_rows ?? 0;
    if (total > 0 && failed / total > FAILURE_THRESHOLD) {
      return {
        status: "failed",
        processedRows: processed,
        failedRows: failed,
        skippedRows: skipped,
        errorMessage: "failure_threshold_exceeded",
      };
    }

    const refreshed = await loadJob(authClient, job.id);
    if (refreshed?.status === "cancelled") {
      return {
        status: "cancelled",
        processedRows: processed,
        failedRows: failed,
        skippedRows: skipped,
      };
    }
  }

  return {
    status: "completed",
    processedRows: processed,
    failedRows: failed,
    skippedRows: skipped,
  };
}

// ---------------------------------------------------------------------------
// Job pickup
// ---------------------------------------------------------------------------

async function tryStartQueuedJob(
  authClient: PoolClient,
): Promise<JobRow | null> {
  await authClient.query("BEGIN");
  // Track whether we acquired the session-scope advisory lock so the
  // error path can release it. Session-scope locks survive ROLLBACK,
  // so leaving the lock held would silently starve this customer's
  // queue on the next reuse of this pool connection.
  let lockedCustomerId: string | null = null;
  try {
    const { rows } = await authClient.query<RawJobRow>(
      `SELECT id, customer_id, status, target_policy_version,
              total_rows, processed_rows, failed_rows,
              running_started_at, started_at,
              range_snapshot, range_snapshot_ranges_hash, triggered_by,
              cancelled_by, cancellation_reason
         FROM redaction_jobs
        WHERE status = 'queued'
        ORDER BY started_at ASC
        LIMIT 1
        FOR UPDATE SKIP LOCKED`,
    );
    if (rows.length === 0) {
      await authClient.query("COMMIT");
      return null;
    }
    const job = normaliseJobRow(rows[0]);

    const lockRes = await authClient.query<{ locked: boolean }>(
      `SELECT pg_try_advisory_lock(
         hashtextextended('redaction_job:' || $1::text, 0)
       ) AS locked`,
      [job.customer_id],
    );
    if (!lockRes.rows[0]?.locked) {
      await authClient.query("ROLLBACK");
      return null;
    }
    lockedCustomerId = job.customer_id;

    // Serialize the entire candidate-set closure (hash check + customer-
    // table scan + queued→running flip) against `customer_redaction_ranges`
    // mutations. POST shares this same xact-scope key, and DELETE has
    // been updated to participate. Without this, a CIDR change after
    // the hash check but before the scans complete would let live
    // ingestion stamp rows with a new policy version that the still-
    // starting job then materializes and downgrades back to the frozen
    // target on the per-item UPDATE. Released on COMMIT/ROLLBACK below.
    await authClient.query("SELECT pg_advisory_xact_lock(hashtext($1))", [
      `redaction-ranges:${job.customer_id}`,
    ]);

    // Load current CIDRs from auth_db, build snapshot, validate hash
    // matches the target_policy_version captured at trigger time.
    const cidrsRes = await authClient.query<{ cidr: string }>(
      `SELECT cidr::text AS cidr
         FROM customer_redaction_ranges
        WHERE customer_id = $1`,
      [job.customer_id],
    );
    const { snapshot, hash } = snapshotFromCidrs(
      cidrsRes.rows.map((r) => r.cidr),
    );

    if (hash !== targetHashFragment(job.target_policy_version)) {
      // Policy drift in the trigger -> pickup gap. Fail the job.
      await authClient.query(
        `UPDATE redaction_jobs
            SET status = 'failed',
                error_message = 'policy_drift_between_trigger_and_start',
                completed_at = NOW(),
                running_started_at = NOW()
          WHERE id = $1`,
        [job.id],
      );
      await authClient.query("COMMIT");
      await releaseAdvisoryLock(authClient, job.customer_id);
      lockedCustomerId = null;
      await auditLog({
        actorId: SYSTEM_ACTOR,
        action: "customer_redaction_ranges.retroactive_failed",
        targetType: "customer",
        targetId: job.customer_id,
        customerId: job.customer_id,
        details: {
          customerId: job.customer_id,
          jobId: job.id,
          targetPolicyVersion: job.target_policy_version,
          processedRows: 0,
          failedRows: 0,
          errorCode: null,
          errorMessage: "policy_drift_between_trigger_and_start",
        },
      });
      return null;
    }

    // Materialize items via the customer pool — the per-row scan runs
    // against the customer DB. (Use a dedicated pool, not the per-item
    // client which lives on a separate connection per item.)
    const customerPool = getCustomerRuntimePool(job.customer_id);
    const total = await materializeJobItems(
      authClient,
      customerPool,
      job.id,
      job.target_policy_version,
    );

    await authClient.query(
      `UPDATE redaction_jobs
          SET status = 'running',
              running_started_at = NOW(),
              total_rows = $1,
              range_snapshot = $2::jsonb,
              range_snapshot_ranges_hash = $3
        WHERE id = $4`,
      [total, JSON.stringify(snapshot), hash, job.id],
    );

    await authClient.query("COMMIT");

    // Reload with the now-persisted snapshot fields.
    const reloaded = await loadJob(authClient, job.id);
    if (!reloaded) {
      await releaseAdvisoryLock(authClient, job.customer_id);
      lockedCustomerId = null;
      return null;
    }
    // Ownership of the lock passes to the caller, who must release it
    // when the job reaches a terminal state (runJob's finally).
    lockedCustomerId = null;
    // Emit `retroactive_started` here, on the queued -> running edge,
    // rather than from runJobInner. Recovery picks rows up in 'running'
    // and never goes through this path, so this is the only place where
    // a fresh start can be observed unambiguously. Inferring "fresh" from
    // processed_rows + failed_rows == 0 inside runJobInner duplicated the
    // audit when a crash happened after the first started audit but
    // before any counter checkpoint. A crash between this COMMIT and the
    // audit emit means we lose the started audit (audit-write failures
    // already had this risk); the trade-off is intentional — duplicates
    // are worse than gaps for an "X started" event.
    //
    // The audit emit is best-effort: ownership of the session-scope
    // advisory lock has already been transferred to the caller (line
    // above) so that `runJob`'s `finally` will release it when the job
    // reaches a terminal state. If the audit write throws here we still
    // need to return the reloaded job — letting the exception propagate
    // would skip the handoff, leave the lock held on the pooled client,
    // and strand the now-`running` job.
    if (reloaded.total_rows && reloaded.total_rows > 0) {
      await auditLog({
        actorId: SYSTEM_ACTOR,
        action: "customer_redaction_ranges.retroactive_started",
        targetType: "customer",
        targetId: reloaded.customer_id,
        customerId: reloaded.customer_id,
        details: {
          customerId: reloaded.customer_id,
          jobId: reloaded.id,
          targetPolicyVersion: reloaded.target_policy_version,
          totalRows: reloaded.total_rows,
          triggeredBy: reloaded.triggered_by,
        },
      }).catch((err) => {
        console.error("[redaction-job] retroactive_started audit failed:", err);
      });
    }
    return reloaded;
  } catch (err) {
    await authClient.query("ROLLBACK").catch(() => {});
    if (lockedCustomerId) {
      await releaseAdvisoryLock(authClient, lockedCustomerId);
    }
    throw err;
  }
}

async function releaseAdvisoryLock(
  authClient: PoolClient,
  customerId: string,
): Promise<void> {
  await authClient
    .query(
      `SELECT pg_advisory_unlock(
         hashtextextended('redaction_job:' || $1::text, 0)
       )`,
      [customerId],
    )
    .catch(() => {});
}

interface FinalizeResult {
  status: "completed" | "failed" | "cancelled";
  // The DB-written `completed_at` for the terminal row. The audit's
  // `durationMs` is computed from this rather than `Date.now()` so the
  // audit value matches the row's persisted timestamp under any DB/app
  // clock skew and regardless of how long the audit hop takes after the
  // terminal UPDATE.
  completedAt: Date | null;
}

async function finalizeJob(
  authClient: PoolClient,
  job: JobRow,
  outcome: ProcessOutcome,
): Promise<FinalizeResult> {
  if (outcome.status === "cancelled") {
    // Cancellation already wrote status/cancelled_by and completed_at
    // (DELETE endpoint); just push final counters and return the
    // DELETE-written completed_at.
    const res = await authClient.query<{ completed_at: Date | null }>(
      `UPDATE redaction_jobs
          SET processed_rows = $1,
              failed_rows = $2,
              last_progress_at = NOW()
        WHERE id = $3
        RETURNING completed_at`,
      [outcome.processedRows, outcome.failedRows, job.id],
    );
    return {
      status: "cancelled",
      completedAt: res.rows[0]?.completed_at ?? null,
    };
  }
  // Flip running -> completed/failed only if the row is still running. A
  // DELETE landing in the gap between processJobItems' last cancellation
  // check and this UPDATE will have flipped status to 'cancelled'; an
  // unconditional UPDATE here would overwrite the cancellation with
  // completed/failed and emit the wrong audit. If the conditional
  // UPDATE matches zero rows, the row was cancelled concurrently —
  // push the final counters without touching status and report that
  // back so runJobInner emits the cancellation audit.
  const errorMessage =
    outcome.status === "failed" ? (outcome.errorMessage ?? "failed") : null;
  const result = await authClient.query<{ completed_at: Date | null }>(
    `UPDATE redaction_jobs
        SET status = $1,
            processed_rows = $2,
            failed_rows = $3,
            error_message = $4,
            completed_at = NOW(),
            last_progress_at = NOW()
      WHERE id = $5 AND status = 'running'
      RETURNING completed_at`,
    [
      outcome.status,
      outcome.processedRows,
      outcome.failedRows,
      errorMessage,
      job.id,
    ],
  );
  if ((result.rowCount ?? 0) === 0) {
    const fallback = await authClient.query<{ completed_at: Date | null }>(
      `UPDATE redaction_jobs
          SET processed_rows = $1,
              failed_rows = $2,
              last_progress_at = NOW()
        WHERE id = $3
        RETURNING completed_at`,
      [outcome.processedRows, outcome.failedRows, job.id],
    );
    return {
      status: "cancelled",
      completedAt: fallback.rows[0]?.completed_at ?? null,
    };
  }
  return {
    status: outcome.status,
    completedAt: result.rows[0]?.completed_at ?? null,
  };
}

async function runJob(
  authClient: PoolClient,
  job: JobRow,
  deps: WorkerDeps,
): Promise<void> {
  // The advisory lock is held on `authClient`'s underlying session.
  // It MUST be released before the client returns to the pool, or the
  // next reuse of that connection will silently keep the lock and
  // starve this customer's queue. Wrap the whole body so unexpected
  // throws (auditLog, finalizeJob, etc.) still release the lock.
  try {
    await runJobInner(authClient, job, deps);
  } finally {
    await releaseAdvisoryLock(authClient, job.customer_id);
  }
}

async function runJobInner(
  authClient: PoolClient,
  job: JobRow,
  deps: WorkerDeps,
): Promise<void> {
  let ranges: RangeSet;
  try {
    ranges = validateRangeSnapshot(job);
  } catch (err) {
    const code =
      err instanceof SnapshotError ? err.code : "range_snapshot_error";
    // Gate the terminal flip on `status = 'running'` so a DELETE landing
    // between recovery/poll loading the running row and validateRangeSnapshot
    // throwing cannot be overwritten with `failed`. When the conditional
    // UPDATE matches zero rows the job was cancelled concurrently; re-load
    // it to read cancelled_by / cancellation_reason and emit
    // `retroactive_cancelled` instead, matching the empty-pending-batch and
    // zero-row completion paths.
    const res = await authClient.query<{ completed_at: Date | null }>(
      `UPDATE redaction_jobs
          SET status = 'failed',
              error_message = $1,
              completed_at = NOW()
        WHERE id = $2 AND status = 'running'
        RETURNING completed_at`,
      [code, job.id],
    );
    if ((res.rowCount ?? 0) === 0) {
      const cancelled = await authClient.query<{
        completed_at: Date | null;
        cancelled_by: string | null;
        cancellation_reason: string | null;
      }>(
        `SELECT completed_at, cancelled_by, cancellation_reason
           FROM redaction_jobs WHERE id = $1`,
        [job.id],
      );
      const refreshed = cancelled.rows[0];
      const completedAt = refreshed?.completed_at ?? null;
      const skippedRows = await countSkippedItems(authClient, job.id);
      await auditLog({
        actorId: SYSTEM_ACTOR,
        action: "customer_redaction_ranges.retroactive_cancelled",
        targetType: "customer",
        targetId: job.customer_id,
        customerId: job.customer_id,
        details: {
          customerId: job.customer_id,
          jobId: job.id,
          targetPolicyVersion: job.target_policy_version,
          processedRows: job.processed_rows,
          failedRows: job.failed_rows,
          skippedRows,
          cancelledBy: refreshed?.cancelled_by ?? null,
          cancellationReason: refreshed?.cancellation_reason ?? null,
          durationMs: durationFromTimestamps(
            job.running_started_at,
            completedAt,
          ),
        },
      });
      return;
    }
    await auditLog({
      actorId: SYSTEM_ACTOR,
      action: "customer_redaction_ranges.retroactive_failed",
      targetType: "customer",
      targetId: job.customer_id,
      customerId: job.customer_id,
      details: {
        customerId: job.customer_id,
        jobId: job.id,
        targetPolicyVersion: job.target_policy_version,
        processedRows: job.processed_rows,
        failedRows: job.failed_rows,
        errorCode: code,
        errorMessage: code,
      },
    });
    return;
  }

  if ((job.total_rows ?? 0) === 0) {
    // Gate the terminal flip on `status = 'running'` so a DELETE landing
    // in the gap between tryStartQueuedJob's queued→running commit and
    // this UPDATE cannot be overwritten with `completed`. When the
    // conditional UPDATE matches zero rows the job was cancelled
    // concurrently; re-load it to read cancelled_by / cancellation_reason
    // and emit `retroactive_cancelled` with the persisted completed_at,
    // matching the empty-pending-batch finalizeJob path.
    const res = await authClient.query<{ completed_at: Date | null }>(
      `UPDATE redaction_jobs
          SET status = 'completed',
              completed_at = NOW(),
              last_progress_at = NOW()
        WHERE id = $1 AND status = 'running'
        RETURNING completed_at`,
      [job.id],
    );
    if ((res.rowCount ?? 0) === 0) {
      const cancelled = await authClient.query<{
        completed_at: Date | null;
        cancelled_by: string | null;
        cancellation_reason: string | null;
      }>(
        `SELECT completed_at, cancelled_by, cancellation_reason
           FROM redaction_jobs WHERE id = $1`,
        [job.id],
      );
      const refreshed = cancelled.rows[0];
      const completedAt = refreshed?.completed_at ?? null;
      await auditLog({
        actorId: SYSTEM_ACTOR,
        action: "customer_redaction_ranges.retroactive_cancelled",
        targetType: "customer",
        targetId: job.customer_id,
        customerId: job.customer_id,
        details: {
          customerId: job.customer_id,
          jobId: job.id,
          targetPolicyVersion: job.target_policy_version,
          processedRows: 0,
          failedRows: 0,
          skippedRows: 0,
          cancelledBy: refreshed?.cancelled_by ?? null,
          cancellationReason: refreshed?.cancellation_reason ?? null,
          durationMs: durationFromTimestamps(
            job.running_started_at,
            completedAt,
          ),
        },
      });
      return;
    }
    const completedAt = res.rows[0]?.completed_at ?? null;
    await auditLog({
      actorId: SYSTEM_ACTOR,
      action: "customer_redaction_ranges.retroactive_completed",
      targetType: "customer",
      targetId: job.customer_id,
      customerId: job.customer_id,
      details: {
        customerId: job.customer_id,
        jobId: job.id,
        targetPolicyVersion: job.target_policy_version,
        processedRows: 0,
        failedRows: 0,
        skippedRows: 0,
        durationMs: durationFromTimestamps(job.running_started_at, completedAt),
      },
    });
    return;
  }

  // `retroactive_started` is emitted in `tryStartQueuedJob` on the
  // queued -> running edge. Recovery enters here with `status='running'`
  // and must not emit a duplicate started audit — counters are not a
  // reliable "fresh start" indicator because a crash after the started
  // emit but before the first counter checkpoint would re-fire the audit
  // on the next recovery pass.

  // Load the customer's current owned domains so re-redacted rows that
  // carry a `<<REDACTED_DOMAIN_NNN>>` token round-trip via the existing
  // map (RFC 0001 Amendment A.2). The retroactive job is range-keyed;
  // domains are not part of snapshot validation (pre-release §A.4), but
  // they must be threaded so restored domain plaintext does not leak
  // back into the stored payload.
  const ownedDomainsRes = await authClient.query<{
    owned_domain_suffix: string;
  }>(
    `SELECT owned_domain_suffix
       FROM customer_owned_domains
      WHERE customer_id = $1`,
    [job.customer_id],
  );
  const ownedDomains = buildOwnedDomainSet(
    ownedDomainsRes.rows.map((r) => r.owned_domain_suffix),
  );

  let outcome: ProcessOutcome;
  try {
    outcome = await processJobItems(
      authClient,
      job,
      ranges,
      ownedDomains,
      deps,
    );
  } catch (err) {
    // The catch path must reflect counters that were already
    // checkpointed by processJobItems' batch loop, not the stale
    // job.processed_rows / job.failed_rows captured at runJob entry.
    // Otherwise finalizeJob writes the stale values back and the
    // failed audit reports counters below the durable per-item statuses.
    const refreshed = await loadJob(authClient, job.id);
    outcome = {
      status: "failed",
      processedRows: refreshed?.processed_rows ?? job.processed_rows,
      failedRows: refreshed?.failed_rows ?? job.failed_rows,
      skippedRows: await countSkippedItems(authClient, job.id),
      errorMessage: err instanceof Error ? err.message : String(err),
    };
  }

  const { status: effectiveStatus, completedAt } = await finalizeJob(
    authClient,
    job,
    outcome,
  );
  const durationMs = durationFromTimestamps(
    job.running_started_at,
    completedAt,
  );

  if (effectiveStatus === "completed") {
    // Use the durable skipped count from redaction_job_items so a
    // crash/recovery does not lose skipped rows from earlier runs out
    // of the final audit details.
    const skippedRows = await countSkippedItems(authClient, job.id);
    await auditLog({
      actorId: SYSTEM_ACTOR,
      action: "customer_redaction_ranges.retroactive_completed",
      targetType: "customer",
      targetId: job.customer_id,
      customerId: job.customer_id,
      details: {
        customerId: job.customer_id,
        jobId: job.id,
        targetPolicyVersion: job.target_policy_version,
        processedRows: outcome.processedRows,
        failedRows: outcome.failedRows,
        skippedRows,
        durationMs,
      },
    });
  } else if (effectiveStatus === "failed") {
    await auditLog({
      actorId: SYSTEM_ACTOR,
      action: "customer_redaction_ranges.retroactive_failed",
      targetType: "customer",
      targetId: job.customer_id,
      customerId: job.customer_id,
      details: {
        customerId: job.customer_id,
        jobId: job.id,
        targetPolicyVersion: job.target_policy_version,
        processedRows: outcome.processedRows,
        failedRows: outcome.failedRows,
        errorCode: null,
        errorMessage: outcome.errorMessage ?? "failed",
      },
    });
  } else if (effectiveStatus === "cancelled") {
    // The DELETE endpoint flips status -> 'cancelled' and writes
    // cancelled_by/cancellation_reason, but only emits the audit when
    // the prior status was 'queued' (where no worker observes the
    // cancellation). For a running job, the worker emits the audit
    // here, after the final checkpoint, so processedRows / failedRows
    // in the audit reflect the row's final counters — not the stale
    // values readable at DELETE time.
    const refreshed = await loadJob(authClient, job.id);
    const skippedRows = await countSkippedItems(authClient, job.id);
    await auditLog({
      actorId: SYSTEM_ACTOR,
      action: "customer_redaction_ranges.retroactive_cancelled",
      targetType: "customer",
      targetId: job.customer_id,
      customerId: job.customer_id,
      details: {
        customerId: job.customer_id,
        jobId: job.id,
        targetPolicyVersion: job.target_policy_version,
        processedRows: outcome.processedRows,
        failedRows: outcome.failedRows,
        skippedRows,
        cancelledBy: refreshed?.cancelled_by ?? null,
        cancellationReason: refreshed?.cancellation_reason ?? null,
        durationMs,
      },
    });
  }
}

// ---------------------------------------------------------------------------
// Recovery scan
// ---------------------------------------------------------------------------

async function runRecovery(deps: WorkerDeps): Promise<void> {
  const { rows } = await deps.authPool.query<{
    id: string;
    customer_id: string;
  }>(
    `SELECT id, customer_id FROM redaction_jobs
      WHERE status = 'running'
      ORDER BY started_at ASC`,
  );
  for (const candidate of rows) {
    const authClient = await deps.acquireAuthClient();
    // Session-scope advisory locks survive `authClient.release()` —
    // releasing the client back to the pool with a held lock would
    // permanently starve this customer's queue until the connection
    // recycles. Track the lock explicitly so the finally can release
    // it on any unexpected throw (loadJob, runJob, etc.).
    let locked = false;
    try {
      const lockRes = await authClient.query<{ locked: boolean }>(
        `SELECT pg_try_advisory_lock(
           hashtextextended('redaction_job:' || $1::text, 0)
         ) AS locked`,
        [candidate.customer_id],
      );
      if (!lockRes.rows[0]?.locked) continue;
      locked = true;
      const job = await loadJob(authClient, candidate.id);
      if (job?.status !== "running") continue;
      // runJob's own `finally` releases the lock on success or throw.
      await runJob(authClient, job, deps);
      locked = false;
    } catch (err) {
      console.error("[redaction-job] recovery failed for job:", err);
    } finally {
      if (locked) {
        await releaseAdvisoryLock(authClient, candidate.customer_id);
      }
      authClient.release();
    }
  }
}

// ---------------------------------------------------------------------------
// Polling loop
// ---------------------------------------------------------------------------

async function pollOnce(deps: WorkerDeps): Promise<void> {
  const authClient = await deps.acquireAuthClient();
  try {
    const job = await tryStartQueuedJob(authClient);
    if (!job) return;
    await runJob(authClient, job, deps);
  } finally {
    authClient.release();
  }
}

// ---------------------------------------------------------------------------
// Public entrypoint — exported for tests
// ---------------------------------------------------------------------------

export async function runOnceForTests(deps?: WorkerDeps): Promise<void> {
  const resolved = deps ?? defaultDeps();
  await runRecovery(resolved);
  await pollOnce(resolved);
}

export const __testables = {
  substituteTokens,
  shortRangesHash,
  snapshotFromCidrs,
  targetHashFragment,
  validateRangeSnapshot,
  rowToCandidate,
  normaliseJobRow,
  validatePrimaryKey,
  SnapshotError,
};

// ---------------------------------------------------------------------------
// Installer
// ---------------------------------------------------------------------------

const WORKER_SLOT = Symbol.for("aimer.redaction.jobWorker");

interface WorkerSlot {
  timer: NodeJS.Timeout | null;
  inFlight: boolean;
  installing: Promise<void> | null;
}

type GlobalWithWorkerSlot = typeof globalThis & {
  [WORKER_SLOT]?: WorkerSlot;
};

function getSlot(): WorkerSlot {
  const g = globalThis as GlobalWithWorkerSlot;
  let slot = g[WORKER_SLOT];
  if (!slot) {
    slot = { timer: null, inFlight: false, installing: null };
    g[WORKER_SLOT] = slot;
  }
  return slot;
}

export async function installRedactionJobWorker(
  deps?: WorkerDeps,
): Promise<void> {
  const slot = getSlot();
  // Idempotency: the timer guard alone is not enough because the
  // recovery scan runs before the timer is assigned. Two concurrent
  // calls (e.g. overlapping HMR reloads) could both observe
  // `slot.timer === null` and race past `await runRecovery`, each
  // registering its own interval. `slot.installing` is set
  // synchronously before the first await so a second concurrent call
  // awaits the same in-flight install instead of starting a new one.
  if (slot.timer) return;
  if (slot.installing) {
    await slot.installing;
    return;
  }
  const resolved = deps ?? defaultDeps();
  const installRun = (async () => {
    // Startup recovery scan before entering the polling loop.
    await runRecovery(resolved).catch((err) => {
      console.error("[redaction-job] recovery failed:", err);
    });

    // Skip the tick if a prior pollOnce is still mid-flight. Without
    // this guard, a single job that runs longer than POLL_INTERVAL_MS
    // would cause overlapping ticks to each acquire a fresh authClient
    // (and an unbounded number of them under load). The SKIP LOCKED
    // dequeue already prevents duplicate work on the same row, but the
    // wasted connections are still worth avoiding.
    const tick = () => {
      if (slot.inFlight) return;
      slot.inFlight = true;
      pollOnce(resolved)
        .catch((err) => {
          console.error("[redaction-job] poll failed:", err);
        })
        .finally(() => {
          slot.inFlight = false;
        });
    };
    slot.timer = setInterval(tick, POLL_INTERVAL_MS);
    if (typeof slot.timer.unref === "function") slot.timer.unref();
  })();
  slot.installing = installRun;
  try {
    await installRun;
  } finally {
    slot.installing = null;
  }
}

export function uninstallRedactionJobWorker(): void {
  const slot = getSlot();
  if (slot.timer) {
    clearInterval(slot.timer);
    slot.timer = null;
  }
}
