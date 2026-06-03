// RFC 0002 Phase 2 (#297) — periodic report input builder.
//
// Given a `(customer, period, bucket_date, tz)` window and a report
// variant `(lang, model_name, model)`, this module deterministically
// assembles the structured `inputs` bundle for aimer's
// `generatePeriodicSecurityReport` mutation plus everything aimer-web
// stores alongside the LLM narrative:
//
//   - Top stories: eligible `story_analysis_result` leaves (variant +
//     freshness filtered) joined to the canonical `story` row whose time
//     window overlaps the bucket, ordered by priority tier then score.
//   - Top events: `event_analysis_result` leaves (variant filtered)
//     joined to a deduped `baseline_event` view for the bucket-window
//     `event_time`, excluding `(aice_id, event_key)` already covered by
//     the chosen stories' members (RFC 0002 §"Dedup across Phase 1 and
//     Phase 2").
//   - Baseline aggregates: deduped `baseline_event` counts + category
//     distribution for the current and previous periods → drift signals
//     (`baseline-drift.ts`).
//   - Token rewrite to report scope (`report-token.ts`).
//   - Provenance (`input_story_refs` / `input_event_refs` carrying
//     `generation`), the `input_hash`, aggregate scores / tags, and the
//     report `priority_tier` (max leaf tier vs baseline-drift matrix).
//
// Cross-DB note: story *freshness* (`story_analysis_state.status =
// 'ready'`) lives in the auth DB while the result/story rows live in the
// customer DB. The two cannot be JOINed, so the builder first reads the
// ready story-id set from auth, then filters the customer-side selection
// to it.

import "server-only";

import { createHash } from "node:crypto";
import type { Pool } from "pg";
import type {
  BaselineCountInput,
  EventAnalysisInput,
  PeriodicReportInputs,
  StoryAnalysisInput,
} from "@/lib/graphql/__generated__/generate-periodic-security-report";
import {
  type BaselineDrift,
  type CategoryCount,
  computeBaselineDrift,
} from "./baseline-drift";
import {
  computePriorityTier,
  maxTier,
  type PriorityTier,
} from "./priority-tier";
import { buildReportTokenMap, type ReportTokenRef } from "./report-token";

export type PeriodicPeriod = "LIVE" | "DAILY" | "WEEKLY" | "MONTHLY";

export interface ReportVariant {
  tz: string;
  lang: string;
  modelName: string;
  model: string;
}

export interface BuildReportInputArgs {
  authPool: Pool;
  customerPool: Pool;
  customerId: string;
  period: PeriodicPeriod;
  /** `YYYY-MM-DD`; the synthetic `1970-01-01` for LIVE. */
  bucketDate: string;
  variant: ReportVariant;
  /** Tick "now" (time seam) — used for LIVE trailing-window math. */
  nowIso: string;
  topStoriesK?: number;
  topEventsK?: number;
}

export type RedactionPolicyResult =
  | { kind: "ok"; version: string }
  | { kind: "baseline-only" }
  | { kind: "missing" }
  | { kind: "mismatched" };

export interface StoryRef {
  story_id: string;
  generation: number;
}

export interface EventRef {
  aice_id: string;
  event_key: string;
  generation: number;
}

export interface PeriodicReportBuildResult {
  /** Structured bundle passed verbatim to aimer. */
  aimerInputs: PeriodicReportInputs;
  storyRefs: StoryRef[];
  eventRefs: EventRef[];
  /** Per-leaf report-scope token demap (persist-with-row, drives display). */
  tokenRefs: ReportTokenRef[];
  inputHash: string;
  aggregateTtpTags: string[];
  aggregateSeverityScore: number;
  aggregateLikelihoodScore: number;
  priorityTier: PriorityTier;
  drift: BaselineDrift;
  redaction: RedactionPolicyResult;
  /** Distinct source aice_ids across the consumed leaves (audit context). */
  sourceAiceIds: string[];
  /** `YYYY-MM-DD` in the customer tz to pass as aimer's `date` arg. */
  reportDate: string;
}

interface StoryLeafRow {
  story_id: string;
  generation: number;
  severity_score: number;
  likelihood_score: number;
  priority_tier: PriorityTier;
  ttp_tags: string[];
  severity_factors: string[];
  likelihood_factors: string[];
  analysis_text: string;
  redaction_policy_version: string;
  source_aice_id: string;
  /** Canonical story window bounds → aimer's `timeRangeStart`/`timeRangeEnd`. */
  time_window_start: Date;
  time_window_end: Date;
}

interface EventLeafRow {
  aice_id: string;
  event_key: string;
  generation: number;
  severity_score: number;
  likelihood_score: number;
  priority_tier: PriorityTier;
  ttp_tags: string[];
  severity_factors: string[];
  likelihood_factors: string[];
  analysis_text: string;
  redaction_policy_version: string;
  /** Deduped baseline `event_time` → aimer's `eventTime`. */
  event_time: Date;
}

