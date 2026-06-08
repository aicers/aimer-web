// Operator-triggered story-leaf re-analysis backfill (#466).
//
// When a customer's default analysis model changes (#473), existing story
// analysis leaves stay on the OLD model. New default-model reports remain
// complete via the #465 fallback coverage, but their aggregate scores are
// computed from the (initially few) new-model leaves only — a transient
// understatement surfaced by the #465 coverage indicator. This module
// re-queues EXISTING story-leaf analyses under the new default model to
// shrink that transition window.
//
// It is deliberately NOT automatic: re-analyzing leaves is an LLM-cost
// burst, so an operator decides WHEN and over WHAT SCOPE; the system only
// executes. The trigger surface is the in-app re-analysis page launched
// from the #473 model-change flow (Admin any customer; Analyst assigned
// customers — the same actor set as the per-customer default-model
// control).
//
// SCOPE: STORY LEAVES ONLY. Report-variant refresh is #469 (which gates on
// the drain-completion signal exposed here) and event-leaf re-analysis is
// #470 (no `event_analysis_state` / re-seed worker exists today).
//
// MECHANISM: a COALESCING enqueue that mirrors `enqueueOnDemandReportJob`
// (report-worker.ts) — it writes `story_analysis_job` rows directly and
// lets the EXISTING story job worker drain them. It is NOT the force
// regenerate endpoint (which bumps `generation` unconditionally and would
// break leaf idempotency), and NOT a post-flip dirty-mark (a state row
// carries no model and cannot do an already-current skip).
//
// SERVER-ONLY. Reads the auth DB (state/job rows) and each customer's
// runtime DB (the live `story` row, for the source-availability check).

import "server-only";

import type { Pool } from "pg";
import { auditLog } from "../audit";
import { getAuthPool } from "../db/client";
import { getCustomerRuntimePool } from "../db/customer-runtime-pool";

/**
 * Conservative recent-window default (#466 Scope §3): when no time scope is
 * given the backfill only considers stories whose last member activity is
 * within this many days, so a no-scope run never re-analyzes all history.
 */
export const DEFAULT_WINDOW_DAYS = 7;

/** Story-analysis job lifecycle statuses (matches the CHECK constraint). */
type JobStatus = "queued" | "processing" | "done" | "failed";

/** Story-analysis state lifecycle statuses (matches the CHECK constraint). */
type StateStatus = "pending" | "ready" | "dirty" | "archived";

/**
 * The scope of a backfill run / preview / drain query. `windowDays` is the
 * recent-window bound (`null` means no time bound — all history); `cap`
 * optionally bounds how many leaves a single run enqueues. The target model
 * `(modelName, model)` is the customer's NEW effective default — callers
 * resolve it via `resolveDefaultModel`, never letting the operator pick an
 * arbitrary target.
 */
export interface BackfillScope {
  customerId: string;
  modelName: string;
  model: string;
  windowDays: number | null;
  cap: number | null;
}

/**
 * One scanned `(story_id, lang)` candidate leaf: a story that already has at
 * least one analysis job (so there IS an existing analysis to re-run) plus
 * the status of its TARGET `(lang, modelName, model)` variant job, if any.
 */
export interface CandidateLeaf {
  storyId: string;
  lang: string;
  stateStatus: StateStatus;
  /** Status of the target-variant job, or `null` when it does not exist. */
  targetStatus: JobStatus | null;
  /** Whether the target-variant job is a leftover dry-run row. */
  targetDryRun: boolean;
}

// ---------------------------------------------------------------------------
// Pure classification (unit-testable without a DB)
// ---------------------------------------------------------------------------

/** What enqueueing a leaf does, and how it is reported. */
export type EnqueueAction = "seed" | "requeue" | null;
export type EnqueueCategory =
  | "seeded"
  | "requeued"
  | "coalesced"
  | "skipped_dirty"
  | "source_unavailable";

