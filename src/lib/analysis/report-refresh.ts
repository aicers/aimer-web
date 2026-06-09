// Operator-triggered report-variant refresh (#469).
//
// After a per-customer default-model change (#473), the story-leaf (#466)
// and event-leaf (#470) backfills re-analyze the underlying leaves under
// the new model. But an existing periodic-report `done` variant — keyed by
// `(tz, lang, model_name, model)` within its `(customer, period,
// bucket_date)` — still AGGREGATES the OLD leaf set until it is regenerated
// (`report-input-builder.ts` MAXes severity/likelihood/priority_tier over
// the report-model subset of both story and event leaves). This module
// REFRESHES scoped report variants — a `generation` bump on
// `periodic_report_job`, the force-regenerate primitive — so the existing
// periodic-report worker re-aggregates the freshly re-analyzed leaves.
//
// It is deliberately a REFRESH, not a coalesce: an existing `done` report
// over the OLD leaf set is stale, not current, so `enqueueOnDemandReportJob`
// (which coalesces `done`) would never refresh it. The single force
// regenerate endpoint bumps `generation` UNCONDITIONALLY (operator-force,
// no cap); the BULK refresh here must instead enforce its own
// `generation < MAX_GENERATION` cap and a `status NOT IN
// ('queued','processing')` dedup so a capped variant is reported as capped
// (not bumped past the cap) and an in-flight variant is skipped.
//
// ORDERING GATE (Scope §3): a variant must not be refreshed while its
// underlying story OR event leaves are still on the old model — it would
// re-aggregate the old set and advance nothing. Each candidate variant is
// gated on the #466 (story) and #470 (event) drain-completion signals over
// the variant's OWN per-period aggregation window (LIVE 24h / DAILY 1d /
// WEEKLY 7d / MONTHLY 1 calendar month — `report-input-builder.ts`
// `resolveWindows`), NOT the flat enqueue-recency window. The story side
// uses the SAME window-overlap selection as `report-input-builder.ts`
// (`time_window_start < curEnd AND time_window_end > curStart`), not #466's
// `last_member_at >= since` recent-window shortcut.
//
// Unlike the leaf backfills there is NO background re-analysis worker: a
// refresh is a generation bump that the EXISTING periodic-report worker
// drains, so a run executes SYNCHRONOUSLY at confirm-time. The run and its
// per-variant outcomes are persisted (see `report-refresh-store.ts`) so the
// refreshed-vs-skipped breakdown survives across requests (Scope §5).
//
// SERVER-ONLY. Reads the auth DB (report state/job rows + story state/job)
// and each customer's runtime DB (leaf universe + live story windows).

import "server-only";

import type { Pool, PoolClient } from "pg";
import { getCurrentTimestamp } from "@/lib/instrumentation/time";
import { loadUniverse, type TargetVariant } from "./event-leaf-backfill";
import { tallyDrain } from "./event-leaf-drain";
import type { PeriodicPeriod } from "./report-input-builder";
import { type CandidateLeaf, classifyDrain } from "./story-backfill";

/**
 * Conservative enqueue-recency default (Scope §4): when no time scope is
 * given the refresh only considers report buckets whose `bucket_date` is
 * within this many days, so a no-scope run never refreshes all history.
 * This is DISTINCT from the per-variant drain-gate window (§3), which is
 * derived from each variant's period and may span far more than this.
 */
export const DEFAULT_WINDOW_DAYS = 7;

/** Largest accepted recent-window so a run can never silently span history. */
export const MAX_WINDOW_DAYS = 365;

/** All report periods, in scope-default order (LIVE first = freshest). */
export const ALL_PERIODS: PeriodicPeriod[] = [
  "LIVE",
  "DAILY",
  "WEEKLY",
  "MONTHLY",
];

// Mirrors `MAX_GENERATION` in `report-worker.ts` (env `ANALYSIS_MAX_GENERATION`,
// default 50). Duplicated as a small constant rather than imported so this
// gate path — and its unit tests — do not pull the whole report worker
// (graphql / redaction / translation) dependency graph. The bulk enqueue
// SQL enforces this cap itself (Scope §6).
const DEFAULT_MAX_GENERATION = 50;
export const MAX_GENERATION = (() => {
  const raw = process.env.ANALYSIS_MAX_GENERATION;
  if (!raw) return DEFAULT_MAX_GENERATION;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : DEFAULT_MAX_GENERATION;
})();