const TIER_RANK_SQL = `(CASE priority_tier
    WHEN 'CRITICAL' THEN 3 WHEN 'HIGH' THEN 2
    WHEN 'MEDIUM' THEN 1 ELSE 0 END)`;

// Cap on the `topTechniques` / `topSensors` baseline-aggregate lists sent
// to aimer. The prompt renders these as a leaderboard, so a small bound
// keeps the payload compact and deterministic.
const TOP_AGGREGATE_K = 10;

// Dedupe `baseline_event` to one canonical row per (source_aice_id,
// event_key) — latest received baseline wins — BEFORE any window
// predicate. Shared verbatim by every window aggregate so the window test
// always runs against the canonical row's `event_time` (RFC 0002 round-14
// item 2): filtering inside the dedupe could pick an older in-window
// duplicate even when the canonical latest row is out-of-window.
const LATEST_BASELINE_CTE = `WITH latest_baseline AS (
       SELECT DISTINCT ON (source_aice_id, event_key)
              source_aice_id, event_key, event_time, category, primary_asset
         FROM baseline_event
        ORDER BY source_aice_id, event_key, received_at DESC, baseline_version DESC
     )`;

interface Windows {
  curStart: Date;
  curEnd: Date;
  prevStart: Date;
  prevEnd: Date;
  /** `YYYY-MM-DD` in the customer tz for the aimer `date` render arg. */
  reportDate: string;
}

/**
 * Resolve the current and previous period windows in the customer
 * timezone. DAILY uses the calendar day in `tz` (and the prior day);
 * WEEKLY uses the 7-day window anchored at `bucket_date` (vs the prior
 * 7 days); MONTHLY uses the calendar month anchored at `bucket_date`
 * (vs the prior calendar month — `date - INTERVAL '1 month'` honors
 * variable month lengths); LIVE uses a trailing 24h ending at `nowIso`
 * (vs the prior 24h). The window length is selected per period so the
 * input builder feeds the same `PeriodicReportInputs` shape over the
 * longer WEEKLY/MONTHLY windows (#298 F2 resolution — comparative
 * framing is prompt-side only, no prior-period feed). The tz / interval
 * math is done in Postgres so DST and offset rules match the readiness
 * tick (`analysis-job-worker.ts`).
 */
