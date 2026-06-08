// RFC 0003 consumer ④ (#492) — per-event IOC enrichment for individual
// loose baseline events. The event-grain analog of `runStoryEnrichment`
// (`enrichment-worker.ts`) and the tier-A prerequisite for RFC 0002's
// individual baseline-event auto-analysis (amendment, #489).
//
// For one loose baseline event — keyed by `(source_aice_id, event_key)` and
// NOT a member of any story — the primitive:
//   1. reads the stored, already-redacted `baseline_event.raw_event`,
//      deduped to the LATEST row by `received_at` (with `baseline_version
//      DESC` as the deterministic tie-break) since `event_key` recurs across
//      `baseline_version` after a rebaseline,
//   2. extracts + normalizes indicators from that payload (recovering
//      tokenized customer-asset IPs via the event redaction map), reusing
//      `extractIndicators`,
//   3. dispatches each through the Tier-1 dispatcher (#427),
//   4. derives the per-event verdict `known_ioc_hit` = OR over any match
//      where `matchSatisfiesFloor` (the v1 per-event floor === the story
//      floor; RFC 0003 consumer ④), monotonic — an unavailable source never
//      flips a hit to false,
//   5. persists one `event_ioc_evidence` row per floor-supporting match,
//   6. writes the per-event `event_enrichment_state` completion marker with
//      `coverage_status` (never a silent `false`), written even on zero
//      matches so `false-complete` is distinguishable from `false-unknown`.
//
// This is ONLY the single-event primitive: the orchestration that selects
// loose events and drives enrichment at scale (ingest-hook seeding, worker
// tick, bulk scan) is deferred to the downstream auto-analysis worker issue
// (#489). Event-level narrative facts (the `story_enrichment_fact` analog)
// are likewise out of scope — they feed the LLM prompt, the analyze step's
// concern. This worker runs asynchronously after ingest and never gates raw
// ingest.

import "server-only";

import type { Pool } from "pg";
import { getCustomerRuntimePool } from "@/lib/db/customer-runtime-pool";
import type { EnrichmentDispatcher } from "./enrichment/dispatcher";
import {
  buildEvidenceRecord,
  type EvidenceRecord,
} from "./enrichment/evidence";
import { PgFeedStore } from "./enrichment/feed-store";
import { extractIndicators } from "./enrichment/indicator-extraction";
import { buildLocalFeedDispatcher } from "./enrichment/local-feed-enricher";
import { matchSatisfiesFloor } from "./enrichment/source-policy";
import type { CoverageStatus } from "./enrichment/types";
import {
  buildRecover,
  defaultLoadRedactionMap,
  type EnrichmentWorkerOptions,
  type LoadRedactionMap,
  worseCoverage,
} from "./enrichment-worker";

/**
 * Injectable options for the per-event primitive. The same surface the
 * story path carries (`EnrichmentWorkerOptions`), minus the fact-redaction
 * loaders (`loadRanges` / `loadOwnedDomains`) — event narrative facts are
 * out of scope here, so they are never read. Reused directly so tests and
 * operation drive both paths the same way.
 */
export type EventEnrichmentOptions = EnrichmentWorkerOptions;

export interface EventEnrichmentOutcome {
  status: "complete" | "skipped";
  knownIocHit: boolean;
  coverageStatus: CoverageStatus;
  evidenceCount: number;
}

// ---------------------------------------------------------------------------
// Customer-DB reads
// ---------------------------------------------------------------------------

/**
 * The latest stored `baseline_event.raw_event` for a logical event. The
 * grain is `(source_aice_id, event_key)`, but `baseline_event`'s PK is
 * `(baseline_version, event_key)` — the same `event_key` recurs across
 * baseline versions after a rebaseline (0002 table DDL lines 21-25). The
 * verdict describes the logical event, so we dedupe to the latest row by
 * `received_at`, with `baseline_version DESC` as the deterministic
 * tie-breaker on equal timestamps (the dedupe rule the DDL mandates).
 */
async function loadLatestBaselineEvent(
  customerPool: Pool,
  sourceAiceId: string,
  eventKey: string,
): Promise<{ rawEvent: unknown } | null> {
  const { rows } = await customerPool.query<{ raw_event: unknown }>(
    `SELECT raw_event
       FROM baseline_event
      WHERE source_aice_id = $1 AND event_key = $2::numeric
      ORDER BY received_at DESC, baseline_version DESC
      LIMIT 1`,
    [sourceAiceId, eventKey],
  );
  if (rows.length === 0) return null;
  return { rawEvent: rows[0].raw_event };
}

