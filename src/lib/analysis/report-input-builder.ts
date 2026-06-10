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
  AnalyzedEventAggregatesInput,
  BaselineCountInput,
  EventAnalysisInput,
  LongTailExemplarInput,
  PeriodicReportInputs,
  StoryAnalysisInput,
} from "@/lib/graphql/__generated__/generate-periodic-security-report";
import { LATEST_BASELINE_CTE } from "./baseline-dedup";
import {
  type BaselineDrift,
  type CategoryCount,
  computeBaselineDrift,
} from "./baseline-drift";
import { type ModelPair, resolveDefaultModel } from "./default-model";
import { getModelCatalog } from "./model-catalog";
import {
  computePriorityTier,
  maxTier,
  type PriorityTier,
  tierRank,
} from "./priority-tier";
import {
  buildReportTokenMap,
  maskFactScopeTokens,
  type ReportLeafText,
  type ReportTokenRef,
} from "./report-token";

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
  /**
   * The `(model_name, model)` of the leaf this ref points at (#465 Scope 3).
   * Under the never-drop fallback a default report can cite a leaf from a
   * non-report model, so each ref records its own model rather than inheriting
   * the report row's.
   */
  model_name: string;
  model: string;
  /**
   * The member subject id of the customer DB this leaf lives in (#523). A
   * group report cites analyzed leaves from MEMBER customer DBs, and the same
   * `story_id` can exist in more than one member DB, so the de-redaction map
   * cannot be routed without it. On the single-customer path it equals the
   * report's own `subject_id`. Note this is the PERSISTED shape — the hash
   * canonical form strips a `customer_id` equal to the subject
   * (`computeInputHash`), and the single-customer WIRE shape omits it (#524).
   */
  customer_id: string;
}

export interface EventRef {
  aice_id: string;
  event_key: string;
  generation: number;
  /** Per-leaf model, same contract as `StoryRef` (#465). */
  model_name: string;
  model: string;
  /** Member subject id, same contract as `StoryRef` (#523). */
  customer_id: string;
}

/**
 * Provenance ref for one long-tail exemplar representative leaf (#495). Pins
 * the exact immutable leaf the report-scope exemplar `R{j}` token was minted
 * from, exactly like {@link EventRef} pins a cited event leaf: replay /
 * restore must resolve the same leaf, and a later generation of the same
 * `(aice_id, event_key, lang, model)` could otherwise re-resolve the exemplar
 * token to different plaintext. Exemplar leaves are inherently English (the
 * canonical owns the set + numbering), so the ref carries no `lang`.
 */
export interface ExemplarRef {
  aice_id: string;
  event_key: string;
  generation: number;
  model_name: string;
  model: string;
  /** Member subject id of the leaf's customer DB, as on {@link StoryRef}. */
  customer_id: string;
}

/**
 * Resolve a WIRE-shaped ref's member customer id (#523/#524). The
 * single-customer wire shape omits `customer_id` by design — only a
 * member-qualified group citation carries it — so an absent id resolves to the
 * report's own `subject_id`. This is symmetric with the `computeInputHash`
 * "omit `customer_id` when it equals the subject" canonicalization. PERSISTED
 * refs always carry `customer_id` and read it directly, never through this.
 */
export function refCustomerId(
  ref: { customer_id?: string },
  subjectId: string,
): string {
  return ref.customer_id ?? subjectId;
}

/**
 * The opaque story citation/wire key shared by the `aimerInputs` source key,
 * the citation guard's allowed set, and the de-redaction loader (#524). Bare
 * `story_id` on the single-customer path (`memberQualified === false`, so
 * citations and `input_hash` are unchanged); member-qualified
 * `customer_id:story_id` on the group path, since the same `story_id` can
 * exist in more than one member DB and the keys must not collide. A single
 * definition keeps the builder's source keys, the guard, and the loader on the
 * exact same key.
 */
export function storyWireKey(
  ref: { story_id: string; customer_id?: string },
  subjectId: string,
  memberQualified: boolean,
): string {
  return memberQualified
    ? `${refCustomerId(ref, subjectId)}:${ref.story_id}`
    : ref.story_id;
}

/**
 * The opaque event citation/wire key, the event analogue of
 * {@link storyWireKey} (#524). Bare `aice_id:event_key` on the single-customer
 * path, member-qualified `customer_id:aice_id:event_key` on the group path.
 */
export function eventWireKey(
  ref: { aice_id: string; event_key: string; customer_id?: string },
  subjectId: string,
  memberQualified: boolean,
): string {
  const base = `${ref.aice_id}:${ref.event_key}`;
  return memberQualified ? `${refCustomerId(ref, subjectId)}:${base}` : base;
}