async function resolveWindows(
  customerPool: Pool,
  period: PeriodicPeriod,
  bucketDate: string,
  tz: string,
  nowIso: string,
): Promise<Windows> {
  const { rows } = await customerPool.query<{
    cur_start: Date;
    cur_end: Date;
    prev_start: Date;
    prev_end: Date;
    report_date: string;
  }>(
    // The per-period window length mirrors the bucket-end math in the
    // readiness tick (`analysis-job-worker.ts`): DAILY 1 day, WEEKLY
    // 7 days, MONTHLY 1 calendar month.
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
                 AT TIME ZONE $3 END AS cur_end,
       CASE WHEN $1 = 'LIVE'
            THEN $4::timestamptz - INTERVAL '48 hours'
            ELSE ($2::date - (CASE $1
                    WHEN 'WEEKLY'  THEN INTERVAL '7 days'
                    WHEN 'MONTHLY' THEN INTERVAL '1 month'
                    ELSE INTERVAL '1 day' END))::timestamp
                 AT TIME ZONE $3 END AS prev_start,
       CASE WHEN $1 = 'LIVE'
            THEN $4::timestamptz - INTERVAL '24 hours'
            ELSE ($2::date)::timestamp AT TIME ZONE $3 END AS prev_end,
       CASE WHEN $1 = 'LIVE'
            THEN to_char($4::timestamptz AT TIME ZONE $3, 'YYYY-MM-DD')
            ELSE $2::text END AS report_date`,
    [period, bucketDate, tz, nowIso],
  );
  const r = rows[0];
  return {
    curStart: r.cur_start,
    curEnd: r.cur_end,
    prevStart: r.prev_start,
    prevEnd: r.prev_end,
    reportDate: r.report_date,
  };
}

async function loadReadyStoryIds(
  authPool: Pool,
  customerId: string,
): Promise<string[]> {
  const { rows } = await authPool.query<{ story_id: string }>(
    `SELECT story_id::text AS story_id
       FROM story_analysis_state
      WHERE customer_id = $1 AND status = 'ready'`,
    [customerId],
  );
  return rows.map((r) => r.story_id);
}

async function selectTopStories(
  customerPool: Pool,
  args: {
    customerId: string;
    variant: ReportVariant;
    readyStoryIds: string[];
    windows: Windows;
    limit: number;
  },
): Promise<StoryLeafRow[]> {
  if (args.readyStoryIds.length === 0) return [];
  const { rows } = await customerPool.query<StoryLeafRow>(
    `WITH canonical_story AS (
       SELECT DISTINCT ON (story_id)
              story_id, story_version, source_aice_id,
              time_window_start, time_window_end
         FROM story
        WHERE story_id = ANY($1::bigint[])
        ORDER BY story_id, received_at DESC, story_version DESC
     )
     SELECT r.story_id::text AS story_id,
            r.generation,
            r.severity_score, r.likelihood_score,
            r.priority_tier,
            r.ttp_tags, r.severity_factors, r.likelihood_factors,
            r.analysis_text, r.redaction_policy_version,
            cs.source_aice_id,
            cs.time_window_start, cs.time_window_end
       FROM story_analysis_result r
       JOIN canonical_story cs ON cs.story_id = r.story_id
      WHERE r.customer_id = $2
        AND r.lang = $3 AND r.model_name = $4 AND r.model = $5
        AND r.superseded_at IS NULL
        AND cs.time_window_start < $7::timestamptz
        AND cs.time_window_end   > $6::timestamptz
      ORDER BY ${TIER_RANK_SQL.replaceAll("priority_tier", "r.priority_tier")} DESC,
               (r.severity_score + r.likelihood_score) DESC,
               r.story_id ASC
      LIMIT $8`,
    [
      args.readyStoryIds,
      args.customerId,
      args.variant.lang,
      args.variant.modelName,
      args.variant.model,
      args.windows.curStart,
      args.windows.curEnd,
      args.limit,
    ],
  );
  return rows;
}

async function loadStoryMemberKeys(
  customerPool: Pool,
  storyIds: string[],
): Promise<Array<{ aice_id: string; event_key: string }>> {
  if (storyIds.length === 0) return [];
  // Use the canonical version per story_id so the member set matches the
  // story leaf we actually cited.
  const { rows } = await customerPool.query<{
    aice_id: string;
    event_key: string;
  }>(
    `WITH canonical_story AS (
       SELECT DISTINCT ON (story_id) story_id, story_version, source_aice_id
         FROM story
        WHERE story_id = ANY($1::bigint[])
        ORDER BY story_id, received_at DESC, story_version DESC
     )
     SELECT DISTINCT cs.source_aice_id AS aice_id,
                     sm.member_event_key::text AS event_key
       FROM canonical_story cs
       JOIN story_member sm
         ON sm.story_id = cs.story_id
        AND sm.story_version = cs.story_version`,
    [storyIds],
  );
  return rows;
}

async function selectTopEvents(
  customerPool: Pool,
  args: {
    variant: ReportVariant;
    windows: Windows;
    covered: Array<{ aice_id: string; event_key: string }>;
    limit: number;
  },
): Promise<EventLeafRow[]> {
  const coveredAice = args.covered.map((c) => c.aice_id);
  const coveredKey = args.covered.map((c) => c.event_key);
  const { rows } = await customerPool.query<EventLeafRow>(
    // Dedupe baseline_event to one canonical row per (source_aice_id,
    // event_key) FIRST (no window predicate inside the CTE), THEN apply
    // the bucket-window predicate to the canonical row's event_time. The
    // issue locks this order (round-14 item 2): filtering before the
    // dedupe could select an older in-window duplicate even when the
    // canonical latest row's event_time is outside the bucket.
    `WITH latest_baseline AS (
       SELECT DISTINCT ON (source_aice_id, event_key)
              source_aice_id, event_key, event_time
         FROM baseline_event
        ORDER BY source_aice_id, event_key, received_at DESC, baseline_version DESC
     )
     SELECT e.aice_id,
            e.event_key::text AS event_key,
            e.generation,
            e.severity_score, e.likelihood_score,
            e.priority_tier,
            e.ttp_tags, e.severity_factors, e.likelihood_factors,
            e.analysis_text, e.redaction_policy_version,
            lb.event_time
       FROM event_analysis_result e
       JOIN latest_baseline lb
         ON lb.source_aice_id = e.aice_id AND lb.event_key = e.event_key
      WHERE e.lang = $1 AND e.model_name = $2 AND e.model = $3
        AND e.superseded_at IS NULL
        AND lb.event_time >= $4::timestamptz AND lb.event_time < $5::timestamptz
        AND NOT EXISTS (
          SELECT 1
            FROM unnest($6::text[], $7::numeric[]) AS c(a, k)
           WHERE c.a = e.aice_id AND c.k = e.event_key
        )
      ORDER BY ${TIER_RANK_SQL.replaceAll("priority_tier", "e.priority_tier")} DESC,
               (e.severity_score + e.likelihood_score) DESC,
               e.aice_id ASC, e.event_key ASC
      LIMIT $8`,
    [
      args.variant.lang,
      args.variant.modelName,
      args.variant.model,
      args.windows.curStart,
      args.windows.curEnd,
      coveredAice,
      coveredKey,
      args.limit,
    ],
  );
  return rows;
}

async function categoryCounts(
  customerPool: Pool,
  start: Date,
  end: Date,
): Promise<CategoryCount[]> {
  // Category distribution over the deduped baseline window. Used only for
  // the internal drift signal now (aimer's `BaselineAggregatesInput` no
  // longer carries a per-category distribution); the dedupe-before-window
  // contract is preserved via the shared CTE.
  const { rows } = await customerPool.query<{
    category: string | null;
    count: number;
  }>(
    `${LATEST_BASELINE_CTE}
     SELECT lb.category, COUNT(*)::int AS count
       FROM latest_baseline lb
      WHERE lb.event_time >= $1::timestamptz AND lb.event_time < $2::timestamptz
      GROUP BY lb.category`,
    [start, end],
  );
  return rows.map((r) => ({ category: r.category, count: r.count }));
}

/**
 * Period-level baseline totals for aimer's `BaselineTotalsInput`: the
 * deduped `baseline_event` count and the distinct host (`primary_asset`)
 * count inside the bucket window. `stories` is sourced separately from the
 * `story` table (see `storyCountInWindow`).
 */
async function windowBaselineTotals(
  customerPool: Pool,
  start: Date,
  end: Date,
): Promise<{ events: number; hosts: number }> {
  const { rows } = await customerPool.query<{
    events: number;
    hosts: number;
  }>(
    `${LATEST_BASELINE_CTE}
     SELECT COUNT(*)::int AS events,
            COUNT(DISTINCT lb.primary_asset)::int AS hosts
       FROM latest_baseline lb
      WHERE lb.event_time >= $1::timestamptz AND lb.event_time < $2::timestamptz`,
    [start, end],
  );
  const r = rows[0];
  return { events: r?.events ?? 0, hosts: r?.hosts ?? 0 };
}

/**
 * Top sensors (`source_aice_id`) by deduped baseline-event count inside the
 * bucket window → aimer's `BaselineAggregatesInput.topSensors`. Ordered by
 * count desc then key asc so the payload — and the order-sensitive
 * `input_hash` over it — is stable across plans/runs.
 */
async function topSensors(
  customerPool: Pool,
  start: Date,
  end: Date,
  limit: number,
): Promise<BaselineCountInput[]> {
  const { rows } = await customerPool.query<{
    key: string;
    count: number;
  }>(
    `${LATEST_BASELINE_CTE}
     SELECT lb.source_aice_id AS key, COUNT(*)::int AS count
       FROM latest_baseline lb
      WHERE lb.event_time >= $1::timestamptz AND lb.event_time < $2::timestamptz
      GROUP BY lb.source_aice_id
      ORDER BY COUNT(*) DESC, lb.source_aice_id ASC
      LIMIT $3`,
    [start, end, limit],
  );
  return rows.map((r) => ({ key: r.key, count: r.count }));
}

/**
 * Count of canonical stories whose time window overlaps the bucket window →
 * aimer's `BaselineTotalsInput.stories`. Mirrors `selectTopStories`'
 * canonical-version pin and overlap predicate, but unfiltered by variant or
 * freshness — it is a period-level count of all stories in the window, not
 * only the cited Top-stories.
 */
async function storyCountInWindow(
  customerPool: Pool,
  start: Date,
  end: Date,
): Promise<number> {
  const { rows } = await customerPool.query<{ stories: number }>(
    `WITH canonical_story AS (
       SELECT DISTINCT ON (story_id)
              story_id, time_window_start, time_window_end
         FROM story
        ORDER BY story_id, received_at DESC, story_version DESC
     )
     SELECT COUNT(*)::int AS stories
       FROM canonical_story cs
      WHERE cs.time_window_start < $2::timestamptz
        AND cs.time_window_end   > $1::timestamptz`,
    [start, end],
  );
  return rows[0]?.stories ?? 0;
}

/**
 * Top techniques (MITRE technique IDs) by occurrence across the cited story
 * and event leaves → aimer's `BaselineAggregatesInput.topTechniques`.
 * `baseline_event` carries no technique tags, so the leaf `ttp_tags` are the
 * only in-window technique source. Ordered by count desc then ID asc for a
 * stable payload.
 */
function topTechniques(
  ttpTagLists: ReadonlyArray<ReadonlyArray<string>>,
  limit: number,
): BaselineCountInput[] {
  const counts = new Map<string, number>();
  for (const tags of ttpTagLists) {
    for (const tag of tags) {
      counts.set(tag, (counts.get(tag) ?? 0) + 1);
    }
  }
  return Array.from(counts.entries())
    .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
    .slice(0, limit)
    .map(([key, count]) => ({ key, count }));
}

function resolveRedactionPolicy(versions: string[]): RedactionPolicyResult {
  if (versions.length === 0) return { kind: "baseline-only" };
  let version: string | null = null;
  for (const v of versions) {
    if (typeof v !== "string" || v === "") return { kind: "missing" };
    if (version === null) version = v;
    else if (v !== version) return { kind: "mismatched" };
  }
  return { kind: "ok", version: version as string };
}

function dedupeSorted(values: ReadonlyArray<string>): string[] {
  return Array.from(new Set(values)).sort();
}

/**
 * Deterministic JSON serialization with object keys sorted recursively so
 * the same logical value always serializes to the same string regardless of
 * key insertion order. Arrays keep their order — callers sort arrays whose
 * ordering is not semantically meaningful before passing them in.
 */
function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value) ?? "null";
  }
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(",")}]`;
  }
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries
    .map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`)
    .join(",")}}`;
}

