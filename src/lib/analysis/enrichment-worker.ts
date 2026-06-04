// RFC 0003 P1a (#361) — async IOC enrichment worker.
//
// For a story's canonical version, the worker:
//   1. extracts + normalizes indicators from the stored, already-redacted
//      member rows — both the `story_member.event` JSONB and the discrete
//      `policy_event` columns (`orig_addr`/`resp_addr`/`host`/`dns_query`/
//      `uri`) for the same event_key, which are redacted independently at
//      ingest but share the same event_redaction_map row — recovering
//      tokenized customer-asset IPs via that map,
//   2. dispatches each through the Tier-1 local-feed dispatcher (#427),
//   3. derives `known_ioc_hit` = OR over members of any match where
//      `matchSatisfiesFloor` (deterministic_ioc && floorEligible; non-public
//      IPs already forced ineligible),
//   4. UPDATEs `story.known_ioc_hit` for the canonical version (monotonic —
//      an unavailable source never flips a hit to false),
//   5. persists one evidence record per floor-supporting match,
//   6. writes the per-story `story_enrichment_state` completion marker with
//      `coverage_status` (never a silent `false` — stale/unavailable feeds
//      yield `unknown`/`stale`), written even on zero matches so
//      `false-complete` is distinguishable from `false-unknown`.
//
// The completion marker is what the story-analysis worker's precondition
// (story-worker.ts) requeues against, so analysis never reads a stale floor.
// This worker runs asynchronously after ingest and never gates raw ingest.

import "server-only";

import type { Pool } from "pg";
import { getCustomerRuntimePool } from "@/lib/db/customer-runtime-pool";
import { decryptRedactionMap } from "@/lib/redaction/envelope-adapter";
import type { RedactionMap } from "@/lib/redaction/types";
import type { EnrichmentDispatcher } from "./enrichment/dispatcher";
import {
  buildEvidenceRecord,
  type EvidenceRecord,
  HmacKeyRing,
} from "./enrichment/evidence";
import { PgFeedStore } from "./enrichment/feed-store";
import {
  extractIndicators,
  type RecoverToken,
} from "./enrichment/indicator-extraction";
import { buildLocalFeedDispatcher } from "./enrichment/local-feed-enricher";
import { matchSatisfiesFloor } from "./enrichment/source-policy";
import type { CoverageStatus } from "./enrichment/types";

// ---------------------------------------------------------------------------
// Evidence HMAC key ring
// ---------------------------------------------------------------------------

// The key ring is injected (in-memory / config) per RFC 0003 — persisting
// and rotating keys via OpenBao is the separate HMAC-key-management
// follow-up. Evidence still stamps `hmacKeyVersion` and verifies across
// versions. Production must supply `IOC_EVIDENCE_HMAC_KEY` (+ optional
// `_VERSION`); a dev/test fallback keeps local runs working.
let cachedKeyRing: HmacKeyRing | undefined;

export function getEvidenceKeyRing(): HmacKeyRing {
  if (cachedKeyRing) return cachedKeyRing;
  const version = process.env.IOC_EVIDENCE_HMAC_KEY_VERSION ?? "v1";
  const key = process.env.IOC_EVIDENCE_HMAC_KEY;
  if (!key) {
    // Fail closed in production. The evidence table deliberately stores
    // only the keyed HMAC of each indicator — raw IP/domain/URL/hash
    // values are sensitive and often dictionaryable, so a public default
    // key would let any DB reader recompute likely plaintext and undo
    // that privacy property. Refuse to write evidence without a real key
    // configured; the dev fallback is for local/test only.
    if (process.env.NODE_ENV === "production") {
      throw new Error(
        "IOC_EVIDENCE_HMAC_KEY must be set in production: refusing to write " +
          "IOC evidence with a public default HMAC key.",
      );
    }
    cachedKeyRing = new HmacKeyRing(
      { [version]: "dev-insecure-ioc-evidence-hmac-key" },
      version,
    );
    return cachedKeyRing;
  }
  cachedKeyRing = new HmacKeyRing({ [version]: key }, version);
  return cachedKeyRing;
}

// ---------------------------------------------------------------------------
// Coverage aggregation
// ---------------------------------------------------------------------------