export interface PeriodicReportBuildResult {
  /** Structured bundle passed verbatim to aimer. */
  aimerInputs: PeriodicReportInputs;
  storyRefs: StoryRef[];
  eventRefs: EventRef[];
  /**
   * Distinct representative leaves of the kept long-tail exemplars (#495),
   * in the SAME order they were appended to the `buildReportTokenMap` leaf
   * set — persisted as `input_exemplar_refs` so replay/restore re-mints the
   * exemplar `R{j}` tokens identically. Empty when no long-tail exists.
   */
  exemplarRefs: ExemplarRef[];
  /**
   * The exact `analyzedEventAggregates` object sent to aimer for this build,
   * or `null` when the universe was empty and the section was omitted (#495).
   * Persisted as `input_analyzed_event_aggregates` so the native-pinned
   * non-English path can reuse the canonical payload verbatim.
   */
  analyzedEventAggregates: AnalyzedEventAggregatesInput | null;
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
  /**
   * The member customer DB this leaf was read from (#524). On the
   * single-customer path it is the subject's own customer id; on the group
   * path it identifies which member DB the leaf came from, so the union
   * top-K tie-break, the member-qualified wire/citation keys, and the
   * persisted ref's `customer_id` all derive from one field. Stamped by the
   * selector caller, not the SQL.
   */
  customer_id: string;
  /** The selected leaf's own model (#465 Scope 2) — surfaced so ref
   *  persistence and the hybrid report-model partition read it without a
   *  re-query. Under the fallback this may differ from the report's model. */
  model_name: string;
  model: string;
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

/**
 * Build a story leaf's report-input text with fact-scope `F{k}` tokens
 * re-masked to a stable placeholder (RFC 0003 C1 #440). A story analysis
 * can carry `F{k}` tokens from injected enrichment facts; the report
 * builder strips them BEFORE the `E{i}`->`R{j}` rewrite so neither a live
 * `F{k}` (the `R{j}` pass cannot renamespace it) nor any customer-asset
 * plaintext reaches the report LLM. Event leaves never carry `F{k}`.
 */
function maskedStoryLeaf(s: {
  analysis_text: string;
  severity_factors: ReadonlyArray<string>;
  likelihood_factors: ReadonlyArray<string>;
}): ReportLeafText {
  return {
    analysis: maskFactScopeTokens(s.analysis_text),
    severityFactors: s.severity_factors.map(maskFactScopeTokens),
    likelihoodFactors: s.likelihood_factors.map(maskFactScopeTokens),
  };
}

interface EventLeafRow {
  aice_id: string;
  event_key: string;
  generation: number;
  /** Member customer DB this leaf was read from (#524). See `StoryLeafRow`. */
  customer_id: string;
  /** The selected leaf's own model (#465 Scope 2). See `StoryLeafRow`. */
  model_name: string;
  model: string;
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

/**
 * Deterministic leaf-selection preference order for a report variant (#465
 * Scope 1 / Scope 7 — never-drop coverage).
 *
 * The report's OWN `(model_name, model)` is always rank 1. For a DEFAULT report
 * (report model == the customer's resolved default, `defaultPair`, from
 * `resolveDefaultModel`) the configured `getModelCatalog()`
 * order then supplies the fallback ranks (report pair removed, since it is
 * already rank 1) so a candidate story/event whose report-model leaf is missing
 * still surfaces from the first available fallback model — never silently
 * dropped. For an ALTERNATE-model report (an analyst A/B variant, #458) the list
 * is JUST the report pair, so selection stays a strict exact-match: the strict
 * path is the degenerate single-entry case of the same preference-ordered
 * query, and fallback can NEVER apply off the default path. `lang` is strict on
 * both paths (a real variant axis, not a fallback axis) — handled by the
 * callers, not here.
 *
 * The catalog order is env-fixed (not data-dependent "most-used"), so the
 * preference order — and therefore the selected leaf set and its `R{j}` token
 * numbering — is stable across regenerations (#465 Scope 9).
 */
function leafPreferenceOrder(
  variant: ReportVariant,
  defaultPair: ModelPair,
): Array<{ modelName: string; model: string }> {
  const reportPair = { modelName: variant.modelName, model: variant.model };
  const isDefaultReport =
    variant.modelName === defaultPair.modelName &&
    variant.model === defaultPair.model;
  if (!isDefaultReport) return [reportPair];
  const order = [reportPair];
  for (const entry of getModelCatalog()) {
    if (
      entry.modelName === reportPair.modelName &&
      entry.model === reportPair.model
    ) {
      continue;
    }
    order.push({ modelName: entry.modelName, model: entry.model });
  }
  return order;
}

// Cap on the `topTechniques` / `topSensors` baseline-aggregate lists sent
// to aimer. The prompt renders these as a leaderboard, so a small bound
// keeps the payload compact and deterministic.
const TOP_AGGREGATE_K = 10;

// The English canonical language. Long-tail exemplar leaves are inherently
// English — the canonical owns the exemplar set + `R{j}` numbering, so the
// native-pinned non-English path re-fetches them at this language regardless
// of the row's target `lang` (#495).
const DEFAULT_LANG = "ENGLISH";

// The canonical `baseline_event` dedup CTE (latest received baseline wins,
// deduped BEFORE any window predicate — RFC 0002 round-14 item 2). Extracted
// to `baseline-dedup.ts` and imported so every window aggregate here, and the
// group cost preview (#511), share the exact same dedup SQL.

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
    defaultPair: ModelPair;
    readyStoryIds: string[];
    windows: Windows;
    limit: number;
  },
): Promise<StoryLeafRow[]> {
  if (args.readyStoryIds.length === 0) return [];
  const pref = leafPreferenceOrder(args.variant, args.defaultPair);
  const prefModelNames = pref.map((p) => p.modelName);
  const prefModels = pref.map((p) => p.model);
  // Two-phase, deliberately NOT collapsed (#465 Scope 1):
  //   (a) `ranked` — per story, DISTINCT ON picks the single rank-1 leaf across
  //       all non-superseded rows by the preference order (catalog rank, then
  //       newest generation as a stable inner tie-break). `lang` stays strict.
  //   (b) the outer query then applies the existing tier/score/story_id top-K
  //       ordering over that one-leaf-per-story set.
  // Mixing the per-leaf preference ordering into the final top-K ORDER BY in one
  // pass would break both the per-candidate pick and the top-K result.
  const { rows } = await customerPool.query<StoryLeafRow>(
    `WITH canonical_story AS (
       SELECT DISTINCT ON (story_id)
              story_id, story_version, source_aice_id,
              time_window_start, time_window_end
         FROM story
        WHERE story_id = ANY($1::bigint[])
        ORDER BY story_id, received_at DESC, story_version DESC
     ),
     pref AS (
       SELECT model_name, model, rank
         FROM unnest($4::text[], $5::text[])
              WITH ORDINALITY AS u(model_name, model, rank)
     ),
     ranked AS (
       SELECT DISTINCT ON (r.story_id)
              r.story_id,
              r.generation, r.model_name, r.model,
              r.severity_score, r.likelihood_score,
              r.priority_tier,
              r.ttp_tags, r.severity_factors, r.likelihood_factors,
              r.analysis_text, r.redaction_policy_version,
              cs.source_aice_id,
              cs.time_window_start, cs.time_window_end
         FROM story_analysis_result r
         JOIN canonical_story cs ON cs.story_id = r.story_id
         JOIN pref p ON p.model_name = r.model_name AND p.model = r.model
        WHERE r.customer_id = $2
          AND r.lang = $3
          AND r.superseded_at IS NULL
          AND cs.time_window_start < $7::timestamptz
          AND cs.time_window_end   > $6::timestamptz
        ORDER BY r.story_id, p.rank ASC, r.generation DESC
     )
     SELECT rk.story_id::text AS story_id,
            rk.generation, rk.model_name, rk.model,
            rk.severity_score, rk.likelihood_score,
            rk.priority_tier,
            rk.ttp_tags, rk.severity_factors, rk.likelihood_factors,
            rk.analysis_text, rk.redaction_policy_version,
            rk.source_aice_id,
            rk.time_window_start, rk.time_window_end
       FROM ranked rk
      ORDER BY ${TIER_RANK_SQL.replaceAll("priority_tier", "rk.priority_tier")} DESC,
               (rk.severity_score + rk.likelihood_score) DESC,
               rk.story_id ASC
      LIMIT $8`,
    [
      args.readyStoryIds,
      args.customerId,
      args.variant.lang,
      prefModelNames,
      prefModels,
      args.windows.curStart,
      args.windows.curEnd,
      args.limit,
    ],
  );
  // Stamp the member id (#524): the SQL is scoped to one `customer_id`, so
  // every returned leaf belongs to it. On the group path the caller runs this
  // per member; the field then drives the union tie-break and ref identity.
  return rows.map((r) => ({ ...r, customer_id: args.customerId }));
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

// Shared per-event leaf selection (#495). The `ranked` CTE picks the single
// rank-1 leaf per (aice_id, event_key) across the preference order, scoped to
// the variant `lang`, `superseded_at IS NULL`, the bucket window on the
// deduped `latest_baseline.event_time`, and the story-covered exclusion. The
// CITED query (`selectTopEvents`) and the UNIVERSE query
// (`selectUniverseEvents`) differ by EXACTLY the citation floor + `LIMIT M` —
// this is the `cited ⊆ universe` invariant that keeps the partition exact and
// `analyzedCount = citedCount + (universe − cited)` true by construction. Both
// bind the same positional params `$1..$7` (lang, pref names, pref models,
// curStart, curEnd, coveredAice, coveredKey); the cited query adds `$8` = M.
//
// Dedupe baseline_event to one canonical row per (source_aice_id, event_key)
// FIRST (no window predicate inside the CTE), THEN apply the bucket-window
// predicate to the canonical row's event_time (round-14 item 2): filtering
// before the dedupe could select an older in-window duplicate even when the
// canonical latest row's event_time is outside the bucket. Origin-agnostic by
// the `baseline_event` join — no `origin` filter — so `auto_baseline` leaves
// are in-universe by the join (Scope 1).
const EVENT_RANKED_CTE = `WITH latest_baseline AS (
       SELECT DISTINCT ON (source_aice_id, event_key)
              source_aice_id, event_key, event_time
         FROM baseline_event
        ORDER BY source_aice_id, event_key, received_at DESC, baseline_version DESC
     ),
     pref AS (
       SELECT model_name, model, rank
         FROM unnest($2::text[], $3::text[])
              WITH ORDINALITY AS u(model_name, model, rank)
     ),
     ranked AS (
       SELECT DISTINCT ON (e.aice_id, e.event_key)
              e.aice_id, e.event_key,
              e.generation, e.model_name, e.model,
              e.severity_score, e.likelihood_score,
              e.priority_tier,
              e.ttp_tags, e.severity_factors, e.likelihood_factors,
              e.analysis_text, e.redaction_policy_version,
              lb.event_time
         FROM event_analysis_result e
         JOIN latest_baseline lb
           ON lb.source_aice_id = e.aice_id AND lb.event_key = e.event_key
         JOIN pref p ON p.model_name = e.model_name AND p.model = e.model
        WHERE e.lang = $1
          AND e.superseded_at IS NULL
          AND lb.event_time >= $4::timestamptz AND lb.event_time < $5::timestamptz
          AND NOT EXISTS (
            SELECT 1
              FROM unnest($6::text[], $7::numeric[]) AS c(a, k)
             WHERE c.a = e.aice_id AND c.k = e.event_key
          )
        ORDER BY e.aice_id, e.event_key, p.rank ASC, e.generation DESC
     )`;

// Full leaf projection off the shared `ranked` CTE (aliased `rk`). Shared by
// both the cited and universe selects so they return identical `EventLeafRow`
// columns.
const RANKED_LEAF_COLUMNS = `rk.aice_id,
            rk.event_key::text AS event_key,
            rk.generation, rk.model_name, rk.model,
            rk.severity_score, rk.likelihood_score,
            rk.priority_tier,
            rk.ttp_tags, rk.severity_factors, rk.likelihood_factors,
            rk.analysis_text, rk.redaction_policy_version,
            rk.event_time`;

function rankedCteParams(args: {
  variant: ReportVariant;
  defaultPair: ModelPair;
  windows: Windows;
  covered: Array<{ aice_id: string; event_key: string }>;
}): unknown[] {
  const pref = leafPreferenceOrder(args.variant, args.defaultPair);
  return [
    args.variant.lang,
    pref.map((p) => p.modelName),
    pref.map((p) => p.model),
    args.windows.curStart,
    args.windows.curEnd,
    args.covered.map((c) => c.aice_id),
    args.covered.map((c) => c.event_key),
  ];
}

async function selectTopEvents(
  customerPool: Pool,
  args: {
    customerId: string;
    variant: ReportVariant;
    defaultPair: ModelPair;
    windows: Windows;
    covered: Array<{ aice_id: string; event_key: string }>;
    limit: number;
  },
): Promise<EventLeafRow[]> {
  // Citation-cut policy (#494): the outer query gates the chosen-per-event
  // leaves to the citation floor `priority_tier IN ('CRITICAL', 'HIGH',
  // 'MEDIUM')` alongside `LIMIT M`. Because the ORDER BY is tier-first, this
  // (a) guarantees every CRITICAL/HIGH leaf is cited up to `M`, (b) fills any
  // remaining slots with MEDIUM by the same ranking, and (c) never pads with
  // LOW on a quiet window. When CRITICAL/HIGH exceed `M`, the top-`M` are
  // cited and the overflow stays recoverable as (full-set CRITICAL/HIGH) −
  // (cited CRITICAL/HIGH) for #495's long-tail.
  //
  // The floor predicate MUST stay in the OUTER query, NOT pushed into the
  // `ranked` CTE: that CTE picks one leaf per (aice_id, event_key) by model
  // preference, and filtering LOW before the pick would drop a report-model
  // LOW leaf and let a fallback-model higher-tier leaf win that event,
  // breaking #465's cross-model leaf-selection contract.
  const { rows } = await customerPool.query<EventLeafRow>(
    `${EVENT_RANKED_CTE}
     SELECT ${RANKED_LEAF_COLUMNS}
       FROM ranked rk
      WHERE rk.priority_tier IN ('CRITICAL', 'HIGH', 'MEDIUM')
      ORDER BY ${TIER_RANK_SQL.replaceAll("priority_tier", "rk.priority_tier")} DESC,
               (rk.severity_score + rk.likelihood_score) DESC,
               rk.aice_id ASC, rk.event_key ASC
      LIMIT $8`,
    [...rankedCteParams(args), args.limit],
  );
  return rows.map((r) => ({ ...r, customer_id: args.customerId }));
}

/**
 * The non-story-covered analyzed-in-window UNIVERSE (#495 Scope 1): every
 * ranked per-event leaf the shared `EVENT_RANKED_CTE` selects, MINUS the
 * citation floor and the `LIMIT M`. Because it reuses the exact same `ranked`
 * CTE as `selectTopEvents`, the cited set is a strict subset
 * (`cited ⊆ universe`), so `uncited = universe − cited` is exact and
 * `analyzedCount = citedCount + uncitedCount` holds by construction. Returns
 * the full leaf columns the aggregates need (tier / scores / ttp_tags /
 * factors / analysis / redaction policy). A stable `(aice_id, event_key)`
 * order keeps the result deterministic.
 */
async function selectUniverseEvents(
  customerPool: Pool,
  args: {
    customerId: string;
    variant: ReportVariant;
    defaultPair: ModelPair;
    windows: Windows;
    covered: Array<{ aice_id: string; event_key: string }>;
  },
): Promise<EventLeafRow[]> {
  const { rows } = await customerPool.query<EventLeafRow>(
    `${EVENT_RANKED_CTE}
     SELECT ${RANKED_LEAF_COLUMNS}
       FROM ranked rk
      ORDER BY rk.aice_id ASC, rk.event_key ASC`,
    rankedCteParams(args),
  );
  return rows.map((r) => ({ ...r, customer_id: args.customerId }));
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

// ---------------------------------------------------------------------------
// Long-tail analyzed-event aggregates (#495 Scope 1/2)
// ---------------------------------------------------------------------------

// The factor sentinel the score-factor filter emits when nothing survives
// (`factor-filter.ts`). An exemplar's `factor` falls back from
// `severity_factors[0]` to `likelihood_factors[0]` when severity is this
// sentinel, so the long-tail narrative is grounded in a real factor phrase.
const INSUFFICIENT_EVIDENCE_SENTINEL = "insufficient evidence";

// Hard cap on the number of technique-clustered exemplars sent to aimer
// (#495 Scope 2). Beyond this the top clusters are kept and truncation is
// logged (never silent).
const LONG_TAIL_EXEMPLAR_CAP = 10;

// Canonical tier order (high → low) for the `tierDistribution` payload, so its
// element order — and the `input_hash` over it — is stable across runs.
const TIER_ORDER: readonly PriorityTier[] = [
  "CRITICAL",
  "HIGH",
  "MEDIUM",
  "LOW",
];

/** The single `factor` phrase an exemplar surfaces from its representative
 *  leaf: `severity_factors[0]`, falling back to `likelihood_factors[0]` when
 *  severity is the `"insufficient evidence"` sentinel (or absent). The string
 *  still carries event-scope redaction tokens; the caller rewrites it to
 *  report scope. */
function chooseExemplarFactor(leaf: {
  severity_factors: ReadonlyArray<string>;
  likelihood_factors: ReadonlyArray<string>;
}): string {
  const sev = leaf.severity_factors[0];
  if (sev !== undefined && sev !== INSUFFICIENT_EVIDENCE_SENTINEL) return sev;
  const lik = leaf.likelihood_factors[0];
  if (lik !== undefined) return lik;
  return sev ?? "";
}

/** Tier makeup of a leaf set, in canonical high→low order, dropping tiers
 *  with no members so the payload carries only present tiers. */
function tierDistribution(
  leaves: ReadonlyArray<EventLeafRow>,
): BaselineCountInput[] {
  const counts = new Map<PriorityTier, number>();
  for (const leaf of leaves) {
    counts.set(leaf.priority_tier, (counts.get(leaf.priority_tier) ?? 0) + 1);
  }
  const out: BaselineCountInput[] = [];
  for (const tier of TIER_ORDER) {
    const count = counts.get(tier);
    if (count !== undefined && count > 0) out.push({ key: tier, count });
  }
  return out;
}

/** Compare two event leaves by the exemplar representative ranking:
 *  `tier desc → (severity + likelihood) desc → customer_id → (aice_id,
 *  event_key)`. The `customer_id` tie-break (#524) keeps the union over member
 *  pools deterministic when two members' leaves tie on tier/score; it is a
 *  no-op on the single-customer path (one constant `customer_id`). */
function compareLeafRank(a: EventLeafRow, b: EventLeafRow): number {
  const t = tierRank(b.priority_tier) - tierRank(a.priority_tier);
  if (t !== 0) return t;
  const s =
    b.severity_score +
    b.likelihood_score -
    (a.severity_score + a.likelihood_score);
  if (s !== 0) return s;
  if (a.customer_id !== b.customer_id)
    return a.customer_id < b.customer_id ? -1 : 1;
  if (a.aice_id !== b.aice_id) return a.aice_id < b.aice_id ? -1 : 1;
  return a.event_key < b.event_key ? -1 : a.event_key > b.event_key ? 1 : 0;
}

interface ExemplarCluster {
  technique: string;
  count: number;
  tier: PriorityTier;
  /** Top-ranked leaf of the cluster (drives `factor` + the exemplar ref). */
  repLeaf: EventLeafRow;
}

/**
 * Technique-cluster the uncited partition into long-tail exemplars (#495
 * Scope 2). Each uncited leaf contributes to a cluster for every technique in
 * its `ttp_tags`; a leaf with empty `ttp_tags` seeds no cluster (it still
 * counts in `tierDistribution`/counts). Per cluster: `count` = number of
 * uncited leaves carrying that technique (== its `uncitedRollup` count),
 * `tier` = highest tier among them, `repLeaf` = the top-ranked leaf.
 *
 * Returns clusters sorted by the cap order `tier desc → count desc →
 * technique ID`, already truncated to {@link LONG_TAIL_EXEMPLAR_CAP}, plus the
 * total cluster count so the caller can log truncation.
 */
function clusterExemplars(uncited: ReadonlyArray<EventLeafRow>): {
  kept: ExemplarCluster[];
  totalClusters: number;
} {
  const byTechnique = new Map<string, EventLeafRow[]>();
  for (const leaf of uncited) {
    for (const technique of leaf.ttp_tags) {
      const bucket = byTechnique.get(technique);
      if (bucket) bucket.push(leaf);
      else byTechnique.set(technique, [leaf]);
    }
  }
  const clusters: ExemplarCluster[] = [];
  for (const [technique, leaves] of byTechnique) {
    const tier = maxTier(...leaves.map((l) => l.priority_tier));
    const repLeaf = [...leaves].sort(compareLeafRank)[0];
    clusters.push({ technique, count: leaves.length, tier, repLeaf });
  }
  clusters.sort(
    (a, b) =>
      tierRank(b.tier) - tierRank(a.tier) ||
      b.count - a.count ||
      (a.technique < b.technique ? -1 : a.technique > b.technique ? 1 : 0),
  );
  return {
    kept: clusters.slice(0, LONG_TAIL_EXEMPLAR_CAP),
    totalClusters: clusters.length,
  };
}

/**
 * Stable member-qualified identity key for an event leaf / ref (#524):
 * `customer_id:aice_id:event_key`. Across a member union the same
 * `(aice_id, event_key)` can exist in two member DBs, so the dedup /
 * cited-subset / exemplar-index keying must carry the member id or distinct
 * members' leaves would collide. On the single-customer path `customer_id` is
 * one constant value, so this is byte-identical in effect to the old bare key.
 */
function eventKeyOf(e: {
  customer_id: string;
  aice_id: string;
  event_key: string;
}): string {
  return `${e.customer_id}:${e.aice_id}:${e.event_key}`;
}

/**
 * The exemplar leaf set + a finalizer for the `analyzedEventAggregates`
 * payload. `exemplarLeaves` (the distinct kept-cluster representative leaves,
 * each carrying only its chosen `factor` as `analysis`) are appended to the
 * `buildReportTokenMap` leaf set so their `R{j}` numbering is stable;
 * `finalize` then stitches the report-scope-rewritten factor strings back into
 * the per-technique exemplars and returns the full payload (or `null` when the
 * universe is empty → the section is omitted, NOT sent as `null`).
 */
interface AnalyzedAggregatesPlan {
  exemplarLeaves: ReportLeafText[];
  exemplarRefs: ExemplarRef[];
  /**
   * `redaction_policy_version` of each kept exemplar representative leaf (#495
   * review round 1, item 2). The reps' factors are rewritten into report-scope
   * tokens and sent to aimer, so the redaction-policy precondition must cover
   * them too — otherwise a low-only window (no cited leaves) would ship
   * exemplar factor tokens while stamping the `baseline-only` sentinel and
   * never catch a missing/mismatched policy version. Empty on the pinned path:
   * the English canonical already validated the (reused) exemplar set, and
   * mixing English exemplar versions with target-language cited versions in one
   * equality check could spuriously fail.
   */
  exemplarPolicyVersions: string[];
  finalize: (
    rewrittenExemplarTexts: ReadonlyArray<string>,
  ) => AnalyzedEventAggregatesInput | null;
}

const EMPTY_AGGREGATES_PLAN: AnalyzedAggregatesPlan = {
  exemplarLeaves: [],
  exemplarRefs: [],
  exemplarPolicyVersions: [],
  finalize: () => null,
};

/**
 * Plan the long-tail aggregates from the freshly-selected universe + cited
 * sets (the English native / default path). `cited` is consumed directly
 * (keyed by `(aice_id, event_key)`) so `citedCount` is byte-consistent with
 * what the report actually cited; `uncited = universe − cited`.
 */
function planAnalyzedAggregates(args: {
  windows: Windows;
  universe: ReadonlyArray<EventLeafRow>;
  cited: ReadonlyArray<EventLeafRow>;
  warnContext: {
    subjectId: string;
    period: string;
    bucketDate: string;
    tz: string;
  };
}): AnalyzedAggregatesPlan {
  if (args.universe.length === 0) return EMPTY_AGGREGATES_PLAN;

  const citedKeys = new Set(args.cited.map(eventKeyOf));
  const uncited = args.universe.filter((e) => !citedKeys.has(eventKeyOf(e)));

  const { kept, totalClusters } = clusterExemplars(uncited);
  if (totalClusters > LONG_TAIL_EXEMPLAR_CAP) {
    console.warn(
      JSON.stringify({
        level: "warn",
        event: "analysis.report_long_tail_exemplars_truncated",
        subject_id: args.warnContext.subjectId,
        period: args.warnContext.period,
        bucket_date: args.warnContext.bucketDate,
        tz: args.warnContext.tz,
        kept: kept.length,
        dropped: totalClusters - kept.length,
      }),
    );
  }

  // Distinct representative leaves (≤10, fewer if one leaf represents several
  // techniques), in kept-cluster order — this IS the order they enter the
  // token map and `input_exemplar_refs`.
  const exemplarLeaves: ReportLeafText[] = [];
  const exemplarRefs: ExemplarRef[] = [];
  const exemplarPolicyVersions: string[] = [];
  const leafIndexByKey = new Map<string, number>();
  for (const cluster of kept) {
    const key = eventKeyOf(cluster.repLeaf);
    if (leafIndexByKey.has(key)) continue;
    leafIndexByKey.set(key, exemplarLeaves.length);
    exemplarLeaves.push({ analysis: chooseExemplarFactor(cluster.repLeaf) });
    exemplarRefs.push({
      aice_id: cluster.repLeaf.aice_id,
      event_key: cluster.repLeaf.event_key,
      generation: cluster.repLeaf.generation,
      model_name: cluster.repLeaf.model_name,
      model: cluster.repLeaf.model,
      // The member DB the exemplar rep leaf came from (#524). On the group
      // path the universe spans members, so the rep leaf carries which one.
      customer_id: cluster.repLeaf.customer_id,
    });
    // Carry the rep leaf's policy version into the precondition: its factor is
    // prompt input once rewritten to report scope (#495 review r1, item 2).
    exemplarPolicyVersions.push(cluster.repLeaf.redaction_policy_version);
  }

  const finalize = (
    rewrittenExemplarTexts: ReadonlyArray<string>,
  ): AnalyzedEventAggregatesInput => {
    const exemplars: LongTailExemplarInput[] = kept.map((cluster) => {
      const idx = leafIndexByKey.get(eventKeyOf(cluster.repLeaf)) ?? 0;
      return {
        technique: cluster.technique,
        tier: cluster.tier,
        count: cluster.count,
        factor: rewrittenExemplarTexts[idx] ?? "",
      };
    });
    return {
      windowStart: args.windows.curStart.toISOString(),
      windowEnd: args.windows.curEnd.toISOString(),
      analyzedCount: args.universe.length,
      citedCount: args.cited.length,
      // Coverage facets over the FULL universe (RFC §Aggregates).
      topTechniques: topTechniques(
        args.universe.map((e) => e.ttp_tags),
        TOP_AGGREGATE_K,
      ),
      tierDistribution: tierDistribution(args.universe),
      // Technique rollup over the uncited partition only (uncapped).
      uncitedRollup: topTechniques(
        uncited.map((e) => e.ttp_tags),
        Number.POSITIVE_INFINITY,
      ),
      exemplars,
    };
  };

  return { exemplarLeaves, exemplarRefs, exemplarPolicyVersions, finalize };
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
 * Hash-input ref shape: the canonical hash form (#523) STRIPS a `customer_id`
 * equal to the subject, so the hash treats a ref that omits `customer_id` and
 * one that carries `customer_id == subject` as the same value.
 * `computeInputHash` therefore accepts both — deliberately looser than the
 * persisted ref types, which always carry `customer_id`.
 */
type HashRef<T extends { customer_id: string }> = Omit<T, "customer_id"> & {
  customer_id?: string;
};

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
  /**
   * The report's own subject id (#523). A ref whose `customer_id` equals it is
   * the single-customer default and is STRIPPED from the hashed bundle below,
   * so `input_hash` is byte-identical for a single-customer report whether its
   * refs carry `customer_id == subject` or omit it — only a true cross-member
   * ref (`customer_id` != subject, the group path) contributes it to the hash.
   * This mirrors the existing "omit `exemplar_refs` when empty"
   * canonicalization.
   */
  subjectId: string;
  period: string;
  bucketDate: string;
  variant: ReportVariant;
  storyRefs: HashRef<StoryRef>[];
  eventRefs: HashRef<EventRef>[];
  exemplarRefs: HashRef<ExemplarRef>[];
  aimerInputs: PeriodicReportInputs;
}): string {
  // Strip the default `customer_id` (== the report's subject) from a hash-only
  // copy of each ref — NEVER mutate the persisted refs, which always carry it.
  // `stableStringify` drops the resulting `undefined`, so a single-customer
  // ref hashes identically whether it carries the default id or omits it.
  const omitDefaultCustomer = <T extends { customer_id?: string }>(
    ref: T,
  ): T =>
    ref.customer_id === undefined || ref.customer_id === args.subjectId
      ? { ...ref, customer_id: undefined }
      : ref;
  const storyRefs = [...args.storyRefs]
    .map(omitDefaultCustomer)
    .sort(
      (a, b) =>
        a.story_id.localeCompare(b.story_id) || a.generation - b.generation,
    );
  const eventRefs = [...args.eventRefs]
    .map(omitDefaultCustomer)
    .sort(
      (a, b) =>
        a.aice_id.localeCompare(b.aice_id) ||
        a.event_key.localeCompare(b.event_key) ||
        a.generation - b.generation,
    );
  // Exemplar refs are generation-pinned provenance with the SAME restoration
  // semantics as cited refs: they decide which event redaction map turns a
  // long-tail `R{j}` token back into plaintext. Because exemplar `factor`
  // strings carry only report-scope placeholders, two different exemplar
  // leaves/generations can yield a byte-identical payload yet restore to
  // different plaintext — so hashing the payload alone would miss the change
  // and keep serving stale `input_exemplar_refs`. Hash them like story/event
  // refs (#495 review round 1, item 1).
  const exemplarRefs = [...args.exemplarRefs]
    .map(omitDefaultCustomer)
    .sort(
      (a, b) =>
        a.aice_id.localeCompare(b.aice_id) ||
        a.event_key.localeCompare(b.event_key) ||
        a.generation - b.generation ||
        a.model_name.localeCompare(b.model_name) ||
        a.model.localeCompare(b.model),
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
    // Omit `exemplar_refs` entirely when empty (no long-tail) so an
    // empty-universe report hashes byte-identically to pre-#495 — mirrors the
    // `analyzedEventAggregates` `undefined` omission and keeps those reports
    // from being marked dirty. A present-but-empty `[]` would change the hash.
    ...(exemplarRefs.length > 0 ? { exemplar_refs: exemplarRefs } : {}),
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

  // The customer's effective default pair drives the never-drop leaf
  // fallback: only a DEFAULT report (report model == this pair) folds in
  // other-model leaves. Resolved once here (per #473) so selection and
  // the downstream coverage indicator agree on what "default" means.
  const defaultPair = await resolveDefaultModel(args.customerId, args.authPool);

  // --- Top stories (variant + freshness + window overlap) -------------
  const readyStoryIds = await loadReadyStoryIds(args.authPool, args.customerId);
  const stories = await selectTopStories(args.customerPool, {
    customerId: args.customerId,
    variant: args.variant,
    defaultPair,
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
    customerId: args.customerId,
    variant: args.variant,
    defaultPair,
    windows,
    covered,
    limit: topEventsK,
  });

  // --- Long-tail universe (#495): the non-story-covered analyzed-in-window
  // set, reusing `selectTopEvents`' per-event leaf-pick minus floor + ceiling
  // (so `cited ⊆ universe`). The cited set is consumed directly for the
  // partition; the universe drives the analyzed-event aggregates + exemplars.
  const universe = await selectUniverseEvents(args.customerPool, {
    customerId: args.customerId,
    variant: args.variant,
    defaultPair,
    windows,
    covered,
  });
  const aggregatesPlan = planAnalyzedAggregates({
    windows,
    universe,
    cited: events,
    warnContext: {
      subjectId: args.customerId,
      period: args.period,
      bucketDate: args.bucketDate,
      tz: args.variant.tz,
    },
  });

  // Baseline aggregates from the single customer pool (bare sensor keys).
  const baseline = await loadBaselineAggregates(
    args.customerPool,
    windows,
    false,
    args.customerId,
  );

  return assembleReportInput(
    {
      subjectId: args.customerId,
      memberQualified: false,
      period: args.period,
      bucketDate: args.bucketDate,
      variant: args.variant,
    },
    windows,
    stories,
    events,
    aggregatesPlan,
    baseline,
  );
}

/**
 * Load the period-level baseline aggregates for ONE pool into a
 * {@link BaselineAggregateBundle}. The single-customer path calls this with
 * its own pool; the group path calls it per member and sums the bundles
 * (`sumBaselineBundles`) before assembly (#524). When `memberQualified` is
 * true the `topSensors` key is prefixed with `customer_id:` so a member's
 * sensors stay distinct in the union; otherwise the bare `source_aice_id` is
 * kept (single-customer, `input_hash` unchanged).
 */
async function loadBaselineAggregates(
  pool: Pool,
  windows: Windows,
  memberQualified: boolean,
  customerId: string,
): Promise<BaselineAggregateBundle> {
  const currentCounts = await categoryCounts(
    pool,
    windows.curStart,
    windows.curEnd,
  );
  const previousCounts = await categoryCounts(
    pool,
    windows.prevStart,
    windows.prevEnd,
  );
  const totals = await windowBaselineTotals(
    pool,
    windows.curStart,
    windows.curEnd,
  );
  const storyTotal = await storyCountInWindow(
    pool,
    windows.curStart,
    windows.curEnd,
  );
  const sensors = await topSensors(
    pool,
    windows.curStart,
    windows.curEnd,
    TOP_AGGREGATE_K,
  );
  return {
    currentCounts,
    previousCounts,
    totalsEvents: totals.events,
    totalsHosts: totals.hosts,
    storyTotal,
    sensors: memberQualified
      ? sensors.map((s) => ({ key: `${customerId}:${s.key}`, count: s.count }))
      : sensors,
  };
}

// ---------------------------------------------------------------------------
// Group multi-member input path (#524)
// ---------------------------------------------------------------------------

/** One resolved member customer pool for the group builder (#524). */
export interface GroupMemberPool {
  /** The member subject id (the customer id). */
  customerId: string;
  pool: Pool;
}

export interface GroupBuildReportInputArgs {
  authPool: Pool;
  /** The group subject id — stamped as `subject_id` on the result + hash. */
  groupId: string;
  /** Ordered member pools (the #523 resolver's `memberPools`). */
  memberPools: ReadonlyArray<GroupMemberPool>;
  period: PeriodicPeriod;
  bucketDate: string;
  /** Variant — `tz` is the GROUP tz; `model_name`/`model` the group policy. */
  variant: ReportVariant;
  nowIso: string;
  topStoriesK?: number;
  topEventsK?: number;
}

/**
 * Compare two story leaves by the union top-K ranking (#524): `tier desc →
 * (severity + likelihood) desc → customer_id → story_id`. The `customer_id`
 * tie-break makes the cross-member `R{j}` numbering reproducible when two
 * members' stories tie on tier/score; within one member it reduces to the
 * single-customer `... story_id ASC` SQL order.
 */
function compareStoryRank(a: StoryLeafRow, b: StoryLeafRow): number {
  const t = tierRank(b.priority_tier) - tierRank(a.priority_tier);
  if (t !== 0) return t;
  const s =
    b.severity_score +
    b.likelihood_score -
    (a.severity_score + a.likelihood_score);
  if (s !== 0) return s;
  if (a.customer_id !== b.customer_id)
    return a.customer_id < b.customer_id ? -1 : 1;
  return a.story_id < b.story_id ? -1 : a.story_id > b.story_id ? 1 : 0;
}

/**
 * Sum a set of per-member {@link BaselineAggregateBundle}s into one (#524):
 * per-category counts are summed across members (drift is then derived ONCE
 * from the summed counts by `assembleReportInput`, never averaged per member);
 * event/host/story totals are summed; the already-member-qualified sensor
 * lists are merged and re-topped to {@link TOP_AGGREGATE_K} by `count desc,
 * key asc` (member-qualified keys are globally distinct, so no key merges).
 */
function sumBaselineBundles(
  bundles: ReadonlyArray<BaselineAggregateBundle>,
): BaselineAggregateBundle {
  const sumCounts = (
    pick: (b: BaselineAggregateBundle) => CategoryCount[],
  ): CategoryCount[] => {
    const m = new Map<string | null, number>();
    for (const b of bundles) {
      for (const c of pick(b))
        m.set(c.category, (m.get(c.category) ?? 0) + c.count);
    }
    return Array.from(m.entries()).map(([category, count]) => ({
      category,
      count,
    }));
  };
  const sensors = bundles
    .flatMap((b) => b.sensors)
    .sort(
      (a, b) =>
        b.count - a.count || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0),
    )
    .slice(0, TOP_AGGREGATE_K);
  return {
    currentCounts: sumCounts((b) => b.currentCounts),
    previousCounts: sumCounts((b) => b.previousCounts),
    totalsEvents: bundles.reduce((s, b) => s + b.totalsEvents, 0),
    totalsHosts: bundles.reduce((s, b) => s + b.totalsHosts, 0),
    storyTotal: bundles.reduce((s, b) => s + b.storyTotal, 0),
    sensors,
  };
}

/**
 * Build the aggregated `PeriodicReportBuildResult` for a GROUP subject (#524).
 * The single-customer builder reads one `customerPool`; this unions the
 * group's MEMBER pools:
 *
 *   1. Per member, select that member's top-K stories (variant + freshness +
 *      window), stamping each leaf with its member id.
 *   2. Union the per-member sets and re-rank with the `customer_id`-inclusive
 *      tie-break to take the global top-K cited stories — the cross-member
 *      `R{j}` numbering is deterministic by construction.
 *   3. Partition the cited stories by member and load each member's covered
 *      `(aice_id, event_key)` set from ITS OWN DB only (member-local: a member
 *      A story never suppresses a member B event).
 *   4. Per member, select top-K events + the long-tail universe excluding that
 *      member's covered set; union + global top-K events; union universe.
 *   5. Sum baseline totals / per-category counts / sensors across members
 *      (drift derived once from the summed counts).
 *
 * Every persisted ref carries its member `customer_id`; the `aimerInputs`
 * source keys, guard, and loader are member-qualified (`memberQualified`).
 * Token-bearing inputs are member-side analysis / story-analysis rows (the
 * selectors read `event_analysis_result` / `story_analysis_result` only), so
 * `analysis_days` governs their redaction-map horizon (B4 / #509).
 */
export async function buildGroupPeriodicReportInput(
  args: GroupBuildReportInputArgs,
): Promise<PeriodicReportBuildResult> {
  const topStoriesK = args.topStoriesK ?? 5;
  const topEventsK = args.topEventsK ?? 10;

  const windowPool = args.memberPools[0]?.pool;
  if (windowPool === undefined) {
    // A group always has >= 2 members (creation invariant); guard anyway so a
    // degenerate empty-member group fails loudly rather than silently emitting
    // a baseline-only report against no source.
    throw new Error(`group ${args.groupId} has no member pools`);
  }
  // Window math is pure tz arithmetic over no member tables, so resolve once
  // against any member pool, in the GROUP tz.
  const windows = await resolveWindows(
    windowPool,
    args.period,
    args.bucketDate,
    args.variant.tz,
    args.nowIso,
  );

  // Never-drop fallback is driven by the GROUP's resolved default, applied
  // uniformly to every member — NOT each member's own per-customer default.
  // The group report variant is the group default-model policy (global/env
  // only — #524 scope 6); `resolveDefaultModel(groupId)` returns that same
  // pair because a group has no `customer_default_model` row. Keying the
  // fallback off it makes `variant === defaultPair` for all members, so the
  // group default report extends the single-customer default-report behavior
  // (never silently dropping a fallback-only analyzed leaf) across the union.
  // Using each member's own default instead would put any member whose
  // override differs from the group model onto the strict exact-match path,
  // silently dropping its fallback-only leaves — surprising for a default
  // group report.
  const groupDefaultPair = await resolveDefaultModel(
    args.groupId,
    args.authPool,
  );

  // --- Stories: per-member top-K → union → global top-K ----------------
  const memberStorySets: StoryLeafRow[][] = [];
  for (const m of args.memberPools) {
    const readyStoryIds = await loadReadyStoryIds(args.authPool, m.customerId);
    memberStorySets.push(
      await selectTopStories(m.pool, {
        customerId: m.customerId,
        variant: args.variant,
        defaultPair: groupDefaultPair,
        readyStoryIds,
        windows,
        limit: topStoriesK,
      }),
    );
  }
  const citedStories = memberStorySets
    .flat()
    .sort(compareStoryRank)
    .slice(0, topStoriesK);

  // Partition the GLOBAL cited stories by member so each member's covered set
  // is derived only from its own cited stories (member-local exclusion).
  const citedStoriesByMember = new Map<string, StoryLeafRow[]>();
  for (const s of citedStories) {
    const arr = citedStoriesByMember.get(s.customer_id) ?? [];
    arr.push(s);
    citedStoriesByMember.set(s.customer_id, arr);
  }

  // --- Events + universe + baseline, per member ------------------------
  const memberEventSets: EventLeafRow[][] = [];
  const memberUniverseSets: EventLeafRow[][] = [];
  const baselineBundles: BaselineAggregateBundle[] = [];
  for (const m of args.memberPools) {
    const defaultPair = groupDefaultPair;
    const memberCited = citedStoriesByMember.get(m.customerId) ?? [];
    const covered = await loadStoryMemberKeys(
      m.pool,
      memberCited.map((s) => s.story_id),
    );
    memberEventSets.push(
      await selectTopEvents(m.pool, {
        customerId: m.customerId,
        variant: args.variant,
        defaultPair,
        windows,
        covered,
        limit: topEventsK,
      }),
    );
    memberUniverseSets.push(
      await selectUniverseEvents(m.pool, {
        customerId: m.customerId,
        variant: args.variant,
        defaultPair,
        windows,
        covered,
      }),
    );
    baselineBundles.push(
      await loadBaselineAggregates(m.pool, windows, true, m.customerId),
    );
  }
  const citedEvents = memberEventSets
    .flat()
    .sort(compareLeafRank)
    .slice(0, topEventsK);
  // The universe is the full non-cited-floored set (no top-K), so its union is
  // a plain concatenation; `planAnalyzedAggregates` derives uncited = universe
  // − cited via the member-qualified `eventKeyOf`.
  const universe = memberUniverseSets.flat();
  const aggregatesPlan = planAnalyzedAggregates({
    windows,
    universe,
    cited: citedEvents,
    warnContext: {
      subjectId: args.groupId,
      period: args.period,
      bucketDate: args.bucketDate,
      tz: args.variant.tz,
    },
  });

  const baseline = sumBaselineBundles(baselineBundles);

  return assembleReportInput(
    {
      subjectId: args.groupId,
      memberQualified: true,
      period: args.period,
      bucketDate: args.bucketDate,
      variant: args.variant,
    },
    windows,
    citedStories,
    citedEvents,
    aggregatesPlan,
    baseline,
  );
}

/**
 * The period-level baseline aggregates `assembleReportInput` needs, computed
 * by the caller so the single-customer path reads them from its one pool while
 * the group path SUMS them across member pools (#524) before assembly. Drift
 * is derived here from the (summed) per-category counts — never averaged per
 * member. `sensors` is already merged + top-K and keyed exactly as it should
 * appear in `aimerInputs` (bare on the single-customer path; member-qualified
 * on the group path), so assembly passes it through verbatim.
 */
interface BaselineAggregateBundle {
  currentCounts: CategoryCount[];
  previousCounts: CategoryCount[];
  totalsEvents: number;
  totalsHosts: number;
  storyTotal: number;
  sensors: BaselineCountInput[];
}

async function assembleReportInput(
  ctx: {
    /**
     * The report's subject id (#523/#524) — a customer id on the
     * single-customer path, a group id on the group path. Threaded into
     * `computeInputHash`; a ref whose `customer_id` equals it is the
     * single-customer default and is stripped from the hash.
     */
    subjectId: string;
    /**
     * Member-qualify the opaque wire / citation keys (#524). On the group
     * path the same `story_id` / `(aice_id, event_key)` can exist in two
     * member DBs, so `aimerInputs` source keys (and the guard/loader that
     * share them) must carry the member id: `customer_id:story_id` and
     * `customer_id:aice_id:event_key`. The single-customer path keeps bare
     * keys so `input_hash` and citations are unchanged (backward compatible).
     */
    memberQualified: boolean;
    period: PeriodicPeriod;
    bucketDate: string;
    variant: ReportVariant;
  },
  windows: Windows,
  stories: StoryLeafRow[],
  events: EventLeafRow[],
  aggregatesPlan: AnalyzedAggregatesPlan,
  baseline: BaselineAggregateBundle,
): Promise<PeriodicReportBuildResult> {
  // --- Baseline aggregates + drift ------------------------------------
  // Counts/totals are precomputed by the caller (summed across members on the
  // group path). Drift is derived ONCE from the summed per-category counts.
  const drift = computeBaselineDrift(
    baseline.currentCounts,
    baseline.previousCounts,
  );
  const baselineTotals = {
    events: baseline.totalsEvents,
    hosts: baseline.totalsHosts,
  };
  const storyTotal = baseline.storyTotal;
  const sensors = baseline.sensors;

  // --- Redaction policy precondition (consumed leaves only) -----------
  // Includes the kept exemplar representative leaves (#495 review r1, item 2):
  // their factors are rewritten to report-scope tokens and sent to aimer, so a
  // low-only long-tail window must not stamp `baseline-only` while shipping
  // exemplar tokens, and a missing/mismatched exemplar policy version must be
  // caught here before the LLM call.
  const leafPolicyVersions = [
    ...stories.map((s) => s.redaction_policy_version),
    ...events.map((e) => e.redaction_policy_version),
    ...aggregatesPlan.exemplarPolicyVersions,
  ];
  const redaction = resolveRedactionPolicy(leafPolicyVersions);

  // --- Token rewrite to report scope ----------------------------------
  // Feed each leaf's analysis AND its factor arrays through the per-leaf
  // token map so a scope token that defensively appears in a factor is
  // folded to report scope too, not passed through to the prompt raw
  // (#297 review round 1, item 2).
  // The exemplar leaves (#495) are appended AFTER the cited story+event
  // leaves so their `R{j}` numbering is stable across native / pinned /
  // translate / restore.
  const {
    rewrittenStoryTexts,
    rewrittenEventTexts,
    rewrittenExemplarTexts,
    rewrittenStoryFactors,
    rewrittenEventFactors,
    refs,
    allowedTokens,
  } = buildReportTokenMap(
    stories.map(maskedStoryLeaf),
    events.map((e) => ({
      analysis: e.analysis_text,
      severityFactors: e.severity_factors,
      likelihoodFactors: e.likelihood_factors,
    })),
    aggregatesPlan.exemplarLeaves,
  );
  void allowedTokens; // the scan re-derives from refs at hallucination time

  // Stitch the report-scope-rewritten exemplar factors back into the
  // long-tail payload (or `null` when the universe was empty → the section
  // is OMITTED below, never sent as `null`).
  const analyzedEventAggregates = aggregatesPlan.finalize(
    rewrittenExemplarTexts,
  );

  // --- Aggregations ----------------------------------------------------
  // Hybrid calibration (#465 Scope 5, P2): coverage and calibration are
  // separate concerns. The narrative/leaf-derived facets render the FULL
  // selected set (including any fallback-model leaves), but the *calibrated
  // scores* — aggregate severity/likelihood (`Math.max`) and `priority_tier`
  // (`maxTier`) — are computed over the REPORT-MODEL subset only (plus drift),
  // never the fallback leaves. `MAX` lets a single off-model (differently
  // calibrated) leaf dominate the headline, so a report labeled as model X must
  // carry model-X-meaningful scores. The transient understatement right after a
  // model change is bounded, surfaced via the coverage indicator (Scope 6), and
  // shortened by the operator-triggered leaf backfill (#466). For an
  // alternate-model report every selected leaf already equals the report model,
  // so the subset is the full set and this is a no-op.
  const isReportModelStory = (s: StoryLeafRow): boolean =>
    s.model_name === ctx.variant.modelName && s.model === ctx.variant.model;
  const isReportModelEvent = (e: EventLeafRow): boolean =>
    e.model_name === ctx.variant.modelName && e.model === ctx.variant.model;
  const reportModelStories = stories.filter(isReportModelStory);
  const reportModelEvents = events.filter(isReportModelEvent);

  // TTP tags are a coverage/narrative facet, NOT a cross-model-calibrated
  // score, so `aggregate_ttp_tags` (and the derived `topTechniques` below) stay
  // on the FULL selected set (#465 Scope 5).
  const aggregateTtpTags = dedupeSorted([
    ...stories.flatMap((s) => s.ttp_tags),
    ...events.flatMap((e) => e.ttp_tags),
  ]);

  const leafTiers: PriorityTier[] = [
    ...reportModelStories.map((s) => s.priority_tier),
    ...reportModelEvents.map((e) => e.priority_tier),
  ];
  const driftTier = computePriorityTier(drift.severity, drift.likelihood);
  const priorityTier = maxTier(...leafTiers, driftTier);

  const aggregateSeverityScore = Math.max(
    drift.severity,
    ...reportModelStories.map((s) => s.severity_score),
    ...reportModelEvents.map((e) => e.severity_score),
    0,
  );
  const aggregateLikelihoodScore = Math.max(
    drift.likelihood,
    ...reportModelStories.map((s) => s.likelihood_score),
    ...reportModelEvents.map((e) => e.likelihood_score),
    0,
  );

  // --- Structured aimer inputs ----------------------------------------
  // Mapped to aimer's real SDL shape (schemas/aimer.graphql @ f04caba):
  // `StoryAnalysisInput` / `EventAnalysisInput` carry a single JSON/markdown
  // `sections` narrative (the report-scope-rewritten leaf analysis) plus the
  // leaf's nullable scores, factor arrays, and TTP tags — no `priorityTier`
  // (kept internal for aggregation, not part of the wire shape).
  const storyAnalyses: StoryAnalysisInput[] = stories.map((s, i) => ({
    // Opaque source key (#524): bare `story_id` for a single customer,
    // member-qualified `customer_id:story_id` for a group so two members'
    // identical `story_id`s do not collide. The guard's allowed set and the
    // step-3 loader derive the same key via `storyWireKey`.
    storyId: storyWireKey(s, ctx.subjectId, ctx.memberQualified),
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
    // `input_event_refs`. On the group path the key is member-qualified
    // (`customer_id:aice_id:event_key`) via `eventWireKey` (#524).
    eventRef: eventWireKey(e, ctx.subjectId, ctx.memberQualified),
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
    // Long-tail analyzed-event aggregates (#495). OMITTED (left undefined)
    // when the universe is empty so `computeInputHash` stays byte-identical
    // to pre-change and empty-universe reports are not marked dirty —
    // `stableStringify` drops `undefined` but hashes `null` as a value, so
    // this MUST stay `undefined`, never `null`.
    ...(analyzedEventAggregates !== null ? { analyzedEventAggregates } : {}),
  };

  // Each ref records the leaf's OWN model (#465 Scope 3) so the read/restore
  // path can pin a fallback-model leaf by its real model instead of the report
  // row's. Persisted additively into the `input_*_refs` JSONB — no migration.
  // Each ref also carries the member `customer_id` of the leaf's customer DB
  // (#523/#524): the selectors stamp each leaf with the member it came from.
  // On the single-customer path that is the subject's own customer id (== the
  // subject), so the hash strips it and `input_hash` is unchanged; on the
  // group path it is the true member id, distinguishing cross-member refs.
  const storyRefs: StoryRef[] = stories.map((s) => ({
    story_id: s.story_id,
    generation: s.generation,
    model_name: s.model_name,
    model: s.model,
    customer_id: s.customer_id,
  }));
  const eventRefs: EventRef[] = events.map((e) => ({
    aice_id: e.aice_id,
    event_key: e.event_key,
    generation: e.generation,
    model_name: e.model_name,
    model: e.model,
    customer_id: e.customer_id,
  }));
  // Exemplar refs already carry their leaf's `customer_id`, stamped in
  // `planAnalyzedAggregates` (or copied verbatim from the canonical on the
  // pinned path).
  const exemplarRefs: ExemplarRef[] = aggregatesPlan.exemplarRefs;

  const inputHash = computeInputHash({
    subjectId: ctx.subjectId,
    period: ctx.period,
    bucketDate: ctx.bucketDate,
    variant: ctx.variant,
    storyRefs,
    eventRefs,
    exemplarRefs,
    aimerInputs,
  });

  // Member-qualify the audit aice-id set on the group path so two members'
  // identical `source_aice_id`s do not silently merge (#524); bare on the
  // single-customer path.
  const sourceAiceIds = Array.from(
    new Set([
      ...stories.map((s) =>
        ctx.memberQualified
          ? `${s.customer_id}:${s.source_aice_id}`
          : s.source_aice_id,
      ),
      ...events.map((e) =>
        ctx.memberQualified ? `${e.customer_id}:${e.aice_id}` : e.aice_id,
      ),
    ]),
  );

  return {
    aimerInputs,
    storyRefs,
    eventRefs,
    exemplarRefs,
    analyzedEventAggregates,
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
  /**
   * Owning customer. `story_analysis_result` is keyed by `customer_id`, so the
   * pinned story lookup must scope to it (mirrors `selectTopStories` and the
   * loader's customer-scoped replay); otherwise a same-`story_id` row from
   * another customer could satisfy the completeness gate.
   */
  customerId: string;
  period: PeriodicPeriod;
  bucketDate: string;
  /** Target variant — `lang` is the non-English language being generated. */
  variant: ReportVariant;
  nowIso: string;
  /** The English canonical's `input_story_refs` (story_id + generation). */
  storyRefs: StoryRef[];
  /** The English canonical's `input_event_refs` (aice_id/event_key + gen). */
  eventRefs: EventRef[];
  /**
   * The English canonical's `input_exemplar_refs` (#495). Reused verbatim:
   * the exemplar English leaves are re-fetched to re-mint the same exemplar
   * `R{j}` token map (so the leak scan covers them), and the refs are
   * persisted onto this row.
   */
  exemplarRefs: ExemplarRef[];
  /**
   * The English canonical's stored `input_analyzed_event_aggregates` (#495),
   * reused verbatim so the native-pinned non-English long-tail carries the
   * canonical's counts / rollups / tier distribution and exemplar token
   * numbering — NO divergent universe is recomputed in the target language.
   * `null` when the canonical omitted the section (empty universe).
   */
  analyzedEventAggregates: AnalyzedEventAggregatesInput | null;
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
    args.customerId,
    args.variant,
    args.storyRefs,
  );
  if (stories === null) return { complete: false };

  const events = await fetchEventLeavesByRefs(
    args.customerPool,
    args.customerId,
    args.variant,
    args.eventRefs,
  );
  if (events === null) return { complete: false };

  // Exemplar leaves are ALWAYS English (the canonical owns the set + `R{j}`
  // numbering, #495): re-fetch them at `DEFAULT_LANG` so the token map covers
  // the reused (English) exemplar `factor` tokens, regardless of this row's
  // target language. A missing exemplar leaf is an integrity failure for the
  // native-pinned path — treat it like a missing cited leaf and fall through
  // to translation.
  const exemplarLeaves = await fetchExemplarLeavesByRefs(
    args.customerPool,
    args.exemplarRefs,
  );
  if (exemplarLeaves === null) return { complete: false };

  const aggregatesPlan: AnalyzedAggregatesPlan = {
    exemplarLeaves,
    exemplarRefs: args.exemplarRefs,
    // Empty by design: the English canonical already ran the redaction-policy
    // precondition over this exact exemplar set, and the reused leaves are
    // English while this row's cited leaves are the target language — folding
    // English exemplar versions into the target-language equality check could
    // spuriously trip `mismatched` (#495 review r1, item 2).
    exemplarPolicyVersions: [],
    // Reuse the canonical payload verbatim — never recompute the universe in
    // the target language.
    finalize: () => args.analyzedEventAggregates,
  };

  // Pinned non-English replay is single-customer only (#524 groups always
  // translate non-English), so baseline aggregates come from the one pool
  // with bare sensor keys — identical to the canonical's.
  const baseline = await loadBaselineAggregates(
    args.customerPool,
    windows,
    false,
    args.customerId,
  );

  const built = await assembleReportInput(
    {
      subjectId: args.customerId,
      memberQualified: false,
      period: args.period,
      bucketDate: args.bucketDate,
      variant: args.variant,
    },
    windows,
    stories,
    events,
    aggregatesPlan,
    baseline,
  );
  return { complete: true, built };
}

/**
 * Fetch the target-language story leaves for the pinned refs, returned in
 * the SAME order as `refs` so the report-scope `R{j}` numbering matches the
 * English canonical. Pins each leaf by the owning `customer_id` and exact
 * `(story_id, generation)` plus the target `(lang, model_name, model)` — the
 * `customer_id` scope is part of the story leaf identity (the table's PK), so
 * a same-`story_id` row belonging to another customer cannot satisfy the gate
 * and get fed into native generation. Does NOT filter `superseded_at` (a
 * generation is immutable, mirroring the page loader's pinned replay).
 * Returns `null` if any ref has no matching target-language leaf.
 */
async function fetchStoryLeavesByRefs(
  customerPool: Pool,
  customerId: string,
  variant: ReportVariant,
  refs: StoryRef[],
): Promise<StoryLeafRow[] | null> {
  if (refs.length === 0) return [];
  const storyIds = refs.map((r) => r.story_id);
  const generations = refs.map((r) => r.generation);
  // Pin each leaf by ITS OWN ref model (#465 Scope 3), not a single report
  // variant: under the never-drop fallback a ref can point at an off-model
  // leaf. `lang` stays the variant's.
  const refModelNames = refs.map((r) => r.model_name);
  const refModels = refs.map((r) => r.model);
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
            r.generation, r.model_name, r.model,
            r.severity_score, r.likelihood_score,
            r.priority_tier,
            r.ttp_tags, r.severity_factors, r.likelihood_factors,
            r.analysis_text, r.redaction_policy_version,
            cs.source_aice_id,
            cs.time_window_start, cs.time_window_end
       FROM story_analysis_result r
       JOIN canonical_story cs ON cs.story_id = r.story_id
       JOIN unnest($1::bigint[], $2::int[], $4::text[], $5::text[])
              AS ref(story_id, generation, model_name, model)
         ON ref.story_id = r.story_id AND ref.generation = r.generation
        AND ref.model_name = r.model_name AND ref.model = r.model
      WHERE r.customer_id = $6
        AND r.lang = $3`,
    [storyIds, generations, variant.lang, refModelNames, refModels, customerId],
  );
  return orderByRefs(
    rows.map((r) => ({ ...r, customer_id: customerId })),
    refs,
    (row) => `${row.story_id}|${row.generation}|${row.model_name}|${row.model}`,
    (ref) => `${ref.story_id}|${ref.generation}|${ref.model_name}|${ref.model}`,
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
  customerId: string,
  variant: ReportVariant,
  refs: EventRef[],
): Promise<EventLeafRow[] | null> {
  if (refs.length === 0) return [];
  const aiceIds = refs.map((r) => r.aice_id);
  const eventKeys = refs.map((r) => r.event_key);
  const generations = refs.map((r) => r.generation);
  // Pin each leaf by its own ref model (#465 Scope 3).
  const refModelNames = refs.map((r) => r.model_name);
  const refModels = refs.map((r) => r.model);
  const { rows } = await customerPool.query<EventLeafRow>(
    `WITH latest_baseline AS (
       SELECT DISTINCT ON (source_aice_id, event_key)
              source_aice_id, event_key, event_time
         FROM baseline_event
        ORDER BY source_aice_id, event_key, received_at DESC, baseline_version DESC
     )
     SELECT e.aice_id,
            e.event_key::text AS event_key,
            e.generation, e.model_name, e.model,
            e.severity_score, e.likelihood_score,
            e.priority_tier,
            e.ttp_tags, e.severity_factors, e.likelihood_factors,
            e.analysis_text, e.redaction_policy_version,
            lb.event_time
       FROM event_analysis_result e
       JOIN latest_baseline lb
         ON lb.source_aice_id = e.aice_id AND lb.event_key = e.event_key
       JOIN unnest($1::text[], $2::numeric[], $3::int[], $5::text[], $6::text[])
              AS ref(aice_id, event_key, generation, model_name, model)
         ON ref.aice_id = e.aice_id AND ref.event_key = e.event_key
        AND ref.generation = e.generation
        AND ref.model_name = e.model_name AND ref.model = e.model
      WHERE e.lang = $4`,
    [aiceIds, eventKeys, generations, variant.lang, refModelNames, refModels],
  );
  return orderByRefs(
    rows.map((r) => ({ ...r, customer_id: customerId })),
    refs,
    (row) =>
      `${row.aice_id}|${row.event_key}|${row.generation}|${row.model_name}|${row.model}`,
    (ref) =>
      `${ref.aice_id}|${ref.event_key}|${ref.generation}|${ref.model_name}|${ref.model}`,
  );
}

/**
 * Fetch the long-tail exemplar leaves for the pinned refs (#495), in `refs`
 * order, each reduced to its single chosen `factor` as the leaf text fed to
 * `buildReportTokenMap` (the exact field the builder rewrote). Pinned at
 * `DEFAULT_LANG` (English) and the ref's exact `(generation, model_name,
 * model)` — exemplars are inherently English, so this is independent of any
 * target variant. Does NOT filter `superseded_at` (a generation is
 * immutable). Returns `null` if any ref has no matching English leaf.
 */
async function fetchExemplarLeavesByRefs(
  customerPool: Pool,
  refs: ExemplarRef[],
): Promise<ReportLeafText[] | null> {
  if (refs.length === 0) return [];
  const { rows } = await customerPool.query<{
    aice_id: string;
    event_key: string;
    generation: number;
    model_name: string;
    model: string;
    severity_factors: string[];
    likelihood_factors: string[];
  }>(
    `SELECT e.aice_id,
            e.event_key::text AS event_key,
            e.generation, e.model_name, e.model,
            e.severity_factors, e.likelihood_factors
       FROM event_analysis_result e
       JOIN unnest($1::text[], $2::numeric[], $3::int[], $4::text[], $5::text[])
              AS ref(aice_id, event_key, generation, model_name, model)
         ON ref.aice_id = e.aice_id AND ref.event_key = e.event_key
        AND ref.generation = e.generation
        AND ref.model_name = e.model_name AND ref.model = e.model
      WHERE e.lang = $6`,
    [
      refs.map((r) => r.aice_id),
      refs.map((r) => r.event_key),
      refs.map((r) => r.generation),
      refs.map((r) => r.model_name),
      refs.map((r) => r.model),
      DEFAULT_LANG,
    ],
  );
  const ordered = orderByRefs(
    rows,
    refs,
    (row) =>
      `${row.aice_id}|${row.event_key}|${row.generation}|${row.model_name}|${row.model}`,
    (ref) =>
      `${ref.aice_id}|${ref.event_key}|${ref.generation}|${ref.model_name}|${ref.model}`,
  );
  if (ordered === null) return null;
  return ordered.map((r) => ({ analysis: chooseExemplarFactor(r) }));
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
 * without re-running the full baseline assembly. Scoped to `customerId` so a
 * same-`story_id` leaf from another customer cannot stand in for a missing one
 * (story leaves are keyed by `customer_id`). Returns `null` if any pinned leaf
 * is missing (the caller treats that as an integrity failure).
 */
export async function buildPinnedTokenRefs(
  customerPool: Pool,
  customerId: string,
  variant: ReportVariant,
  storyRefs: StoryRef[],
  eventRefs: EventRef[],
  exemplarRefs: ExemplarRef[] = [],
): Promise<ReportTokenRef[] | null> {
  const stories = await fetchStoryLeavesByRefs(
    customerPool,
    customerId,
    variant,
    storyRefs,
  );
  if (stories === null) return null;
  const events = await fetchEventLeavesByRefs(
    customerPool,
    customerId,
    variant,
    eventRefs,
  );
  if (events === null) return null;
  // Exemplar leaves replay at `DEFAULT_LANG` regardless of the row's variant
  // (#495): the cited refs use the row/restoration variant above; the
  // exemplar refs use the fixed English variant. The single combined
  // `buildReportTokenMap` call appends them after the cited leaves so the
  // `R{j}` numbering matches the canonical (and the union is implicit).
  const exemplarLeaves = await fetchExemplarLeavesByRefs(
    customerPool,
    exemplarRefs,
  );
  if (exemplarLeaves === null) return null;
  const { refs } = buildReportTokenMap(
    stories.map(maskedStoryLeaf),
    events.map((e) => ({
      analysis: e.analysis_text,
      severityFactors: e.severity_factors,
      likelihoodFactors: e.likelihood_factors,
    })),
    exemplarLeaves,
  );
  return refs;
}

// ---------------------------------------------------------------------------
// Group pinned token reconstruction (#524 — translate-path leak scan)
// ---------------------------------------------------------------------------

const storyLeafKey = (l: {
  customer_id: string;
  story_id: string;
  generation: number;
  model_name: string;
  model: string;
}): string =>
  `${l.customer_id}|${l.story_id}|${l.generation}|${l.model_name}|${l.model}`;

const storyRefKeyG = (r: StoryRef): string =>
  `${r.customer_id}|${r.story_id}|${r.generation}|${r.model_name}|${r.model}`;

const eventLeafKey = (l: {
  customer_id: string;
  aice_id: string;
  event_key: string;
  generation: number;
  model_name: string;
  model: string;
}): string =>
  `${l.customer_id}|${l.aice_id}|${l.event_key}|${l.generation}|${l.model_name}|${l.model}`;

const eventRefKeyG = (r: EventRef): string =>
  `${r.customer_id}|${r.aice_id}|${r.event_key}|${r.generation}|${r.model_name}|${r.model}`;

const exemplarRefKeyG = (r: ExemplarRef): string =>
  `${r.customer_id}|${r.aice_id}|${r.event_key}|${r.generation}|${r.model_name}|${r.model}`;

/**
 * Reconstruct the report-scope token refs for a GROUP's pinned cited-leaf set
 * (#524), the group analogue of {@link buildPinnedTokenRefs}: the cited leaves
 * live across the MEMBER pools (each ref carries its `customer_id`), so this
 * fans the by-ref fetches out per member and reassembles the leaves in the
 * canonical ref order before a single `buildReportTokenMap` pass — keeping the
 * `R{j}` numbering identical to the order the group builder minted it in.
 * Returns `null` if any pinned leaf is missing in its member DB (caller treats
 * that as an integrity failure, exactly like the single-customer path).
 */
export async function buildGroupPinnedTokenRefs(
  memberPools: ReadonlyArray<GroupMemberPool>,
  variant: ReportVariant,
  storyRefs: StoryRef[],
  eventRefs: EventRef[],
  exemplarRefs: ExemplarRef[] = [],
): Promise<ReportTokenRef[] | null> {
  const poolByCustomer = new Map(
    memberPools.map((m) => [m.customerId, m.pool]),
  );

  // Stories — fetch per member, reassemble in canonical order.
  const storyByKey = new Map<string, StoryLeafRow>();
  for (const [cid, subset] of groupRefsByCustomer(storyRefs)) {
    const pool = poolByCustomer.get(cid);
    if (pool === undefined) return null;
    const leaves = await fetchStoryLeavesByRefs(pool, cid, variant, subset);
    if (leaves === null) return null;
    for (const l of leaves) storyByKey.set(storyLeafKey(l), l);
  }
  const stories: StoryLeafRow[] = [];
  for (const r of storyRefs) {
    const l = storyByKey.get(storyRefKeyG(r));
    if (l === undefined) return null;
    stories.push(l);
  }

  // Events.
  const eventByKey = new Map<string, EventLeafRow>();
  for (const [cid, subset] of groupRefsByCustomer(eventRefs)) {
    const pool = poolByCustomer.get(cid);
    if (pool === undefined) return null;
    const leaves = await fetchEventLeavesByRefs(pool, cid, variant, subset);
    if (leaves === null) return null;
    for (const l of leaves) eventByKey.set(eventLeafKey(l), l);
  }
  const events: EventLeafRow[] = [];
  for (const r of eventRefs) {
    const l = eventByKey.get(eventRefKeyG(r));
    if (l === undefined) return null;
    events.push(l);
  }

  // Exemplar leaves (always English) — same fan-out, reassembled in order.
  const exemplarByKey = new Map<string, ReportLeafText>();
  for (const [cid, subset] of groupRefsByCustomer(exemplarRefs)) {
    const pool = poolByCustomer.get(cid);
    if (pool === undefined) return null;
    const leaves = await fetchExemplarLeavesByRefs(pool, subset);
    if (leaves === null) return null;
    for (let i = 0; i < subset.length; i += 1) {
      exemplarByKey.set(exemplarRefKeyG(subset[i]), leaves[i]);
    }
  }
  const exemplarLeaves: ReportLeafText[] = [];
  for (const r of exemplarRefs) {
    const l = exemplarByKey.get(exemplarRefKeyG(r));
    if (l === undefined) return null;
    exemplarLeaves.push(l);
  }

  const { refs } = buildReportTokenMap(
    stories.map(maskedStoryLeaf),
    events.map((e) => ({
      analysis: e.analysis_text,
      severityFactors: e.severity_factors,
      likelihoodFactors: e.likelihood_factors,
    })),
    exemplarLeaves,
  );
  return refs;
}

/** Group refs by their `customer_id`, preserving each member's ref order. */
function groupRefsByCustomer<T extends { customer_id: string }>(
  refs: ReadonlyArray<T>,
): Map<string, T[]> {
  const out = new Map<string, T[]>();
  for (const r of refs) {
    const arr = out.get(r.customer_id);
    if (arr) arr.push(r);
    else out.set(r.customer_id, [r]);
  }
  return out;
}

export const __testables = {
  resolveRedactionPolicy,
  computeInputHash,
  dedupeSorted,
  planAnalyzedAggregates,
  clusterExemplars,
  tierDistribution,
  chooseExemplarFactor,
};