/**
 * `input_hash` over the canonical input bundle. Earlier this hashed only
 * period/bucket/variant + provenance refs + baseline counts/drift, which
 * missed input-*builder* drift: a change to token rewriting, factor
 * formatting, or aggregation would produce a different LLM payload under
 * identical refs yet the same hash, defeating the column's purpose (#297
 * review round 3, item 3). It now hashes the deterministic, key-sorted
 * serialization of the actual `aimerInputs` payload sent to aimer PLUS the
 * variant identity `(period, bucket_date, tz, lang, model_name, model)` and
 * the generation-stamped provenance refs (sorted canonically), so two
 * worker instances building the same bundle hash identically while any
 * change to the produced payload changes the hash.
 *
 * (Refs carry `generation` and leaf rows are immutable per generation —
 * round-14 item 1 — so identical refs already imply identical leaf content;
 * the payload term is what additionally captures code/builder drift.)
 */
function computeInputHash(args: {
  period: string;
  bucketDate: string;
  variant: ReportVariant;
  storyRefs: StoryRef[];
  eventRefs: EventRef[];
  aimerInputs: PeriodicReportInputs;
}): string {
  const storyRefs = [...args.storyRefs].sort(
    (a, b) =>
      a.story_id.localeCompare(b.story_id) || a.generation - b.generation,
  );
  const eventRefs = [...args.eventRefs].sort(
    (a, b) =>
      a.aice_id.localeCompare(b.aice_id) ||
      a.event_key.localeCompare(b.event_key) ||
      a.generation - b.generation,
  );
  const canonical = {
    period: args.period,
    bucket_date: args.bucketDate,
    tz: args.variant.tz,
    lang: args.variant.lang,
    model_name: args.variant.modelName,
    model: args.variant.model,
    story_refs: storyRefs,
    event_refs: eventRefs,
    aimer_inputs: args.aimerInputs,
  };
  return createHash("sha256").update(stableStringify(canonical)).digest("hex");
}