/** Periodic-report job lifecycle statuses (matches the CHECK constraint). */
export type ReportJobStatus = "queued" | "processing" | "done" | "failed";

/** Periodic-report state lifecycle statuses (matches the CHECK constraint). */
type ReportStateStatus = "pending" | "ready" | "dirty" | "archived";

/**
 * The scope of a refresh run / preview. `windowDays` is the enqueue-recency
 * bound on which report buckets are considered; `periods` restricts which
 * periods; `tz` optionally restricts to one timezone variant; `maxVariants`
 * optionally caps how many variants a single run refreshes.
 */
export interface RefreshScope {
  customerId: string;
  windowDays: number;
  periods: PeriodicPeriod[];
  tz: string | null;
  maxVariants: number | null;
}

// ---------------------------------------------------------------------------
// Pure classification (unit-testable without a DB)
// ---------------------------------------------------------------------------

/** The final per-variant outcome a run reports (Scope §5 — no silent caps). */
export type RefreshOutcome =
  | "refreshed"
  | "capped"
  | "gated"
  | "already_queued"
  | "source_unavailable"
  | "limited";

/**
 * The per-variant outcome BEFORE the per-run cap is applied. `refreshable`
 * is the only one the cap can turn into `refreshed` or `limited`; every
 * other pre-cap outcome is final (a capped / gated / in-flight / swept
 * variant is never a refresh write, so the cap never touches it).
 */
export type PreCapOutcome = Exclude<RefreshOutcome, "refreshed" | "limited">;

export interface ClassifyInput {
  /** The parent report-state row is `archived` (source swept). */
  stateArchived: boolean;
  /** The target-variant job status, or `null` when no job row exists yet. */
  jobStatus: ReportJobStatus | null;
  /** The target-variant job generation, or `null` when no job row exists. */
  jobGeneration: number | null;
  maxGeneration: number;
  /** Whether the variant's story leaves are drained over its window. */
  storyDrained: boolean;
  /** Whether the variant's event leaves are drained over its window. */
  eventDrained: boolean;
}

/**
 * Classify one candidate variant into its pre-cap outcome. Precedence:
 *   1. archived parent state → `source_unavailable` (cannot refresh).
 *   2. target job `queued`/`processing` → `already_queued` (intra-run dedup
 *      / in-flight skip; never double-bump).
 *   3. target job `generation >= MAX_GENERATION` → `capped` (the bulk path
 *      reports it, never bumps past the cap — unlike the single force path).
 *   4. story OR event leaves not drained over the variant's window → `gated`
 *      (refreshing would re-aggregate the old leaf set, advancing nothing).
 *   5. otherwise → `refreshable` (a generation bump / seed will refresh it).
 */
export function classifyPreCap(
  input: ClassifyInput,
): PreCapOutcome | "refreshable" {
  if (input.stateArchived) return "source_unavailable";
  if (input.jobStatus === "queued" || input.jobStatus === "processing") {
    return "already_queued";
  }
  if (
    input.jobGeneration != null &&
    input.jobGeneration >= input.maxGeneration
  ) {
    return "capped";
  }
  if (!input.storyDrained || !input.eventDrained) return "gated";
  return "refreshable";
}

/** The variant key + its resolved anchored gate window + pre-cap outcome. */
export interface VariantEvaluation {
  period: PeriodicPeriod;
  bucketDate: string;
  tz: string;
  lang: string;
  modelName: string;
  model: string;
  /** The per-variant anchored aggregation window the gate checked (ISO). */
  windowStart: string;
  windowEnd: string;
  preOutcome: PreCapOutcome | "refreshable";
}

/** Per-outcome aggregate counts (Scope §5). */
export interface RefreshCounts {
  totalVariants: number;
  refreshed: number;
  capped: number;
  gated: number;
  alreadyQueued: number;
  sourceUnavailable: number;
  limited: number;
}

/** One planned variant with its FINAL outcome (post-cap). */
export interface PlannedVariant extends VariantEvaluation {
  outcome: RefreshOutcome;
  /** The resulting generation after a `refreshed` bump/seed (else absent). */
  generation?: number;
}