/**
 * Classify one candidate for the coalescing ENQUEUE path (#466 Scope §5),
 * mirroring `enqueueOnDemandReportJob` semantics:
 *   - archived state or no live `story` row → `source_unavailable` (never
 *     enqueue — it would only manufacture a `failed` job).
 *   - `dirty` parent state → `skipped_dirty`: a `done` job here is stale, and
 *     the worker's own `dirty` re-seed (under the worker default, which
 *     post-flip equals the target model) refreshes it. Enqueuing would
 *     double-queue against that dirty branch, so the helper neither coalesces
 *     it as current nor re-enqueues it — it reports it distinctly.
 *   - absent target variant → `seed` a fresh generation-1 queued row.
 *   - `failed`/dry-run target → `requeue` at the SAME generation (no bump).
 *   - `queued`/`processing`/`done` target → `coalesce` (leave untouched).
 */
export function classifyEnqueue(
  leaf: CandidateLeaf,
  sourceLive: boolean,
): { category: EnqueueCategory; action: EnqueueAction } {
  if (leaf.stateStatus === "archived" || !sourceLive) {
    return { category: "source_unavailable", action: null };
  }
  if (leaf.stateStatus === "dirty") {
    return { category: "skipped_dirty", action: null };
  }
  if (leaf.targetStatus === null) {
    return { category: "seeded", action: "seed" };
  }
  if (leaf.targetStatus === "failed" || leaf.targetDryRun) {
    return { category: "requeued", action: "requeue" };
  }
  return { category: "coalesced", action: null };
}

/** Per-leaf drain classification — the scope-addressable signal (#469 gate). */
export type DrainCategory =
  | "drained"
  | "absent"
  | "queued"
  | "processing"
  | "failed_outstanding"
  | "skipped_dirty"
  | "source_unavailable";

/**
 * Classify one candidate for the DRAIN-completion signal (#466 Scope §6).
 * A leaf is DRAINED only when its target-variant job is `done` (current
 * generation) AND the parent state is not `dirty`; everything else is
 * OUTSTANDING except `source_unavailable`, which is EXCLUDED (it can never
 * be re-analyzed, so it must not block #469's gate forever). `ready` state
 * alone does NOT imply drained — what matters is the target-variant job.
 */
export function classifyDrain(
  leaf: CandidateLeaf,
  sourceLive: boolean,
): DrainCategory {
  if (leaf.stateStatus === "archived" || !sourceLive) {
    return "source_unavailable";
  }
  if (leaf.stateStatus === "dirty") {
    return "skipped_dirty";
  }
  if (leaf.targetStatus === null) {
    return "absent";
  }
  if (leaf.targetStatus === "failed") {
    return "failed_outstanding";
  }
  if (leaf.targetDryRun) {
    // A leftover dry-run row is not a real leaf — outstanding until a real
    // analysis lands (the enqueue path requeues it).
    return "absent";
  }
  if (leaf.targetStatus === "queued") return "queued";
  if (leaf.targetStatus === "processing") return "processing";
  return "drained";
}

// ---------------------------------------------------------------------------
// Plan computation (pure; the cap is applied here, in recency order)
// ---------------------------------------------------------------------------

/** Per-category counts for the enqueue path, including the per-run cap. */
export interface EnqueueCounts {
  seeded: number;
  requeued: number;
  coalesced: number;
  skipped_dirty: number;
  source_unavailable: number;
  /**
   * Leaves that WOULD have been enqueued (seed/requeue) but were left out by
   * the per-run `cap`. Reported so a bounded run never appears exhaustive
   * (#466 Scope §4 — no silent caps).
   */
  cap_excluded: number;
}

/** A single write the run will perform. */
interface PlannedWrite {
  storyId: string;
  lang: string;
  action: "seed" | "requeue";
}

export interface BackfillPlan {
  counts: EnqueueCounts;
  writes: PlannedWrite[];
}

/**
 * Compute the enqueue plan from scanned candidates + the set of live
 * `story_id`s. Candidates must already be ordered most-recent-first so the
 * cap keeps the freshest leaves. The cap bounds only ENQUEUE writes
 * (seed/requeue); coalesced / skipped / unavailable leaves are unbounded
 * work-free outcomes and are always fully counted.
 */