export async function buildPeriodicReportInput(
  args: BuildReportInputArgs,
): Promise<PeriodicReportBuildResult> {
  const topStoriesK = args.topStoriesK ?? 5;
  const topEventsK = args.topEventsK ?? 10;

  const windows = await resolveWindows(
    args.customerPool,
    args.period,
    args.bucketDate,
    args.variant.tz,
    args.nowIso,
  );

  // --- Top stories (variant + freshness + window overlap) -------------
  const readyStoryIds = await loadReadyStoryIds(args.authPool, args.customerId);
  const stories = await selectTopStories(args.customerPool, {
    customerId: args.customerId,
    variant: args.variant,
    readyStoryIds,
    windows,
    limit: topStoriesK,
  });

  // --- Top events (exclude story-covered (aice_id, event_key)) --------
  const covered = await loadStoryMemberKeys(
    args.customerPool,
    stories.map((s) => s.story_id),
  );
  const events = await selectTopEvents(args.customerPool, {
    variant: args.variant,
    windows,
    covered,
    limit: topEventsK,
  });

  return assembleReportInput(
    {
      customerPool: args.customerPool,
      period: args.period,
      bucketDate: args.bucketDate,
      variant: args.variant,
    },
    windows,
    stories,
    events,
  );
}

/**
 * Build the full `PeriodicReportBuildResult` from an already-selected set
 * of story / event leaves — everything downstream of leaf selection
 * (token rewrite, baseline aggregates, drift, aggregations, provenance,
 * `input_hash`). Shared by the default top-K selection path
 * (`buildPeriodicReportInput`) and the canonical-ref-pinned path
 * (`buildCanonicalPinnedReportInput`); the two differ ONLY in how the
 * leaves are chosen, so this keeps token numbering / hashing identical.
 */