const COVERAGE_RANK: Record<CoverageStatus, number> = {
  complete: 0,
  partial: 1,
  stale: 2,
  unknown: 3,
};

/** Most-severe-wins across per-indicator coverage statuses. */
function worseCoverage(a: CoverageStatus, b: CoverageStatus): CoverageStatus {
  return COVERAGE_RANK[a] >= COVERAGE_RANK[b] ? a : b;
}

// ---------------------------------------------------------------------------
// Customer-DB reads
// ---------------------------------------------------------------------------

interface CanonicalVersion {
  storyVersion: string;
  sourceAiceId: string;
}

interface MemberEventRow {
  member_event_key: string;
  event: unknown;
}

/**
 * The canonical story version (latest by `received_at`, `story_version`
 * DESC tie-break) — identical selection to `loadCanonicalMembers` in the
 * story worker so the enrichment marker and the floor read agree on which
 * version they describe.
 */
async function loadCanonicalVersion(
  customerPool: Pool,
  storyId: string,
): Promise<CanonicalVersion | null> {
  const { rows } = await customerPool.query<{
    story_version: string;
    source_aice_id: string;
  }>(
    `SELECT story_version, source_aice_id
       FROM story
      WHERE story_id = $1::bigint
      ORDER BY received_at DESC, story_version DESC
      LIMIT 1`,
    [storyId],
  );
  if (rows.length === 0) return null;
  return {
    storyVersion: rows[0].story_version,
    sourceAiceId: rows[0].source_aice_id,
  };
}

async function loadMembers(
  customerPool: Pool,
  storyId: string,
  storyVersion: string,
): Promise<MemberEventRow[]> {
  const { rows } = await customerPool.query<MemberEventRow>(
    `SELECT member_event_key::text AS member_event_key, event
       FROM story_member
      WHERE story_id = $1::bigint AND story_version = $2
      ORDER BY member_event_key`,
    [storyId, storyVersion],
  );
  return rows;
}

interface PolicyEventFields {
  orig_addr: string | null;
  resp_addr: string | null;
  host: string | null;
  dns_query: string | null;
  uri: string | null;
}

/**
 * The discrete, redacted `policy_event` columns for a member's event_key.
 * These are separate storage from `story_member.event` (redacted
 * independently at ingest, per RFC 0003 §3) and can carry an indicator
 * absent from the member JSONB, so enrichment must read both. After
 * redaction the address columns are TEXT holding either a raw external IP
 * or a `<<REDACTED_IP_n>>` token (recovered via the same
 * event_redaction_map row as the member text).
 *
 * The logical event identity in this schema is `(source_aice_id,
 * event_key)`, NOT `event_key` alone — `event_key` recurs across AICE
 * sources and runs, and `policy_event` only carries `source_aice_id`
 * through its `policy_run`. So this MUST join `policy_run` and scope to the
 * canonical story's `source_aice_id`; an `event_key`-only read would let a
 * different source's `policy_event` row flip `known_ioc_hit` for the wrong
 * story. As with `baseline_event` (0002 lines 21-25), a source+event may
 * have multiple runs, so `DISTINCT ON (event_key)` keeps the latest by
 * `policy_run.received_at` (the project's "latest by received_at" dedupe).
 * Token recovery already uses `canonical.sourceAiceId`, so this also keeps
 * the typed-column read consistent with the redaction-map lookup.
 */
async function loadPolicyEventFields(
  customerPool: Pool,
  sourceAiceId: string,
  eventKey: string,
): Promise<PolicyEventFields[]> {
  const { rows } = await customerPool.query<PolicyEventFields>(
    `SELECT DISTINCT ON (pe.event_key)
            pe.orig_addr, pe.resp_addr, pe.host, pe.dns_query, pe.uri
       FROM policy_event pe
       JOIN policy_run pr ON pr.run_id = pe.run_id
      WHERE pe.event_key = $1::numeric
        AND pr.source_aice_id = $2
      ORDER BY pe.event_key, pr.received_at DESC`,
    [eventKey, sourceAiceId],
  );
  return rows;
}

/** Read + decrypt the event redaction map (no advisory lock — read-only). */
export type LoadRedactionMap = (
  customerPool: Pool,
  customerId: string,
  aiceId: string,
  eventKey: string,
) => Promise<RedactionMap | null>;