export interface RefreshPlan {
  counts: RefreshCounts;
  variants: PlannedVariant[];
}

const PRECAP_TO_COUNT: Record<PreCapOutcome, keyof RefreshCounts> = {
  capped: "capped",
  gated: "gated",
  already_queued: "alreadyQueued",
  source_unavailable: "sourceUnavailable",
};

/**
 * Apply the per-run cap to evaluated variants. `refreshable` variants are
 * taken in order (the candidate enumeration is freshest-first), the first
 * `cap` become `refreshed` and the remainder `limited`; every other pre-cap
 * outcome passes through unchanged. The cap NEVER limits a non-refresh
 * outcome, so a bounded run still reports every gated / capped / swept
 * variant in full (no silent caps).
 */
export function planRefresh(
  evals: VariantEvaluation[],
  cap: number | null,
): RefreshPlan {
  const counts: RefreshCounts = {
    totalVariants: evals.length,
    refreshed: 0,
    capped: 0,
    gated: 0,
    alreadyQueued: 0,
    sourceUnavailable: 0,
    limited: 0,
  };
  const variants: PlannedVariant[] = [];
  let refreshedSoFar = 0;
  for (const ev of evals) {
    if (ev.preOutcome !== "refreshable") {
      counts[PRECAP_TO_COUNT[ev.preOutcome]] += 1;
      variants.push({ ...ev, outcome: ev.preOutcome });
      continue;
    }
    if (cap !== null && refreshedSoFar >= cap) {
      counts.limited += 1;
      variants.push({ ...ev, outcome: "limited" });
      continue;
    }
    refreshedSoFar += 1;
    counts.refreshed += 1;
    variants.push({ ...ev, outcome: "refreshed" });
  }
  return { counts, variants };
}

// ---------------------------------------------------------------------------
// DB access — candidate enumeration, anchored gate, bulk enqueue
// ---------------------------------------------------------------------------

interface StateRow {
  period: PeriodicPeriod;
  bucketDate: string;
  tz: string;
  status: ReportStateStatus;
}

/**
 * Enumerate the in-scope report-state rows for a customer, freshest-first
 * (LIVE first, then most recent bucket). A DATED bucket is in scope when its
 * `bucket_date` is within the enqueue-recency window; LIVE is always in
 * scope (it represents the trailing-24h "now" bucket).
 */
async function enumerateStateRows(
  authPool: Pool | PoolClient,
  scope: RefreshScope,
  windowStartDate: string,
): Promise<StateRow[]> {
  const { rows } = await authPool.query<{
    period: PeriodicPeriod;
    bucket_date: string;
    tz: string;
    status: ReportStateStatus;
  }>(
    `SELECT period,
            to_char(bucket_date, 'YYYY-MM-DD') AS bucket_date,
            tz,
            status
       FROM periodic_report_state
      WHERE subject_id = $1
        AND period = ANY($2::text[])
        AND (period = 'LIVE' OR bucket_date >= $3::date)
        AND ($4::text IS NULL OR tz = $4)
      ORDER BY CASE WHEN period = 'LIVE' THEN 0 ELSE 1 END,
               bucket_date DESC, tz`,
    [scope.customerId, scope.periods, windowStartDate, scope.tz],
  );
  return rows.map((r) => ({
    period: r.period,
    bucketDate: r.bucket_date,
    tz: r.tz,
    status: r.status,
  }));
}

/**
 * Look up the target-variant `periodic_report_job` row (status + generation)
 * for dedup / cap classification, or `null` when no job row exists yet (the
 * refresh will seed a fresh generation-1 variant).
 */
async function lookupJob(
  authPool: Pool | PoolClient,
  customerId: string,
  state: StateRow,
  target: TargetVariant,
): Promise<{ status: ReportJobStatus; generation: number } | null> {
  const { rows } = await authPool.query<{
    status: ReportJobStatus;
    generation: number;
  }>(
    `SELECT status, generation
       FROM periodic_report_job
      WHERE subject_id = $1 AND period = $2 AND bucket_date = $3::date
        AND tz = $4 AND lang = $5 AND model_name = $6 AND model = $7`,
    [
      customerId,
      state.period,
      state.bucketDate,
      state.tz,
      target.lang,
      target.modelName,
      target.model,
    ],
  );
  return rows[0] ?? null;
}