export function computePlan(
  candidates: CandidateLeaf[],
  liveStoryIds: ReadonlySet<string>,
  cap: number | null,
): BackfillPlan {
  const counts: EnqueueCounts = {
    seeded: 0,
    requeued: 0,
    coalesced: 0,
    skipped_dirty: 0,
    source_unavailable: 0,
    cap_excluded: 0,
  };
  const writes: PlannedWrite[] = [];
  let enqueued = 0;

  for (const leaf of candidates) {
    const live = liveStoryIds.has(leaf.storyId);
    const { category, action } = classifyEnqueue(leaf, live);
    if (action === null) {
      counts[category] += 1;
      continue;
    }
    if (cap !== null && enqueued >= cap) {
      counts.cap_excluded += 1;
      continue;
    }
    enqueued += 1;
    writes.push({ storyId: leaf.storyId, lang: leaf.lang, action });
    if (action === "seed") counts.seeded += 1;
    else counts.requeued += 1;
  }

  return { counts, writes };
}

/** Per-category counts for the drain signal. */
export interface DrainCounts {
  drained: number;
  absent: number;
  queued: number;
  processing: number;
  failed_outstanding: number;
  skipped_dirty: number;
  source_unavailable: number;
}

export interface DrainSignal {
  scope: {
    customerId: string;
    modelName: string;
    model: string;
    windowDays: number | null;
  };
  counts: DrainCounts;
  /** In-scope leaves excluding `source_unavailable` (the gate denominator). */
  totalLeaves: number;
  /** Leaves not yet re-analyzed under the target model (gate numerator). */
  outstanding: number;
  /**
   * Whether every in-scope leaf is re-analyzed under the target model. This
   * is the scope-addressable gate #469 consults before refreshing a report
   * variant. `source_unavailable` leaves are excluded so they cannot block
   * the gate forever.
   */
  drained: boolean;
}

/** Compute the drain signal from scanned candidates + live `story_id`s. */
export function computeDrainSignal(
  scope: BackfillScope,
  candidates: CandidateLeaf[],
  liveStoryIds: ReadonlySet<string>,
): DrainSignal {
  const counts: DrainCounts = {
    drained: 0,
    absent: 0,
    queued: 0,
    processing: 0,
    failed_outstanding: 0,
    skipped_dirty: 0,
    source_unavailable: 0,
  };
  for (const leaf of candidates) {
    const live = liveStoryIds.has(leaf.storyId);
    counts[classifyDrain(leaf, live)] += 1;
  }
  const totalLeaves = candidates.length - counts.source_unavailable;
  const outstanding =
    counts.absent +
    counts.queued +
    counts.processing +
    counts.failed_outstanding +
    counts.skipped_dirty;
  return {
    scope: {
      customerId: scope.customerId,
      modelName: scope.modelName,
      model: scope.model,
      windowDays: scope.windowDays,
    },
    counts,
    totalLeaves,
    outstanding,
    drained: outstanding === 0,
  };
}

// ---------------------------------------------------------------------------
// DB access (injectable so the orchestration is unit-testable with fakes)
// ---------------------------------------------------------------------------

/**
 * The DB operations the orchestration needs. Injected so unit tests can
 * drive `preview` / `run` / `drain` with fakes and the SQL is exercised by a
 * focused db.test instead.
 */
export interface BackfillDeps {
  /** Scan `(story_id, lang)` candidates in scope, most-recent-first. */
  scanCandidates(scope: BackfillScope): Promise<CandidateLeaf[]>;
  /** Live `story_id`s among `storyIds` (per-customer runtime DB). */
  liveStoryIds(
    customerId: string,
    storyIds: string[],
  ): Promise<ReadonlySet<string>>;
  /** Seed a fresh generation-1 queued target-variant job (no force). */
  seedJob(
    customerId: string,
    storyId: string,
    lang: string,
    modelName: string,
    model: string,
  ): Promise<void>;
  /** Requeue a failed/dry-run target-variant job at the same generation. */
  requeueJob(
    customerId: string,
    storyId: string,
    lang: string,
    modelName: string,
    model: string,
  ): Promise<void>;
}