const defaultLoadRedactionMap: LoadRedactionMap = async (
  customerPool,
  customerId,
  aiceId,
  eventKey,
) => {
  const { rows } = await customerPool.query<{
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
};

/**
 * Build a token-recovery closure for one member's event_key. The redaction
 * map is only loaded + decrypted when `content` (the combined member JSONB
 * + policy_event columns) actually contains a token, so the common
 * (raw-only) path never touches the secret store.
 */
async function buildRecover(
  customerPool: Pool,
  customerId: string,
  aiceId: string,
  eventKey: string,
  content: unknown,
  loadMap: LoadRedactionMap,
): Promise<RecoverToken> {
  if (!JSON.stringify(content ?? null).includes("<<REDACTED_")) {
    return () => undefined;
  }
  const map = await loadMap(customerPool, customerId, aiceId, eventKey);
  if (!map) return () => undefined;
  return (token) => map[token];
}

// ---------------------------------------------------------------------------
// Enrichment of one canonical story version
// ---------------------------------------------------------------------------

export interface EnrichmentWorkerOptions {
  authPool: Pool;
  /** Override the customer-DB pool resolver — used by tests. */
  resolveCustomerPool?: (customerId: string) => Pool;
  /** Override the dispatcher builder — used by tests (in-memory feed store). */
  buildDispatcher?: (authPool: Pool, now: () => Date) => EnrichmentDispatcher;
  /** Override the evidence HMAC key ring — used by tests. */
  keyRing?: HmacKeyRing;
  /** Injectable clock for deterministic `checkedAt` / stale computation. */
  now?: () => Date;
  /** Override redaction-map recovery — used by tests (no OpenBao). */
  loadRedactionMap?: LoadRedactionMap;
}

export interface EnrichmentOutcome {
  status: "complete" | "skipped";
  knownIocHit: boolean;
  coverageStatus: CoverageStatus;
  evidenceCount: number;
  storyVersion?: string;
}

/**
 * Enrich one story's canonical version and persist the result. Idempotent:
 * the `known_ioc_hit` writes are monotonic OR, and re-running re-marks
 * state. Evidence is replaced only when the run produces supporting
 * matches, so a retained monotonic `true` never loses its explaining
 * evidence (see `persistEnrichment`).
 */
export async function runStoryEnrichment(
  customerId: string,
  storyId: string,
  opts: EnrichmentWorkerOptions,
): Promise<EnrichmentOutcome> {
  const customerPool = (opts.resolveCustomerPool ?? getCustomerRuntimePool)(
    customerId,
  );
  const now = opts.now ?? (() => new Date());
  const loadMap = opts.loadRedactionMap ?? defaultLoadRedactionMap;
  const buildDispatcher =
    opts.buildDispatcher ??
    ((authPool, clock) =>
      buildLocalFeedDispatcher(new PgFeedStore(authPool), { now: clock }));

  // The evidence HMAC key ring is resolved lazily — only when a
  // floor-supporting match actually needs an evidence record. A story with
  // no floor-eligible hit (the common case, and the only case while every
  // feed ships `floorEligible: false`) never touches the key store, so the
  // fail-closed production guard in `getEvidenceKeyRing()` cannot stall an
  // analysis job that would have had nothing to record anyway.
  let keyRing: HmacKeyRing | undefined = opts.keyRing;
  const resolveKeyRing = (): HmacKeyRing => {
    if (!keyRing) keyRing = getEvidenceKeyRing();
    return keyRing;
  };

  const canonical = await loadCanonicalVersion(customerPool, storyId);
  if (!canonical) {
    return {
      status: "skipped",
      knownIocHit: false,
      coverageStatus: "unknown",
      evidenceCount: 0,
    };
  }

  // Once the canonical version is known, any hard failure (key-ring config,
  // redaction-map decryption, DB error) must leave a VISIBLE, recoverable
  // marker. Without it the analysis precondition would requeue forever with
  // nothing but process logs to explain the stall. A `failed` marker is
  // recoverable: a later successful run flips it back to `complete`.
  try {
    return await enrichCanonicalVersion(customerPool, {
      customerId,
      storyId,
      canonical,
      now,
      loadMap,
      buildDispatcher: () => buildDispatcher(opts.authPool, now),
      resolveKeyRing,
    });
  } catch (err) {
    await persistEnrichmentFailure(customerPool, {
      storyId,
      storyVersion: canonical.storyVersion,
      error: err,
    }).catch((markErr) => {
      console.error(
        "[enrichment-worker] failed to persist enrichment-failure marker:",
        markErr,
      );
    });
    throw err;
  }
}

interface EnrichCanonicalArgs {
  customerId: string;
  storyId: string;
  canonical: CanonicalVersion;
  now: () => Date;
  loadMap: LoadRedactionMap;
  buildDispatcher: () => EnrichmentDispatcher;
  resolveKeyRing: () => HmacKeyRing;
}

/** Run the dispatch + persist for one canonical version (throws on hard error). */
async function enrichCanonicalVersion(
  customerPool: Pool,
  args: EnrichCanonicalArgs,
): Promise<EnrichmentOutcome> {
  const { customerId, storyId, canonical, now, loadMap } = args;
  const members = await loadMembers(
    customerPool,
    storyId,
    canonical.storyVersion,
  );
  const dispatcher = args.buildDispatcher();
  const checkedAt = now().toISOString();

  let knownIocHit = false;
  // No indicators to check means nothing was missed — complete coverage.
  let coverage: CoverageStatus = "complete";
  const evidence: EvidenceRecord[] = [];

  for (const member of members) {
    // Combine both redacted sources for this event_key: the member JSONB
    // and the discrete policy_event columns (RFC 0003 §3). They are
    // redacted independently at ingest but share one event_redaction_map
    // row, so a single recover closure covers tokens from either. Nulls
    // and the nested object are walked uniformly by `extractIndicators`.
    const policyRows = await loadPolicyEventFields(
      customerPool,
      canonical.sourceAiceId,
      member.member_event_key,
    );
    const sources: unknown[] = [member.event];
    for (const p of policyRows) {
      sources.push(p.orig_addr, p.resp_addr, p.host, p.dns_query, p.uri);
    }
    const recover = await buildRecover(
      customerPool,
      customerId,
      canonical.sourceAiceId,
      member.member_event_key,
      sources,
      loadMap,
    );
    for (const { indicator, redactionToken } of extractIndicators(
      sources,
      recover,
    )) {
      const merged = await dispatcher.dispatch(indicator);
      coverage = worseCoverage(coverage, merged.coverage.status);
      for (const match of merged.matches) {
        if (!matchSatisfiesFloor(match)) continue;
        knownIocHit = true;
        evidence.push(
          buildEvidenceRecord({
            indicator,
            match,
            redactionToken,
            // Resolved only here — the first floor-supporting match.
            keyRing: args.resolveKeyRing(),
            checkedAt,
            expiresAt: merged.expiresAt,
            coverage: merged.coverage,
          }),
        );
      }
    }
  }

  await persistEnrichment(customerPool, {
    storyId,
    storyVersion: canonical.storyVersion,
    knownIocHit,
    coverage,
    evidence,
    completedAt: checkedAt,
  });

  return {
    status: "complete",
    knownIocHit,
    coverageStatus: coverage,
    evidenceCount: evidence.length,
    storyVersion: canonical.storyVersion,
  };
}

interface PersistArgs {
  storyId: string;
  storyVersion: string;
  knownIocHit: boolean;
  coverage: CoverageStatus;
  evidence: readonly EvidenceRecord[];
  completedAt: string;
}

async function persistEnrichment(
  customerPool: Pool,
  args: PersistArgs,
): Promise<void> {
  const client = await customerPool.connect();
  try {
    await client.query("BEGIN");

    // Monotonic floor write: never flip an observed hit back to false.
    await client.query(
      `UPDATE story
          SET known_ioc_hit = known_ioc_hit OR $3
        WHERE story_id = $1::bigint AND story_version = $2`,
      [args.storyId, args.storyVersion, args.knownIocHit],
    );

    // Evidence must stay consistent with the monotonic boolean: a `true`
    // floor has to remain explainable after the fact. Replace this
    // version's evidence ONLY when the current run produced supporting
    // matches — those are fresh and accurate for the retained `true`. When
    // the current run produced NO supporting match (e.g. the feed snapshot
    // is unavailable, a refreshed feed no longer lists the IOC, or a policy
    // was made ineligible) we leave any prior evidence in place rather than
    // blindly deleting it: the `known_ioc_hit OR` above keeps a prior `true`
    // (an unavailable source never erases an observed hit), so deleting the
    // evidence would leave a `true` floor with nothing to explain it. A
    // prior `false` simply has no evidence to preserve, so this is a no-op
    // there.
    if (args.evidence.length > 0) {
      await client.query(
        `DELETE FROM story_ioc_evidence
          WHERE story_id = $1::bigint AND story_version = $2`,
        [args.storyId, args.storyVersion],
      );
    }
    for (const e of args.evidence) {
      await client.query(
        `INSERT INTO story_ioc_evidence
           (story_id, story_version, redaction_token,
            normalized_indicator_hmac, hmac_key_version, evidence_key_id,
            normalization_version, source_policy_id, source_version,
            feed_hash, source_updated_at, hit_type, floor_eligible,
            coverage_status, checked_at, expires_at)
         VALUES ($1::bigint, $2, $3, $4, $5, $6, $7, $8, $9, $10,
                 $11::timestamptz, $12, $13, $14, $15::timestamptz,
                 $16::timestamptz)`,
        [
          args.storyId,
          args.storyVersion,
          e.redactionToken,
          e.normalizedIndicatorHmac,
          e.hmacKeyVersion,
          e.evidenceKeyId ?? null,
          e.normalizationVersion,
          e.sourcePolicyId,
          e.sourceVersion ?? null,
          e.feedHash ?? null,
          e.sourceUpdatedAt ?? null,
          e.hitType,
          e.floorEligible,
          e.coverage?.status ?? null,
          e.checkedAt,
          e.expiresAt ?? null,
        ],
      );
    }

    // Completion marker — written even on zero matches. `known_ioc_hit` is
    // monotonic OR; `coverage_status` reflects the latest run.
    await client.query(
      `INSERT INTO story_enrichment_state
         (story_id, story_version, status, coverage_status, known_ioc_hit,
          completed_at)
       VALUES ($1::bigint, $2, 'complete', $3, $4, $5::timestamptz)
       ON CONFLICT (story_id, story_version) DO UPDATE SET
         status         = 'complete',
         coverage_status = EXCLUDED.coverage_status,
         known_ioc_hit  = story_enrichment_state.known_ioc_hit
                          OR EXCLUDED.known_ioc_hit,
         completed_at   = EXCLUDED.completed_at,
         last_error     = NULL,
         updated_at     = NOW()`,
      [
        args.storyId,
        args.storyVersion,
        args.coverage,
        args.knownIocHit,
        args.completedAt,
      ],
    );

    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Record a hard enrichment failure as a VISIBLE, recoverable
 * `story_enrichment_state` row so the analysis precondition's requeue is no
 * longer an invisible stall: operators see `status = 'failed'` and the
 * `last_error`. Monotonic-safe — a prior `complete` (and its observed
 * `known_ioc_hit`) is never downgraded, so a transient failure after a good
 * run cannot un-ready a story; only a never-completed version is marked
 * `failed`. A subsequent successful run flips it back to `complete`.
 */
async function persistEnrichmentFailure(
  customerPool: Pool,
  args: { storyId: string; storyVersion: string; error: unknown },
): Promise<void> {
  const message =
    args.error instanceof Error ? args.error.message : String(args.error);
  await customerPool.query(
    `INSERT INTO story_enrichment_state
       (story_id, story_version, status, coverage_status, known_ioc_hit,
        last_error)
     VALUES ($1::bigint, $2, 'failed', 'unknown', FALSE, $3)
     ON CONFLICT (story_id, story_version) DO UPDATE SET
       status          = CASE WHEN story_enrichment_state.status = 'complete'
                              THEN 'complete' ELSE 'failed' END,
       coverage_status = CASE WHEN story_enrichment_state.status = 'complete'
                              THEN story_enrichment_state.coverage_status
                              ELSE 'unknown' END,
       known_ioc_hit   = story_enrichment_state.known_ioc_hit,
       last_error      = EXCLUDED.last_error,
       updated_at      = NOW()`,
    [args.storyId, args.storyVersion, message.slice(0, 2000)],
  );
}

// ---------------------------------------------------------------------------
// Tick — drive enrichment for stories about to be analyzed
// ---------------------------------------------------------------------------

// Advisory-lock namespace distinct from the story-analysis worker's pair
// so the two never contend on the same keys.
const ENRICHMENT_LOCK_NS = 0x361a;

function enrichmentLockId2(customerId: string, storyId: string): number {
  let hash = 0;
  for (const ch of `${customerId}/${storyId}`) {
    hash = (hash * 31 + ch.charCodeAt(0)) | 0;
  }
  return Math.abs(hash) | 1;
}

/**
 * Enrich up to `limit` stories that have a queued (real) analysis job but
 * no completed enrichment for their canonical version. Runs BEFORE the
 * story-analysis dispatch in the poll loop so enrichment usually lands
 * first; the analysis-worker precondition is the actual ordering
 * guarantee, so a story not reached here simply requeues. Returns the
 * number of stories enriched.
 */
export async function tickStoryEnrichmentOnce(
  authPool: Pool,
  limit: number,
  opts: EnrichmentWorkerOptions = { authPool },
): Promise<number> {
  const { rows: candidates } = await authPool.query<{
    customer_id: string;
    story_id: string;
  }>(
    `SELECT DISTINCT s.customer_id::text AS customer_id,
            s.story_id::text             AS story_id
       FROM story_analysis_state s
       JOIN story_analysis_job j
         ON j.customer_id = s.customer_id AND j.story_id = s.story_id
      WHERE j.status = 'queued' AND j.dry_run = FALSE
      ORDER BY s.customer_id::text, s.story_id::text
      LIMIT $1`,
    [limit],
  );

  const resolve = opts.resolveCustomerPool ?? getCustomerRuntimePool;
  let enriched = 0;
  for (const candidate of candidates) {
    // Per-candidate failures (e.g. an unresolvable customer pool) must
    // never break the analysis loop — log and move on. A hard failure
    // reached after the canonical version is known has already persisted a
    // visible `failed` marker (see `runStoryEnrichment`); the analysis
    // precondition reports that state and keeps requeuing (recoverably).
    try {
      const customerPool = resolve(candidate.customer_id);
      const canonical = await loadCanonicalVersion(
        customerPool,
        candidate.story_id,
      );
      if (!canonical) continue;
      if (
        await isEnrichmentComplete(
          customerPool,
          candidate.story_id,
          canonical.storyVersion,
        )
      ) {
        continue;
      }
      if (await enrichUnderLock(authPool, candidate, opts)) {
        enriched += 1;
      }
    } catch (err) {
      console.error("[enrichment-worker] enrichment candidate failed:", err);
    }
  }
  return enriched;
}

/**
 * Acquire the per-story advisory lock and run enrichment. Returns whether
 * enrichment ran (false if the lock was already held by another worker).
 */
async function enrichUnderLock(
  authPool: Pool,
  candidate: { customer_id: string; story_id: string },
  opts: EnrichmentWorkerOptions,
): Promise<boolean> {
  const lockId2 = enrichmentLockId2(candidate.customer_id, candidate.story_id);
  const lockClient = await authPool.connect();
  try {
    const lockRes = await lockClient.query<{ locked: boolean }>(
      `SELECT pg_try_advisory_lock($1, $2) AS locked`,
      [ENRICHMENT_LOCK_NS, lockId2],
    );
    if (!lockRes.rows[0]?.locked) return false;
    try {
      await runStoryEnrichment(candidate.customer_id, candidate.story_id, opts);
      return true;
    } finally {
      await lockClient
        .query(`SELECT pg_advisory_unlock($1, $2)`, [
          ENRICHMENT_LOCK_NS,
          lockId2,
        ])
        .catch(() => {});
    }
  } finally {
    lockClient.release();
  }
}

async function isEnrichmentComplete(
  customerPool: Pool,
  storyId: string,
  storyVersion: string,
): Promise<boolean> {
  const { rows } = await customerPool.query<{ status: string }>(
    `SELECT status
       FROM story_enrichment_state
      WHERE story_id = $1::bigint AND story_version = $2`,
    [storyId, storyVersion],
  );
  return rows[0]?.status === "complete";
}

export const __testables = {
  loadCanonicalVersion,
  worseCoverage,
  enrichmentLockId2,
  ENRICHMENT_LOCK_NS,
} satisfies Record<string, unknown>;