async function assembleReportInput(
  ctx: {
    customerPool: Pool;
    period: PeriodicPeriod;
    bucketDate: string;
    variant: ReportVariant;
  },
  windows: Windows,
  stories: StoryLeafRow[],
  events: EventLeafRow[],
): Promise<PeriodicReportBuildResult> {
  // --- Baseline aggregates + drift ------------------------------------
  const currentCounts = await categoryCounts(
    ctx.customerPool,
    windows.curStart,
    windows.curEnd,
  );
  const previousCounts = await categoryCounts(
    ctx.customerPool,
    windows.prevStart,
    windows.prevEnd,
  );
  const drift = computeBaselineDrift(currentCounts, previousCounts);

  // Period-level baseline totals for aimer's `BaselineTotalsInput` +
  // `topSensors`. `events`/`hosts` come from the deduped baseline window;
  // `stories` from the canonical story set overlapping the window.
  const baselineTotals = await windowBaselineTotals(
    ctx.customerPool,
    windows.curStart,
    windows.curEnd,
  );
  const storyTotal = await storyCountInWindow(
    ctx.customerPool,
    windows.curStart,
    windows.curEnd,
  );
  const sensors = await topSensors(
    ctx.customerPool,
    windows.curStart,
    windows.curEnd,
    TOP_AGGREGATE_K,
  );

  // --- Redaction policy precondition (consumed leaves only) -----------
  const leafPolicyVersions = [
    ...stories.map((s) => s.redaction_policy_version),
    ...events.map((e) => e.redaction_policy_version),
  ];
  const redaction = resolveRedactionPolicy(leafPolicyVersions);

  // --- Token rewrite to report scope ----------------------------------
  // Feed each leaf's analysis AND its factor arrays through the per-leaf
  // token map so a scope token that defensively appears in a factor is
  // folded to report scope too, not passed through to the prompt raw
  // (#297 review round 1, item 2).
  const {
    rewrittenStoryTexts,
    rewrittenEventTexts,
    rewrittenStoryFactors,
    rewrittenEventFactors,
    refs,
    allowedTokens,
  } = buildReportTokenMap(
    stories.map((s) => ({
      analysis: s.analysis_text,
      severityFactors: s.severity_factors,
      likelihoodFactors: s.likelihood_factors,
    })),
    events.map((e) => ({
      analysis: e.analysis_text,
      severityFactors: e.severity_factors,
      likelihoodFactors: e.likelihood_factors,
    })),
  );
  void allowedTokens; // the scan re-derives from refs at hallucination time

  // --- Aggregations ----------------------------------------------------
  const aggregateTtpTags = dedupeSorted([
    ...stories.flatMap((s) => s.ttp_tags),
    ...events.flatMap((e) => e.ttp_tags),
  ]);

  const leafTiers: PriorityTier[] = [
    ...stories.map((s) => s.priority_tier),
    ...events.map((e) => e.priority_tier),
  ];
  const driftTier = computePriorityTier(drift.severity, drift.likelihood);
  const priorityTier = maxTier(...leafTiers, driftTier);

  const aggregateSeverityScore = Math.max(
    drift.severity,
    ...stories.map((s) => s.severity_score),
    ...events.map((e) => e.severity_score),
    0,
  );
  const aggregateLikelihoodScore = Math.max(
    drift.likelihood,
    ...stories.map((s) => s.likelihood_score),
    ...events.map((e) => e.likelihood_score),
    0,
  );

  // --- Structured aimer inputs ----------------------------------------
  // Mapped to aimer's real SDL shape (schemas/aimer.graphql @ f04caba):
  // `StoryAnalysisInput` / `EventAnalysisInput` carry a single JSON/markdown
  // `sections` narrative (the report-scope-rewritten leaf analysis) plus the
  // leaf's nullable scores, factor arrays, and TTP tags — no `priorityTier`
  // (kept internal for aggregation, not part of the wire shape).
  const storyAnalyses: StoryAnalysisInput[] = stories.map((s, i) => ({
    storyId: s.story_id,
    timeRangeStart: s.time_window_start.toISOString(),
    timeRangeEnd: s.time_window_end.toISOString(),
    sections: rewrittenStoryTexts[i],
    severityScore: s.severity_score,
    likelihoodScore: s.likelihood_score,
    severityFactors: rewrittenStoryFactors[i].severityFactors,
    likelihoodFactors: rewrittenStoryFactors[i].likelihoodFactors,
    ttpTags: s.ttp_tags,
  }));
  const eventAnalyses: EventAnalysisInput[] = events.map((e, i) => ({
    // `eventRef` is opaque/reference-only on aimer's side, but it must still
    // uniquely identify the event: `event_key` is only unique within an
    // `aice_id` (RFC 0001 §"member_event_key"; RFC 0002's dedup key is
    // `(aice_id, event_key)`), so a bare key collides across AICE sources
    // that share a numeric event key in one report window. Encode the same
    // `${aice_id}:${event_key}` composite the codebase already uses as the
    // event-identity key (report token restore, dedup) so the narrative's
    // event references stay unambiguous and check cleanly against
    // `input_event_refs`.
    eventRef: `${e.aice_id}:${e.event_key}`,
    eventTime: e.event_time.toISOString(),
    sections: rewrittenEventTexts[i],
    severityScore: e.severity_score,
    likelihoodScore: e.likelihood_score,
    severityFactors: rewrittenEventFactors[i].severityFactors,
    likelihoodFactors: rewrittenEventFactors[i].likelihoodFactors,
    ttpTags: e.ttp_tags,
  }));

  const aimerInputs: PeriodicReportInputs = {
    storyAnalyses,
    eventAnalyses,
    baselineAggregates: {
      windowStart: windows.curStart.toISOString(),
      windowEnd: windows.curEnd.toISOString(),
      totals: {
        events: baselineTotals.events,
        stories: storyTotal,
        hosts: baselineTotals.hosts,
      },
      // Techniques aggregated from the cited leaves (baseline_event has no
      // TTP tags); sensors from the deduped baseline window.
      topTechniques: topTechniques(
        [...stories.map((s) => s.ttp_tags), ...events.map((e) => e.ttp_tags)],
        TOP_AGGREGATE_K,
      ),
      topSensors: sensors,
    },
    aggregateTtpTags,
  };

  const storyRefs: StoryRef[] = stories.map((s) => ({
    story_id: s.story_id,
    generation: s.generation,
  }));
  const eventRefs: EventRef[] = events.map((e) => ({
    aice_id: e.aice_id,
    event_key: e.event_key,
    generation: e.generation,
  }));

  const inputHash = computeInputHash({
    period: ctx.period,
    bucketDate: ctx.bucketDate,
    variant: ctx.variant,
    storyRefs,
    eventRefs,
    aimerInputs,
  });

  const sourceAiceIds = Array.from(
    new Set([
      ...stories.map((s) => s.source_aice_id),
      ...events.map((e) => e.aice_id),
    ]),
  );

  return {
    aimerInputs,
    storyRefs,
    eventRefs,
    tokenRefs: refs,
    inputHash,
    aggregateTtpTags,
    aggregateSeverityScore,
    aggregateLikelihoodScore,
    priorityTier,
    drift,
    redaction,
    sourceAiceIds,
    reportDate: windows.reportDate,
  };
}

