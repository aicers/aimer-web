// RFC 0003 P1a (#361) — async IOC enrichment worker.
//
// For a story's canonical version, the worker:
//   1. extracts + normalizes indicators from the stored, already-redacted
//      member rows (recovering tokenized customer-asset IPs via the event
//      redaction map),
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
// versions. The dev fallback keeps local/test runs working; production
// supplies `IOC_EVIDENCE_HMAC_KEY` (+ optional `_VERSION`).
let cachedKeyRing: HmacKeyRing | undefined;

export function getEvidenceKeyRing(): HmacKeyRing {
  if (cachedKeyRing) return cachedKeyRing;
  const version = process.env.IOC_EVIDENCE_HMAC_KEY_VERSION ?? "v1";
  const key =
    process.env.IOC_EVIDENCE_HMAC_KEY ?? "dev-insecure-ioc-evidence-hmac-key";
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
 * Build a token-recovery closure for one member. The redaction map is only
 * loaded + decrypted when the member actually contains a token, so the
 * common (raw-only) path never touches the secret store.
 */
async function buildRecover(
  customerPool: Pool,
  customerId: string,
  aiceId: string,
  member: MemberEventRow,
  loadMap: LoadRedactionMap,
): Promise<RecoverToken> {
  if (!JSON.stringify(member.event ?? null).includes("<<REDACTED_")) {
    return () => undefined;
  }
  const map = await loadMap(
    customerPool,
    customerId,
    aiceId,
    member.member_event_key,
  );
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
 * re-running replaces this version's evidence rows and re-marks state, and
 * the `known_ioc_hit` writes are monotonic OR.
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
  const keyRing = opts.keyRing ?? getEvidenceKeyRing();
  const loadMap = opts.loadRedactionMap ?? defaultLoadRedactionMap;
  const buildDispatcher =
    opts.buildDispatcher ??
    ((authPool, clock) =>
      buildLocalFeedDispatcher(new PgFeedStore(authPool), { now: clock }));

  const canonical = await loadCanonicalVersion(customerPool, storyId);
  if (!canonical) {
    return {
      status: "skipped",
      knownIocHit: false,
      coverageStatus: "unknown",
      evidenceCount: 0,
    };
  }

  const members = await loadMembers(
    customerPool,
    storyId,
    canonical.storyVersion,
  );
  const dispatcher = buildDispatcher(opts.authPool, now);
  const checkedAt = now().toISOString();

  let knownIocHit = false;
  // No indicators to check means nothing was missed — complete coverage.
  let coverage: CoverageStatus = "complete";
  const evidence: EvidenceRecord[] = [];

  for (const member of members) {
    const recover = await buildRecover(
      customerPool,
      customerId,
      canonical.sourceAiceId,
      member,
      loadMap,
    );
    for (const { indicator, redactionToken } of extractIndicators(
      member.event,
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
            keyRing,
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

    // Replace this version's evidence (idempotent re-run).
    await client.query(
      `DELETE FROM story_ioc_evidence
        WHERE story_id = $1::bigint AND story_version = $2`,
      [args.storyId, args.storyVersion],
    );
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
    // never break the analysis loop — log and move on. The analysis
    // worker's precondition still requeues until enrichment lands.
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