/**
 * Whether this event is a member of any story — non-membership is the
 * absence of a `story_member` row whose `(story.source_aice_id,
 * story_member.member_event_key)` equals the event's `(source_aice_id,
 * event_key)`. `story_member` alone carries no source, so the check joins
 * `story_member` to `story`. A story member is enriched at story scope; the
 * primitive skips it so the two paths never double-work.
 */
async function isStoryMember(
  customerPool: Pool,
  sourceAiceId: string,
  eventKey: string,
): Promise<boolean> {
  const { rows } = await customerPool.query<{ one: number }>(
    `SELECT 1 AS one
       FROM story_member sm
       JOIN story s
         ON s.story_id = sm.story_id AND s.story_version = sm.story_version
      WHERE s.source_aice_id = $1 AND sm.member_event_key = $2::numeric
      LIMIT 1`,
    [sourceAiceId, eventKey],
  );
  return rows.length > 0;
}

// ---------------------------------------------------------------------------
// Per-event enrichment
// ---------------------------------------------------------------------------

/**
 * Enrich one loose baseline event and persist the per-event verdict.
 * Idempotent and concurrency-safe: the `known_ioc_hit` write is a monotonic
 * OR, evidence is replaced only when the run produces supporting matches (so
 * a retained monotonic `true` never loses its explaining evidence), and the
 * evidence replace + state upsert are serialized per `(source_aice_id,
 * event_key)` by a transaction-scoped advisory lock so overlapping runs
 * cannot duplicate evidence. Returns `skipped` when the event has no stored
 * `baseline_event` row or is a story member (enriched at story scope).
 */
export async function runEventEnrichment(
  customerId: string,
  sourceAiceId: string,
  eventKey: string,
  opts: EventEnrichmentOptions,
): Promise<EventEnrichmentOutcome> {
  const customerPool = (opts.resolveCustomerPool ?? getCustomerRuntimePool)(
    customerId,
  );
  const now = opts.now ?? (() => new Date());
  const loadMap = opts.loadRedactionMap ?? defaultLoadRedactionMap;
  const buildDispatcher =
    opts.buildDispatcher ??
    ((authPool, clock) =>
      buildLocalFeedDispatcher(new PgFeedStore(authPool), { now: clock }));

  const baseline = await loadLatestBaselineEvent(
    customerPool,
    sourceAiceId,
    eventKey,
  );
  if (!baseline) {
    return {
      status: "skipped",
      knownIocHit: false,
      coverageStatus: "unknown",
      evidenceCount: 0,
    };
  }

  // Story members are enriched at story scope (`runStoryEnrichment`); skip
  // them so the two paths never double-work. No state row is written for a
  // member — its IOC signal lives on the story.
  if (await isStoryMember(customerPool, sourceAiceId, eventKey)) {
    return {
      status: "skipped",
      knownIocHit: false,
      coverageStatus: "unknown",
      evidenceCount: 0,
    };
  }

  // Once the event is known to exist + be loose, any hard failure (redaction
  // -map decryption, DB error) must leave a VISIBLE, recoverable marker so
  // the downstream worker's precondition is not an invisible stall. A
  // `failed` marker is recoverable: a later successful run flips it back to
  // `complete`.
  try {
    return await enrichLooseEvent(customerPool, {
      customerId,
      sourceAiceId,
      eventKey,
      rawEvent: baseline.rawEvent,
      now,
      loadMap,
      buildDispatcher: () => buildDispatcher(opts.authPool, now),
    });
  } catch (err) {
    await persistEventEnrichmentFailure(customerPool, {
      sourceAiceId,
      eventKey,
      error: err,
    }).catch((markErr) => {
      console.error(
        "[event-enrichment-worker] failed to persist failure marker:",
        markErr,
      );
    });
    throw err;
  }
}

interface EnrichLooseEventArgs {
  customerId: string;
  sourceAiceId: string;
  eventKey: string;
  rawEvent: unknown;
  now: () => Date;
  loadMap: LoadRedactionMap;
  buildDispatcher: () => EnrichmentDispatcher;
}