interface AnchoredWindow {
  curStart: Date;
  curEnd: Date;
}

/**
 * Resolve a variant's anchored aggregation window — the SAME per-period
 * window `report-input-builder.ts` `resolveWindows` selects leaves over
 * (LIVE trailing 24h ending now; DAILY 1 day; WEEKLY 7 days; MONTHLY 1
 * calendar month — anchored at `bucket_date` in `tz`). The tz / interval
 * math is done in Postgres so DST and offset rules match the report builder.
 * The query touches no tables, so it runs on any pool.
 */
async function resolveAnchoredWindow(
  pool: Pool | PoolClient,
  period: PeriodicPeriod,
  bucketDate: string,
  tz: string,
  nowIso: string,
): Promise<AnchoredWindow> {
  const { rows } = await pool.query<{ cur_start: Date; cur_end: Date }>(
    `SELECT
       CASE WHEN $1 = 'LIVE'
            THEN $4::timestamptz - INTERVAL '24 hours'
            ELSE ($2::date)::timestamp AT TIME ZONE $3 END AS cur_start,
       CASE WHEN $1 = 'LIVE'
            THEN $4::timestamptz
            ELSE ($2::date + (CASE $1
                    WHEN 'WEEKLY'  THEN INTERVAL '7 days'
                    WHEN 'MONTHLY' THEN INTERVAL '1 month'
                    ELSE INTERVAL '1 day' END))::timestamp
                 AT TIME ZONE $3 END AS cur_end`,
    [period, bucketDate, tz, nowIso],
  );
  return { curStart: rows[0].cur_start, curEnd: rows[0].cur_end };
}

/**
 * Whether the variant's EVENT leaves are drained over its anchored window.
 * Reuses the #470 `loadUniverse` over the variant's window (NOT the flat
 * enqueue window) and the shared `tallyDrain`: drained ⇔ no in-window event
 * leaf lacks a non-superseded target-variant leaf (source-swept excluded).
 */
async function isEventDrained(
  customerPool: Pool,
  window: AnchoredWindow,
  target: TargetVariant,
): Promise<boolean> {
  const members = await loadUniverse(
    customerPool,
    { windowStart: window.curStart, windowEnd: window.curEnd },
    target,
  );
  return tallyDrain(members).outstanding === 0;
}

/**
 * Whether the variant's STORY leaves are drained over its anchored window.
 *
 * Uses the SAME window-overlap selection as `report-input-builder.ts`
 * (`time_window_start < curEnd AND time_window_end > curStart`) rather than
 * #466's `last_member_at >= since` recent-window shortcut (Scope §3): for an
 * old WEEKLY/MONTHLY bucket those are different questions, and only overlap
 * matches what the report actually aggregates.
 *
 * Two steps across the DB boundary (mirroring the #466 deps): (1) the live
 * `story` rows overlapping the window come from the customer DB (also the
 * source-availability signal — a swept story has no row, so it cannot block
 * the gate); (2) their state + target-variant job status come from the auth
 * DB. A story whose only existing analysis is in another `lang` is not part
 * of this variant's universe (the report selector is strict on `lang`).
 */