// ---------------------------------------------------------------------------
// Canonical-ref-pinned input path (#389 PR #3 / #412)
// ---------------------------------------------------------------------------

export interface CanonicalPinnedBuildArgs {
  customerPool: Pool;
  period: PeriodicPeriod;
  bucketDate: string;
  /** Target variant — `lang` is the non-English language being generated. */
  variant: ReportVariant;
  nowIso: string;
  /** The English canonical's `input_story_refs` (story_id + generation). */
  storyRefs: StoryRef[];
  /** The English canonical's `input_event_refs` (aice_id/event_key + gen). */
  eventRefs: EventRef[];
}

export type CanonicalPinnedBuildResult =
  | { complete: true; built: PeriodicReportBuildResult }
  // At least one cited leaf is missing in the target language at the pinned
  // (story_id/event_key, generation, model_name, model). The caller routes
  // to the translate path instead of native generation.
  | { complete: false };

/**
 * Build a report input for a non-English variant pinned to the EXACT leaf
 * set the English canonical cited (`storyRefs` / `eventRefs`), at the same
 * `(generation, model_name, model)` but the target `lang`. Unlike
 * `buildPeriodicReportInput` it does NOT re-run the top-K selectors
 * (`selectTopStories` / `selectTopEvents`) — those re-query the target
 * lang's own leaves and would diverge from the English first-seen order,
 * breaking the `R{j}` token equivalence the loader and leak scan rely on.
 *
 * Returns `{ complete: false }` when any pinned leaf has no row in the
 * target language at the pinned generation (the completeness gate): the
 * caller then translates the canonical instead of generating natively.
 */
export async function buildCanonicalPinnedReportInput(
  args: CanonicalPinnedBuildArgs,
): Promise<CanonicalPinnedBuildResult> {
  const windows = await resolveWindows(
    args.customerPool,
    args.period,
    args.bucketDate,
    args.variant.tz,
    args.nowIso,
  );

  const stories = await fetchStoryLeavesByRefs(
    args.customerPool,
    args.variant,
    args.storyRefs,
  );
  if (stories === null) return { complete: false };

  const events = await fetchEventLeavesByRefs(
    args.customerPool,
    args.variant,
    args.eventRefs,
  );
  if (events === null) return { complete: false };

  const built = await assembleReportInput(
    {
      customerPool: args.customerPool,
      period: args.period,
      bucketDate: args.bucketDate,
      variant: args.variant,
    },
    windows,
    stories,
    events,
  );
  return { complete: true, built };
}

/**
 * Fetch the target-language story leaves for the pinned refs, returned in
 * the SAME order as `refs` so the report-scope `R{j}` numbering matches the
 * English canonical. Pins each leaf by exact `(story_id, generation)` and
 * the target `(lang, model_name, model)`; does NOT filter `superseded_at`
 * (a generation is immutable, mirroring the page loader's pinned replay).
 * Returns `null` if any ref has no matching target-language leaf.
 */
async function fetchStoryLeavesByRefs(
  customerPool: Pool,
  variant: ReportVariant,
  refs: StoryRef[],
): Promise<StoryLeafRow[] | null> {
  if (refs.length === 0) return [];
  const storyIds = refs.map((r) => r.story_id);
  const generations = refs.map((r) => r.generation);
  const { rows } = await customerPool.query<StoryLeafRow>(
    `WITH canonical_story AS (
       SELECT DISTINCT ON (story_id)
              story_id, story_version, source_aice_id,
              time_window_start, time_window_end
         FROM story
        WHERE story_id = ANY($1::bigint[])
        ORDER BY story_id, received_at DESC, story_version DESC
     )
     SELECT r.story_id::text AS story_id,
            r.generation,
            r.severity_score, r.likelihood_score,
            r.priority_tier,
            r.ttp_tags, r.severity_factors, r.likelihood_factors,
            r.analysis_text, r.redaction_policy_version,
            cs.source_aice_id,
            cs.time_window_start, cs.time_window_end
       FROM story_analysis_result r
       JOIN canonical_story cs ON cs.story_id = r.story_id
       JOIN unnest($1::bigint[], $2::int[]) AS ref(story_id, generation)
         ON ref.story_id = r.story_id AND ref.generation = r.generation
      WHERE r.lang = $3 AND r.model_name = $4 AND r.model = $5`,
    [storyIds, generations, variant.lang, variant.modelName, variant.model],
  );
  return orderByRefs(
    rows,
    refs,
    (row) => `${row.story_id}|${row.generation}`,
    (ref) => `${ref.story_id}|${ref.generation}`,
  );
}