/** Run the dispatch + persist for one loose event (throws on hard error). */
async function enrichLooseEvent(
  customerPool: Pool,
  args: EnrichLooseEventArgs,
): Promise<EventEnrichmentOutcome> {
  const { customerId, sourceAiceId, eventKey, rawEvent, now, loadMap } = args;
  const dispatcher = args.buildDispatcher();
  const checkedAt = now().toISOString();

  let knownIocHit = false;
  // No indicators to check means nothing was missed — complete coverage.
  let coverage: CoverageStatus = "complete";
  const evidence: EvidenceRecord[] = [];

  // Indicators are drawn solely from the stored, redacted
  // `baseline_event.raw_event` — baseline events have no `policy_event`
  // typed-column source the story path additionally reads. The recover
  // closure is built only when the payload actually contains a token.
  const recover = await buildRecover(
    customerPool,
    customerId,
    sourceAiceId,
    eventKey,
    rawEvent,
    loadMap,
  );
  for (const { indicator, redactionToken } of extractIndicators(
    rawEvent,
    recover,
  )) {
    const merged = await dispatcher.dispatch(indicator);
    coverage = worseCoverage(coverage, merged.coverage.status);
    for (const match of merged.matches) {
      // The v1 per-event floor mirrors the story floor exactly: a match
      // qualifies iff `matchSatisfiesFloor` (deterministic_ioc &&
      // floorEligible; non-public IPs already forced ineligible). Soft-
      // reputation / floor-ineligible matches never enter evidence and
      // never produce a tier-A-qualifying verdict.
      if (!matchSatisfiesFloor(match)) continue;
      knownIocHit = true;
      evidence.push(
        buildEvidenceRecord({
          match,
          redactionToken,
          // The `(source_aice_id, event_key)` scope recovers a customer-
          // asset token (its original lives only in that event_redaction_map
          // row) and is provenance for a raw external one.
          sourceAiceId,
          memberEventKey: eventKey,
          checkedAt,
          expiresAt: merged.expiresAt,
          coverage: merged.coverage,
        }),
      );
    }
  }

  await persistEventEnrichment(customerPool, {
    sourceAiceId,
    eventKey,
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
  };
}

interface PersistArgs {
  sourceAiceId: string;
  eventKey: string;
  knownIocHit: boolean;
  coverage: CoverageStatus;
  evidence: readonly EvidenceRecord[];
  completedAt: string;
}

// Advisory-lock namespace for per-event persistence, distinct from the
// story enrichment namespace (`ENRICHMENT_LOCK_NS` = 0x361a) so the two
// paths never contend on shared keys.
const EVENT_ENRICHMENT_LOCK_NS = 0x492e;

// A stable 31-bit lock key for one logical event, mirroring the story
// path's `enrichmentLockId2`. `| 1` keeps it non-zero.
function eventEnrichmentLockId2(
  sourceAiceId: string,
  eventKey: string,
): number {
  let hash = 0;
  for (const ch of `${sourceAiceId}/${eventKey}`) {
    hash = (hash * 31 + ch.charCodeAt(0)) | 0;
  }
  return Math.abs(hash) | 1;
}

async function persistEventEnrichment(
  customerPool: Pool,
  args: PersistArgs,
): Promise<void> {
  const client = await customerPool.connect();
  try {
    await client.query("BEGIN");

    // Serialize concurrent persists for the SAME (source_aice_id, event_key).
    // The evidence DELETE+INSERT below is not atomic against a concurrent
    // transaction: under READ COMMITTED neither run's conditional DELETE sees
    // the other's uncommitted inserts, so two overlapping runs could both
    // insert the same floor-supporting rows — and `event_ioc_evidence` has no
    // uniqueness constraint to catch the dup. A transaction-scoped advisory
    // lock makes the replace sequence serial per event (auto-released on
    // COMMIT/ROLLBACK); different events never contend. The story path gets
    // this serialization from its orchestration's advisory lock
    // (`enrichUnderLock`), but the event orchestration is deferred (#489), so
    // the primitive serializes its own persist.
    await client.query("SELECT pg_advisory_xact_lock($1, $2)", [
      EVENT_ENRICHMENT_LOCK_NS,
      eventEnrichmentLockId2(args.sourceAiceId, args.eventKey),
    ]);

    // Evidence must stay consistent with the monotonic verdict: a `true`
    // floor has to remain explainable. Replace this event's evidence ONLY
    // when the current run produced supporting matches — those are fresh and
    // accurate for the retained `true`. When the run produced NO supporting
    // match (feed snapshot unavailable, a refreshed feed no longer lists the
    // IOC, a policy made ineligible) we leave any prior evidence in place:
    // the `known_ioc_hit OR` below keeps a prior `true`, so deleting evidence
    // would leave a `true` floor with nothing to explain it. A prior `false`
    // has no evidence to preserve, so this is a no-op there.
    if (args.evidence.length > 0) {
      await client.query(
        `DELETE FROM event_ioc_evidence
          WHERE source_aice_id = $1 AND event_key = $2::numeric`,
        [args.sourceAiceId, args.eventKey],
      );
    }
    for (const e of args.evidence) {
      await client.query(
        `INSERT INTO event_ioc_evidence
           (source_aice_id, event_key, redaction_token,
            source_policy_id, source_version, feed_hash, source_updated_at,
            hit_type, floor_eligible, coverage_status, checked_at, expires_at)
         VALUES ($1, $2::numeric, $3, $4, $5, $6, $7::timestamptz,
                 $8, $9, $10, $11::timestamptz, $12::timestamptz)`,
        [
          args.sourceAiceId,
          args.eventKey,
          e.redactionToken,
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
    // monotonic OR (a later source-down / refresh-miss never downgrades an
    // established `true`); `coverage_status` reflects the latest run.
    await client.query(
      `INSERT INTO event_enrichment_state
         (source_aice_id, event_key, status, coverage_status, known_ioc_hit,
          completed_at)
       VALUES ($1, $2::numeric, 'complete', $3, $4, $5::timestamptz)
       ON CONFLICT (source_aice_id, event_key) DO UPDATE SET
         status          = 'complete',
         coverage_status = EXCLUDED.coverage_status,
         known_ioc_hit   = event_enrichment_state.known_ioc_hit
                           OR EXCLUDED.known_ioc_hit,
         completed_at    = EXCLUDED.completed_at,
         last_error      = NULL,
         updated_at      = NOW()`,
      [
        args.sourceAiceId,
        args.eventKey,
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
 * `event_enrichment_state` row so the downstream worker's requeue is not an
 * invisible stall: operators see `status = 'failed'` and the `last_error`.
 * Monotonic-safe — a prior `complete` (and its observed `known_ioc_hit`) is
 * never downgraded, so a transient failure after a good run cannot un-ready
 * an event; only a never-completed event is marked `failed`. A subsequent
 * successful run flips it back to `complete`.
 */
async function persistEventEnrichmentFailure(
  customerPool: Pool,
  args: { sourceAiceId: string; eventKey: string; error: unknown },
): Promise<void> {
  const message =
    args.error instanceof Error ? args.error.message : String(args.error);
  await customerPool.query(
    `INSERT INTO event_enrichment_state
       (source_aice_id, event_key, status, coverage_status, known_ioc_hit,
        last_error)
     VALUES ($1, $2::numeric, 'failed', 'unknown', FALSE, $3)
     ON CONFLICT (source_aice_id, event_key) DO UPDATE SET
       status          = CASE WHEN event_enrichment_state.status = 'complete'
                              THEN 'complete' ELSE 'failed' END,
       coverage_status = CASE WHEN event_enrichment_state.status = 'complete'
                              THEN event_enrichment_state.coverage_status
                              ELSE 'unknown' END,
       known_ioc_hit   = event_enrichment_state.known_ioc_hit,
       last_error      = EXCLUDED.last_error,
       updated_at      = NOW()`,
    [args.sourceAiceId, args.eventKey, message.slice(0, 2000)],
  );
}

// ---------------------------------------------------------------------------
// Readiness + verdict read
// ---------------------------------------------------------------------------

export interface EventEnrichmentVerdict {
  status: "complete" | "failed";
  coverageStatus: CoverageStatus;
  knownIocHit: boolean;
  completedAt: string | null;
}

/**
 * The per-event readiness + verdict for `(source_aice_id, event_key)`, read
 * from ONE `event_enrichment_state` row so the downstream worker reads the
 * readiness marker (`status`) and the floor verdict (`known_ioc_hit` +
 * `coverage_status`) from the SAME DB snapshot and can never gate on a torn
 * read — analogous to the story worker reading `story_enrichment_state` +
 * `known_ioc_hit` together. `null` when enrichment has never run for the
 * event (no marker yet).
 */
export async function loadEventEnrichmentVerdict(
  customerPool: Pool,
  sourceAiceId: string,
  eventKey: string,
): Promise<EventEnrichmentVerdict | null> {
  const { rows } = await customerPool.query<{
    status: "complete" | "failed";
    coverage_status: CoverageStatus;
    known_ioc_hit: boolean;
    completed_at: Date | null;
  }>(
    `SELECT status, coverage_status, known_ioc_hit, completed_at
       FROM event_enrichment_state
      WHERE source_aice_id = $1 AND event_key = $2::numeric`,
    [sourceAiceId, eventKey],
  );
  if (rows.length === 0) return null;
  return {
    status: rows[0].status,
    coverageStatus: rows[0].coverage_status,
    knownIocHit: rows[0].known_ioc_hit,
    completedAt: rows[0].completed_at?.toISOString() ?? null,
  };
}

export const __testables = {
  loadLatestBaselineEvent,
  isStoryMember,
  eventEnrichmentLockId2,
  EVENT_ENRICHMENT_LOCK_NS,
} satisfies Record<string, unknown>;