async function isStoryDrained(
  authPool: Pool | PoolClient,
  customerPool: Pool,
  customerId: string,
  window: AnchoredWindow,
  target: TargetVariant,
): Promise<boolean> {
  const { rows: storyRows } = await customerPool.query<{ story_id: string }>(
    `SELECT DISTINCT story_id::text AS story_id
       FROM story
      WHERE time_window_start < $1::timestamptz
        AND time_window_end   > $2::timestamptz`,
    [window.curEnd.toISOString(), window.curStart.toISOString()],
  );
  const overlapIds = storyRows.map((r) => r.story_id);
  if (overlapIds.length === 0) return true;

  // Candidate leaves: overlapping stories that already have a `lang`
  // analysis (so there is a leaf to re-run), with their target-variant job
  // status resolved. Mirrors #466's `scanCandidates`, but selected by the
  // overlap-derived id set rather than a recent-window predicate.
  const { rows: leafRows } = await authPool.query<{
    story_id: string;
    state_status: ReportStateStatus;
    target_status: ReportJobStatus | null;
    target_dry_run: boolean;
  }>(
    `SELECT st.story_id::text          AS story_id,
            st.status                   AS state_status,
            tgt.status                  AS target_status,
            COALESCE(tgt.dry_run, FALSE) AS target_dry_run
       FROM story_analysis_state st
       LEFT JOIN story_analysis_job tgt
              ON tgt.customer_id = st.customer_id
             AND tgt.story_id    = st.story_id
             AND tgt.lang        = $3
             AND tgt.model_name  = $4
             AND tgt.model       = $5
      WHERE st.customer_id = $1
        AND st.story_id = ANY($2::bigint[])
        AND EXISTS (
              SELECT 1 FROM story_analysis_job j
               WHERE j.customer_id = st.customer_id
                 AND j.story_id    = st.story_id
                 AND j.lang        = $3
            )`,
    [customerId, overlapIds, target.lang, target.modelName, target.model],
  );
  // Every selected story has a live `story` row, so it is source-present;
  // `classifyDrain` still maps an `archived` state to `source_unavailable`
  // (excluded from outstanding). Outstanding ⇒ not drained.
  for (const r of leafRows) {
    const leaf: CandidateLeaf = {
      storyId: r.story_id,
      lang: target.lang,
      stateStatus: r.state_status,
      targetStatus: r.target_status,
      targetDryRun: r.target_dry_run,
    };
    const category = classifyDrain(leaf, true);
    if (category !== "drained" && category !== "source_unavailable") {
      return false;
    }
  }
  return true;
}

/**
 * Evaluate every in-scope candidate variant: resolve its anchored window,
 * classify dedup/cap from its job row, and gate on both leaf drain signals.
 * Read-only — no writes. The expensive drain queries run ONLY when an
 * earlier branch (archived / in-flight / capped) has not already decided the
 * outcome, so a fully in-flight scope costs no drain queries.
 */
export async function evaluateCandidates(
  authPool: Pool | PoolClient,
  customerPool: Pool,
  scope: RefreshScope,
  target: TargetVariant,
  nowIso: string,
): Promise<VariantEvaluation[]> {
  const now = new Date(nowIso);
  const windowStartDate = new Date(
    now.getTime() - scope.windowDays * 24 * 60 * 60 * 1000,
  )
    .toISOString()
    .slice(0, 10);
  const states = await enumerateStateRows(authPool, scope, windowStartDate);
  const out: VariantEvaluation[] = [];
  for (const state of states) {
    const window = await resolveAnchoredWindow(
      authPool,
      state.period,
      state.bucketDate,
      state.tz,
      nowIso,
    );
    const base = {
      period: state.period,
      bucketDate: state.bucketDate,
      tz: state.tz,
      lang: target.lang,
      modelName: target.modelName,
      model: target.model,
      windowStart: window.curStart.toISOString(),
      windowEnd: window.curEnd.toISOString(),
    };

    if (state.status === "archived") {
      out.push({ ...base, preOutcome: "source_unavailable" });
      continue;
    }
    const job = await lookupJob(authPool, scope.customerId, state, target);
    if (job && (job.status === "queued" || job.status === "processing")) {
      out.push({ ...base, preOutcome: "already_queued" });
      continue;
    }
    if (job && job.generation >= MAX_GENERATION) {
      out.push({ ...base, preOutcome: "capped" });
      continue;
    }
    // Only now pay for the leaf-drain gate queries.
    const eventDrained = await isEventDrained(customerPool, window, target);
    const storyDrained = eventDrained
      ? await isStoryDrained(
          authPool,
          customerPool,
          scope.customerId,
          window,
          target,
        )
      : false;
    const preOutcome = classifyPreCap({
      stateArchived: false,
      jobStatus: job?.status ?? null,
      jobGeneration: job?.generation ?? null,
      maxGeneration: MAX_GENERATION,
      storyDrained,
      eventDrained,
    });
    out.push({ ...base, preOutcome });
  }
  return out;
}

