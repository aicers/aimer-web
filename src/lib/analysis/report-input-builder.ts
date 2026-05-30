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
  PeriodicEventAnalysisInput,
  PeriodicReportInput,
  PeriodicStoryAnalysisInput,
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

export type PeriodicPeriod = "LIVE" | "DAILY";

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
  aimerInputs: PeriodicReportInput;
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
}

const TIER_RANK_SQL = `(CASE priority_tier
    WHEN 'CRITICAL' THEN 3 WHEN 'HIGH' THEN 2
    WHEN 'MEDIUM' THEN 1 ELSE 0 END)`;

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
 * LIVE uses a trailing 24h ending at `nowIso` (vs the prior 24h). The
 * tz math is done in Postgres so DST and offset rules match the
 * readiness tick (`analysis-job-worker.ts`).
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
    `SELECT
       CASE WHEN $1 = 'LIVE'
            THEN $4::timestamptz - INTERVAL '24 hours'
            ELSE ($2::date)::timestamp AT TIME ZONE $3 END AS cur_start,
       CASE WHEN $1 = 'LIVE'
            THEN $4::timestamptz
            ELSE ($2::date + INTERVAL '1 day')::timestamp AT TIME ZONE $3 END AS cur_end,
       CASE WHEN $1 = 'LIVE'
            THEN $4::timestamptz - INTERVAL '48 hours'
            ELSE ($2::date - INTERVAL '1 day')::timestamp AT TIME ZONE $3 END AS prev_start,
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
            cs.source_aice_id
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
            e.analysis_text, e.redaction_policy_version
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
  // Dedupe to one canonical baseline_event row per (source_aice_id,
  // event_key) BEFORE applying the bucket-window predicate, so a
  // rebaseline that re-emits the same event under a new baseline_version
  // does not inflate the totals AND the window test runs against the
  // canonical row's event_time (RFC 0002 round-14 item 2). Filtering
  // event_time inside the dedupe is unsafe: an older in-window duplicate
  // could be counted even when the canonical latest row is out-of-window.
  const { rows } = await customerPool.query<{
    category: string | null;
    count: number;
  }>(
    `SELECT lb.category, COUNT(*)::int AS count
       FROM (
         SELECT DISTINCT ON (source_aice_id, event_key)
                source_aice_id, event_key, category, event_time
           FROM baseline_event
          ORDER BY source_aice_id, event_key, received_at DESC, baseline_version DESC
       ) lb
      WHERE lb.event_time >= $1::timestamptz AND lb.event_time < $2::timestamptz
      GROUP BY lb.category`,
    [start, end],
  );
  return rows.map((r) => ({ category: r.category, count: r.count }));
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
  aimerInputs: PeriodicReportInput;
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

  // --- Baseline aggregates + drift ------------------------------------
  const currentCounts = await categoryCounts(
    args.customerPool,
    windows.curStart,
    windows.curEnd,
  );
  const previousCounts = await categoryCounts(
    args.customerPool,
    windows.prevStart,
    windows.prevEnd,
  );
  const drift = computeBaselineDrift(currentCounts, previousCounts);
  const totalCount = currentCounts.reduce((acc, c) => acc + c.count, 0);

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
  const storyAnalyses: PeriodicStoryAnalysisInput[] = stories.map((s, i) => ({
    storyId: s.story_id,
    analysis: rewrittenStoryTexts[i],
    severityScore: s.severity_score,
    likelihoodScore: s.likelihood_score,
    severityFactors: rewrittenStoryFactors[i].severityFactors,
    likelihoodFactors: rewrittenStoryFactors[i].likelihoodFactors,
    ttpTags: s.ttp_tags,
    priorityTier: s.priority_tier,
  }));
  const eventAnalyses: PeriodicEventAnalysisInput[] = events.map((e, i) => ({
    aiceId: e.aice_id,
    eventKey: e.event_key,
    analysis: rewrittenEventTexts[i],
    severityScore: e.severity_score,
    likelihoodScore: e.likelihood_score,
    severityFactors: rewrittenEventFactors[i].severityFactors,
    likelihoodFactors: rewrittenEventFactors[i].likelihoodFactors,
    ttpTags: e.ttp_tags,
    priorityTier: e.priority_tier,
  }));

  const aimerInputs: PeriodicReportInput = {
    storyAnalyses,
    eventAnalyses,
    baselineAggregates: {
      totalCount,
      categoryDistribution: currentCounts.map((c) => ({
        category: c.category,
        count: c.count,
      })),
      categoryDeltas: drift.categoryDeltas.map((d) => ({
        category: d.category,
        delta: d.delta,
      })),
      driftSeverity: drift.severity,
      driftLikelihood: drift.likelihood,
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
    period: args.period,
    bucketDate: args.bucketDate,
    variant: args.variant,
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

export const __testables = {
  resolveRedactionPolicy,
  computeInputHash,
  dedupeSorted,
};