// Stories whose source is gone live as `archived` state (auth DB) — they are
// never candidates for a live-row lookup. Only `ready`/`dirty` candidates are
// checked against the customer DB.
function liveLookupIds(candidates: CandidateLeaf[]): string[] {
  const ids = new Set<string>();
  for (const leaf of candidates) {
    if (leaf.stateStatus !== "archived") ids.add(leaf.storyId);
  }
  return [...ids];
}

/** Preview a backfill: scan + classify, NO writes (the cost preview). */
export async function previewStoryBackfill(
  scope: BackfillScope,
  deps: BackfillDeps,
): Promise<EnqueueCounts> {
  const candidates = await deps.scanCandidates(scope);
  const live = await deps.liveStoryIds(
    scope.customerId,
    liveLookupIds(candidates),
  );
  return computePlan(candidates, live, scope.cap).counts;
}

export interface BackfillRunResult {
  scope: BackfillScope;
  counts: EnqueueCounts;
}

/**
 * Execute a backfill run: scan, classify, then perform the capped enqueue
 * writes. Idempotent — re-running coalesces in-flight/current leaves and
 * never double-queues. Returns the categorized outcome.
 */
export async function runStoryBackfill(
  scope: BackfillScope,
  deps: BackfillDeps,
): Promise<BackfillRunResult> {
  const candidates = await deps.scanCandidates(scope);
  const live = await deps.liveStoryIds(
    scope.customerId,
    liveLookupIds(candidates),
  );
  const plan = computePlan(candidates, live, scope.cap);
  for (const w of plan.writes) {
    if (w.action === "seed") {
      await deps.seedJob(
        scope.customerId,
        w.storyId,
        w.lang,
        scope.modelName,
        scope.model,
      );
    } else {
      await deps.requeueJob(
        scope.customerId,
        w.storyId,
        w.lang,
        scope.modelName,
        scope.model,
      );
    }
  }
  return { scope, counts: plan.counts };
}

/** Compute the drain-completion signal for a scope (no writes). */
export async function getStoryBackfillDrainSignal(
  scope: BackfillScope,
  deps: BackfillDeps,
): Promise<DrainSignal> {
  const candidates = await deps.scanCandidates(scope);
  const live = await deps.liveStoryIds(
    scope.customerId,
    liveLookupIds(candidates),
  );
  return computeDrainSignal(scope, candidates, live);
}

// ---------------------------------------------------------------------------
// Real DB deps (SQL); covered by story-backfill.db.test
// ---------------------------------------------------------------------------

function windowStartIso(
  windowDays: number | null,
  nowMs: number,
): string | null {
  if (windowDays === null) return null;
  return new Date(nowMs - windowDays * 24 * 60 * 60 * 1000).toISOString();
}

/**
 * Build the production `BackfillDeps` backed by the auth pool and each
 * customer's runtime pool. `nowMs` is injectable for deterministic tests.
 */