/**
 * Fetch the target-language event leaves for the pinned refs, in `refs`
 * order. Same pinning / no-supersede contract as `fetchStoryLeavesByRefs`.
 * Returns `null` if any ref has no matching target-language leaf (or no
 * deduped baseline row to source `event_time` from).
 */
async function fetchEventLeavesByRefs(
  customerPool: Pool,
  variant: ReportVariant,
  refs: EventRef[],
): Promise<EventLeafRow[] | null> {
  if (refs.length === 0) return [];
  const aiceIds = refs.map((r) => r.aice_id);
  const eventKeys = refs.map((r) => r.event_key);
  const generations = refs.map((r) => r.generation);
  const { rows } = await customerPool.query<EventLeafRow>(
    `WITH latest_baseline AS (
       SELECT DISTINCT ON (source_aice_id, event_key)
              source_aice_id, event_key, event_time
         FROM baseline_event
        ORDER BY source_aice_id, event_key, received_at DESC, baseline_version DESC
     )
     SELECT e.aice_id,
            e.event_key::text AS event_key,
            e.generation,
            e.severity_score, e.likelihood_score,
            e.priority_tier,
            e.ttp_tags, e.severity_factors, e.likelihood_factors,
            e.analysis_text, e.redaction_policy_version,
            lb.event_time
       FROM event_analysis_result e
       JOIN latest_baseline lb
         ON lb.source_aice_id = e.aice_id AND lb.event_key = e.event_key
       JOIN unnest($1::text[], $2::numeric[], $3::int[])
              AS ref(aice_id, event_key, generation)
         ON ref.aice_id = e.aice_id AND ref.event_key = e.event_key
        AND ref.generation = e.generation
      WHERE e.lang = $4 AND e.model_name = $5 AND e.model = $6`,
    [
      aiceIds,
      eventKeys,
      generations,
      variant.lang,
      variant.modelName,
      variant.model,
    ],
  );
  return orderByRefs(
    rows,
    refs,
    (row) => `${row.aice_id}|${row.event_key}|${row.generation}`,
    (ref) => `${ref.aice_id}|${ref.event_key}|${ref.generation}`,
  );
}

/**
 * Re-order fetched leaf rows to match the canonical ref order, returning
 * `null` if any ref is unmatched (the completeness gate). Keying both sides
 * with the same composite makes the result deterministic regardless of the
 * DB's row order.
 */
function orderByRefs<Row, Ref>(
  rows: Row[],
  refs: Ref[],
  rowKey: (row: Row) => string,
  refKey: (ref: Ref) => string,
): Row[] | null {
  const byKey = new Map<string, Row>();
  for (const row of rows) byKey.set(rowKey(row), row);
  const ordered: Row[] = [];
  for (const ref of refs) {
    const row = byKey.get(refKey(ref));
    if (row === undefined) return null;
    ordered.push(row);
  }
  return ordered;
}

/**
 * Reconstruct the report-scope token refs (`ReportTokenRef[]`) for a pinned
 * cited-leaf set by replaying `buildReportTokenMap` over the leaves at the
 * given variant — the same `refs` the loader and leak scan need to validate
 * report-scope `<<REDACTED_*_R{j}_*>>` tokens. Used by the translate path
 * to derive the canonical's `allowedTokens` from its English cited leaves
 * without re-running the full baseline assembly. Returns `null` if any
 * pinned leaf is missing (the caller treats that as an integrity failure).
 */
export async function buildPinnedTokenRefs(
  customerPool: Pool,
  variant: ReportVariant,
  storyRefs: StoryRef[],
  eventRefs: EventRef[],
): Promise<ReportTokenRef[] | null> {
  const stories = await fetchStoryLeavesByRefs(
    customerPool,
    variant,
    storyRefs,
  );
  if (stories === null) return null;
  const events = await fetchEventLeavesByRefs(customerPool, variant, eventRefs);
  if (events === null) return null;
  const { refs } = buildReportTokenMap(
    stories.map((s) => ({
      analysis: s.analysis_text,
      severityFactors: s.severity_factors,
      likelihoodFactors: s.likelihood_factors,
    })),
    events.map((e) => ({
      analysis: e.analysis_text,
      severityFactors: e.severity_factors,
      likelihoodFactors: e.likelihood_factors,
    })),
  );
  return refs;
}

export const __testables = {
  resolveRedactionPolicy,
  computeInputHash,
  dedupeSorted,
};