/**
 * Bulk-refresh one variant: the force-regenerate UPSERT
 * (`regenerate/route.ts`) plus the two guards the single force path omits —
 * `generation < MAX_GENERATION` and `status NOT IN ('queued','processing')`
 * on the UPDATE branch (Scope §6). The INSERT branch seeds a fresh
 * generation-1 queued variant; the guarded UPDATE branch bumps an existing
 * one. Returns the resulting `generation`, or `null` when the guard blocked
 * the bump (a concurrent writer queued/capped it after evaluation) — the
 * caller then records it as `already_queued` rather than `refreshed`, so a
 * race can never over-report a refresh.
 */
async function refreshVariant(
  authClient: PoolClient,
  customerId: string,
  variant: VariantEvaluation,
  createdBy: string,
): Promise<number | null> {
  const { rows } = await authClient.query<{ generation: number }>(
    `INSERT INTO periodic_report_job
       (subject_id, period, bucket_date, tz, lang, model_name, model,
        status, generation, dry_run,
        force_requested_at, force_requested_by,
        attempts, last_error)
     VALUES ($1, $2, $3::date, $4, $5, $6, $7,
             'queued', 1, FALSE,
             NOW(), $8::uuid,
             0, NULL)
     ON CONFLICT (subject_id, period, bucket_date, tz, lang, model_name, model)
     DO UPDATE SET
       generation         = periodic_report_job.generation + 1,
       status             = 'queued',
       dry_run            = FALSE,
       force_requested_at = NOW(),
       force_requested_by = EXCLUDED.force_requested_by,
       attempts           = 0,
       last_error         = NULL,
       processing_started_at = NULL,
       next_due_at        = NULL,
       updated_at         = NOW()
     WHERE periodic_report_job.generation < $9
       AND periodic_report_job.status NOT IN ('queued', 'processing')
     RETURNING generation`,
    [
      customerId,
      variant.period,
      variant.bucketDate,
      variant.tz,
      variant.lang,
      variant.modelName,
      variant.model,
      createdBy,
      MAX_GENERATION,
    ],
  );
  return rows[0]?.generation ?? null;
}

export interface RefreshExecution {
  counts: RefreshCounts;
  variants: PlannedVariant[];
}

/**
 * Preview a refresh: evaluate + plan, NO writes (the required cost preview,
 * Scope §7). Returns the per-outcome counts and the per-variant breakdown.
 */
export async function previewReportRefresh(
  authPool: Pool,
  customerPool: Pool,
  scope: RefreshScope,
  target: TargetVariant,
  now: Date = getCurrentTimestamp(),
): Promise<RefreshExecution> {
  const evals = await evaluateCandidates(
    authPool,
    customerPool,
    scope,
    target,
    now.toISOString(),
  );
  const plan = planRefresh(evals, scope.maxVariants);
  return { counts: plan.counts, variants: plan.variants };
}

/**
 * Execute a refresh: evaluate + plan, then perform the guarded generation
 * bump for every `refreshed` variant on a single auth-DB connection. Returns
 * the final plan with each refreshed variant's resulting `generation` filled
 * in; a variant the guard blocked (raced to queued/capped) is downgraded to
 * `already_queued` so the persisted counts never over-report. The caller
 * persists the returned plan via `report-refresh-store.ts`.
 */
export async function executeReportRefresh(
  authClient: PoolClient,
  customerPool: Pool,
  scope: RefreshScope,
  target: TargetVariant,
  createdBy: string,
  now: Date = getCurrentTimestamp(),
): Promise<RefreshExecution> {
  const evals = await evaluateCandidates(
    authClient,
    customerPool,
    scope,
    target,
    now.toISOString(),
  );
  const plan = planRefresh(evals, scope.maxVariants);
  const counts = { ...plan.counts };
  const variants: PlannedVariant[] = [];
  for (const v of plan.variants) {
    if (v.outcome !== "refreshed") {
      variants.push(v);
      continue;
    }
    const generation = await refreshVariant(
      authClient,
      scope.customerId,
      v,
      createdBy,
    );
    if (generation == null) {
      // The guard blocked the bump (a concurrent writer beat us). Re-report
      // as already_queued so the refreshed count stays honest.
      counts.refreshed -= 1;
      counts.alreadyQueued += 1;
      variants.push({ ...v, outcome: "already_queued" });
      continue;
    }
    variants.push({ ...v, generation });
  }
  return { counts, variants };
}