export function createBackfillDeps(
  authPool: Pool = getAuthPool(),
  nowMs: number = Date.now(),
): BackfillDeps {
  const nowIso = new Date(nowMs).toISOString();
  return {
    async scanCandidates(scope) {
      const since = windowStartIso(scope.windowDays, nowMs);
      // Candidates are existing analyses: a `(story_id, lang)` pair that
      // already has at least one job row (any model). The LEFT JOIN resolves
      // the TARGET-variant job for the requested `(modelName, model)`.
      const res = await authPool.query<{
        story_id: string;
        lang: string;
        state_status: StateStatus;
        target_status: JobStatus | null;
        target_dry_run: boolean;
      }>(
        `SELECT st.story_id::text          AS story_id,
                j.lang                      AS lang,
                st.status                   AS state_status,
                tgt.status                  AS target_status,
                COALESCE(tgt.dry_run, FALSE) AS target_dry_run
           FROM story_analysis_state st
           JOIN LATERAL (
                  SELECT DISTINCT lang
                    FROM story_analysis_job
                   WHERE customer_id = st.customer_id
                     AND story_id = st.story_id
                ) j ON TRUE
           LEFT JOIN story_analysis_job tgt
                  ON tgt.customer_id = st.customer_id
                 AND tgt.story_id    = st.story_id
                 AND tgt.lang        = j.lang
                 AND tgt.model_name  = $2
                 AND tgt.model       = $3
          WHERE st.customer_id = $1
            AND st.status IN ('ready', 'dirty', 'archived')
            AND ($4::timestamptz IS NULL OR st.last_member_at >= $4::timestamptz)
          ORDER BY st.last_member_at DESC NULLS LAST, st.story_id, j.lang`,
        [scope.customerId, scope.modelName, scope.model, since],
      );
      return res.rows.map((r) => ({
        storyId: r.story_id,
        lang: r.lang,
        stateStatus: r.state_status,
        targetStatus: r.target_status,
        targetDryRun: r.target_dry_run,
      }));
    },

    async liveStoryIds(customerId, storyIds) {
      if (storyIds.length === 0) return new Set<string>();
      // The live `story` row lives in the customer DB (mirror the single
      // regenerate route's source-availability check), batched for the whole
      // scope rather than one query per story.
      const customerPool = getCustomerRuntimePool(customerId);
      const res = await customerPool.query<{ story_id: string }>(
        `SELECT DISTINCT story_id::text AS story_id
           FROM story
          WHERE story_id = ANY($1::bigint[])`,
        [storyIds],
      );
      return new Set(res.rows.map((r) => r.story_id));
    },

    async seedJob(customerId, storyId, lang, modelName, model) {
      // Coalescing seed: a row that appeared since the scan (a race) is left
      // untouched (DO NOTHING), never force-bumped. No force metadata — this
      // is explicitly NOT the regenerate force path.
      await authPool.query(
        `INSERT INTO story_analysis_job
           (customer_id, story_id, lang, model_name, model,
            status, generation, dry_run, attempts, last_error,
            created_at, updated_at)
         VALUES ($1, $2::bigint, $3, $4, $5,
                 'queued', 1, FALSE, 0, NULL,
                 $6::timestamptz, $6::timestamptz)
         ON CONFLICT (customer_id, story_id, lang, model_name, model)
         DO NOTHING`,
        [customerId, storyId, lang, modelName, model, nowIso],
      );
    },

    async requeueJob(customerId, storyId, lang, modelName, model) {
      // Requeue at the SAME generation (no bump, no force). The WHERE guard
      // keeps this idempotent under a race: only a still-failed/dry-run row
      // is reset, so a row another writer just completed is not clobbered.
      await authPool.query(
        `UPDATE story_analysis_job
            SET status = 'queued',
                dry_run = FALSE,
                attempts = 0,
                last_error = NULL,
                processing_started_at = NULL,
                updated_at = $6::timestamptz
          WHERE customer_id = $1 AND story_id = $2::bigint
            AND lang = $3 AND model_name = $4 AND model = $5
            AND (status = 'failed' OR dry_run = TRUE)`,
        [customerId, storyId, lang, modelName, model, nowIso],
      );
    },
  };
}

/**
 * Emit the audit record for a completed backfill run. Best-effort (the
 * `auditLog` helper itself swallows write failures), mirroring the
 * fire-and-forget pattern used by the default-model setters.
 */
export function auditBackfillRun(
  authContext: "general" | "admin",
  accountId: string,
  result: BackfillRunResult,
  meta?: { ipAddress?: string; sid?: string },
): void {
  void auditLog({
    actorId: accountId,
    authContext,
    action: "story_reanalysis.backfill_enqueued",
    targetType: "story_analysis_job",
    targetId: result.scope.customerId,
    customerId: result.scope.customerId,
    ipAddress: meta?.ipAddress,
    sid: meta?.sid,
    details: {
      scope: {
        customerId: result.scope.customerId,
        modelName: result.scope.modelName,
        model: result.scope.model,
        windowDays: result.scope.windowDays,
        cap: result.scope.cap,
      },
      counts: result.counts,
    },
  });
}
