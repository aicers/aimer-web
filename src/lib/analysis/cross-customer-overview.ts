// Cross-customer overview aggregator (WS2, #391 / parent #386 Track 1).
//
// The top-level overview routes (`/overview`, `/reports`, `/threat-stories`,
// `/suspicious-events`) are cross-customer vantages: under the active scope
// (WS1, #390) they surface the most recent and highest-risk reports, threat
// stories, and suspicious events across every customer the user can both
// access AND read on that surface.
//
// Three architectural facts shape this loader:
//
//   1. Each customer is a separate database (`getCustomerRuntimePool`), and
//      the auth DB cannot be JOINed to a customer DB. So a cross-customer
//      "recent + high-risk" view cannot be one `ORDER BY ... LIMIT` query —
//      it fans out per in-scope customer and merges in app code. This mirrors
//      the proven two-DB discover/enrich pattern in
//      `report-index-page-loader.ts`.
//
//   2. `scope.customerIds` (from WS1's `loadScopePage`) is ACCESS-only, not
//      permission-filtered. Iterating it would leak counts for customers the
//      user can see but not read, and a count is itself a disclosure. Each
//      surface therefore intersects the scope with the customers holding its
//      own permission (`reports:read` for reports; `analyses:read` for
//      stories/events) via `listAccessibleCustomersDetailed`.
//
//   3. Ordering is high-risk first by an integer priority RANK (`tierRank`),
//      never the raw `priority_tier` TEXT column (which sorts
//      `CRITICAL < HIGH < LOW < MEDIUM`, backwards). The full key is
//      `priority_rank desc, severity desc, likelihood desc, recency desc, id
//      asc` (#392's documented key), with the canonical `superseded_at IS
//      NULL` + latest-`generation` dedup applied so rows never double-count.
//
// Pagination model (pinned by #391): a bounded top-K capped overview (default
// 25), NOT deep offset paging. A per-customer-DB fan-out makes deep offset
// paging refetch top-(offset+limit) from every customer's DB per page, so the
// long tail is reached by drilling into the single-customer list pages (WS3,
// #392), which own true keyset pagination.
//
// WS3 dependency note: #391 is specified as a consumer of #392's per-customer
// keyset list loaders and its `story_analysis_state` priority/score
// denormalization. #392 has not landed, and a bounded top-K merge does not
// need the denormalization (that exists for #392's single-DB keyset cursor):
// this loader fans out directly over the existing tables, reading story
// priority/scores from the customer-DB `story_analysis_result` and the
// lifecycle/recency from the auth-DB `story_analysis_state` — exactly the
// report-index discover/enrich split. To keep the bounded top-K equal to the
// top-K of the LIFECYCLE-ELIGIBLE set (not the top-K of a superset that is
// then filtered), the eligible keys are enumerated from the auth DB FIRST and
// the customer-DB risk `LIMIT` is applied only AFTER intersecting them, so
// archived/pending/missing-state rows can never consume the over-fetch window
// and hide an eligible high-risk row. When #392 lands, the per-customer
// fetchers here can be re-pointed at its shared loaders without changing the
// merge/rank/permission surface.

import "server-only";

import type { Pool } from "pg";
import {
  type AccessibleCustomerDetailed,
  listAccessibleCustomersDetailed,
} from "@/lib/auth/authorization";
import { getAuthCookie } from "@/lib/auth/cookies";
import { verifyJwtFull } from "@/lib/auth/jwt";
import { getSessionPolicy } from "@/lib/auth/session-policy";
import { validateSession } from "@/lib/auth/session-validator";
import { getAuthPool, withTransaction } from "@/lib/db/client";
import { getCustomerRuntimePool } from "@/lib/db/customer-runtime-pool";
import { type PriorityTier, tierRank } from "./priority-tier";
import type { PeriodKind } from "./report-bucket-date";

const DEFAULT_LANG = process.env.ANALYSIS_DEFAULT_LANG ?? "ENGLISH";
const DEFAULT_MODEL_NAME = process.env.ANALYSIS_DEFAULT_MODEL_NAME ?? "openai";
const DEFAULT_MODEL = process.env.ANALYSIS_DEFAULT_MODEL ?? "gpt-4o";

/** Default top-K cap on the capped highest-risk / most-recent set (#391). */
export const OVERVIEW_CAP = 25;

/**
 * Per-customer over-fetch bound for the threat-story and report fan-outs.
 *
 * Priority/scores live in the customer DB while the lifecycle/recency lives in
 * the auth DB, so a true priority-first top-K of the lifecycle-eligible set
 * cannot be expressed in one query without #392's `story_analysis_state`
 * priority denormalization. Until that lands we enumerate the lifecycle-
 * eligible keys (`ready`/`dirty`) from the auth DB FIRST, then fetch only
 * those keys from the customer DB ORDERED BY PRIORITY (not recency) and bound
 * THAT result to the top `FETCH_CAP`. Because the eligible intersection is
 * applied before the `LIMIT`, archived/pending/missing-state rows never enter
 * the over-fetch window: the bound is the top-K of the eligible set, so a row
 * only falls outside it if a customer has more than `FETCH_CAP` lifecycle-
 * eligible HIGHER-priority rows — the legitimate bounded-top-K long tail the
 * issue routes to the single-customer list pages, not a lifecycle artifact.
 * The disclosure COUNT is the exact lifecycle count from the auth DB and is
 * unaffected by this bound. Generous by default; tunable via env.
 */
const FETCH_CAP = (() => {
  const raw = process.env.ANALYSIS_OVERVIEW_FETCH_CAP;
  if (!raw) return 500;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : 500;
})();

export type OverviewSurface = "reports" | "stories" | "events";

/** Surface → the permission a customer must hold to be counted/listed. */
export const SURFACE_PERMISSION: Record<OverviewSurface, string> = {
  reports: "reports:read",
  stories: "analyses:read",
  events: "analyses:read",
};

export interface ReportOverviewRow {
  customerId: string;
  customerName: string;
  period: PeriodKind;
  /** `YYYY-MM-DD`; the synthetic `1970-01-01` for LIVE. */
  bucketDate: string;
  /** Bucket tz — pinned on the detail link (`?tz=`) so it doesn't 404. */
  tz: string;
  /** Displayed (trust guardrail: report rows show tier ONLY, #386). */
  priorityTier: PriorityTier;
  /** Ordering only — the numeric aggregate is NOT displayed for reports. */
  aggregateSeverityScore: number;
  /** Ordering only — not displayed. */
  aggregateLikelihoodScore: number;
  requestedAt: Date;
}

export interface StoryOverviewRow {
  customerId: string;
  customerName: string;
  storyId: string;
  priorityTier: PriorityTier;
  /** Leaf rows MAY show their score (#386 guardrail). */
  severityScore: number;
  likelihoodScore: number;
  /** `last_ready_at` falling back to `updated_at`. */
  recencyAt: Date;
}

export interface EventOverviewRow {
  customerId: string;
  customerName: string;
  aiceId: string;
  eventKey: string;
  priorityTier: PriorityTier;
  severityScore: number;
  likelihoodScore: number;
  requestedAt: Date;
  /** Canonical variant — pinned on the link so the detail page resolves. */
  lang: string;
  modelName: string;
  model: string;
}

/** A customer whose DB fan-out failed; surfaced so counts aren't silently
 *  zeroed and the operator sees which customer degraded. */
export interface FailedCustomer {
  id: string;
  name: string;
}

export interface SurfaceResult<T> {
  /** The capped, merged, high-risk-first rows (≤ cap). */
  items: T[];
  /**
   * Total matching rows across every permitted, reachable customer — the
   * disclosure count. Excludes inaccessible customers, customers lacking the
   * surface permission, and customers whose DB was unreachable.
   */
  totalCount: number;
  /** Customers whose fan-out failed (degraded, not counted). */
  failedCustomers: FailedCustomer[];
}

export type CrossCustomerOverviewOutcome =
  | { kind: "unauthorized" }
  /** Bridge session — cross-customer surfaces are N/A (#390). */
  | { kind: "bridge" }
  | {
      kind: "ok";
      reports?: SurfaceResult<ReportOverviewRow>;
      stories?: SurfaceResult<StoryOverviewRow>;
      events?: SurfaceResult<EventOverviewRow>;
    };

export interface CrossCustomerOverviewInput {
  /** Resolved, access-only scope from WS1's `loadScopePage`. */
  scopeCustomerIds: string[];
  /** Which surfaces to aggregate. `/overview` requests all three. */
  surfaces: OverviewSurface[];
  /** Top-K cap (default {@link OVERVIEW_CAP}). */
  cap?: number;
}

// ---------------------------------------------------------------------------
// Ranking — high-risk first, by integer priority rank (never raw tier text).
// ---------------------------------------------------------------------------

interface RiskKey {
  tier: PriorityTier;
  severity: number;
  likelihood: number;
  /** Recency as epoch ms (descending). */
  recencyMs: number;
  /** Stable, deterministic final tiebreak (ascending). */
  id: string;
}

/**
 * Compare two risk keys, high-risk first: `priority_rank desc, severity desc,
 * likelihood desc, recency desc, id asc`. Returns < 0 when `a` should sort
 * before `b`. Priority uses `tierRank` (integer), never the raw tier text.
 */
export function compareRisk(a: RiskKey, b: RiskKey): number {
  const tier = tierRank(b.tier) - tierRank(a.tier);
  if (tier !== 0) return tier;
  if (a.severity !== b.severity) return b.severity - a.severity;
  if (a.likelihood !== b.likelihood) return b.likelihood - a.likelihood;
  if (a.recencyMs !== b.recencyMs) return b.recencyMs - a.recencyMs;
  if (a.id < b.id) return -1;
  if (a.id > b.id) return 1;
  return 0;
}

function reportKey(r: ReportOverviewRow): RiskKey {
  return {
    tier: r.priorityTier,
    severity: r.aggregateSeverityScore,
    likelihood: r.aggregateLikelihoodScore,
    recencyMs: r.requestedAt.getTime(),
    id: `${r.customerId}|${r.period}|${r.bucketDate}|${r.tz}`,
  };
}

function storyKey(r: StoryOverviewRow): RiskKey {
  return {
    tier: r.priorityTier,
    severity: r.severityScore,
    likelihood: r.likelihoodScore,
    recencyMs: r.recencyAt.getTime(),
    id: `${r.customerId}|${r.storyId}`,
  };
}

function eventKey(r: EventOverviewRow): RiskKey {
  return {
    tier: r.priorityTier,
    severity: r.severityScore,
    likelihood: r.likelihoodScore,
    recencyMs: r.requestedAt.getTime(),
    id: `${r.customerId}|${r.aiceId}|${r.eventKey}`,
  };
}

/** Sort (high-risk first) and cap a merged row set. Pure; unit-tested. */
export function rankAndCap<T>(
  rows: T[],
  toKey: (row: T) => RiskKey,
  cap: number,
): T[] {
  return [...rows]
    .sort((a, b) => compareRisk(toKey(a), toKey(b)))
    .slice(0, cap);
}

// ---------------------------------------------------------------------------
// Permission filter — intersect scope ∩ surface-permission.
// ---------------------------------------------------------------------------

/**
 * The in-scope customers that hold a surface permission. Iterating the raw
 * scope is insufficient (it is access-only); a customer the user can see but
 * not read must not contribute rows OR counts. Pure; unit-tested.
 */
export function permittedCustomers(
  detailed: AccessibleCustomerDetailed[],
  scopeCustomerIds: Iterable<string>,
  permission: string,
): AccessibleCustomerDetailed[] {
  const scope = new Set(scopeCustomerIds);
  return detailed.filter(
    (c) => scope.has(c.id) && c.permissions.includes(permission),
  );
}

// ---------------------------------------------------------------------------
// Per-customer fetchers — one customer DB each (+ auth DB for stories).
// Each returns the customer's capped top-K rows plus the FULL match count
// (window count computed before the LIMIT, so the cap never understates it).
// ---------------------------------------------------------------------------

interface CustomerSlice<T> {
  rows: T[];
  total: number;
}

// `CASE priority_tier ... END DESC` integer rank for the SQL ORDER BY. Kept
// identical to #392's documented rank so the per-customer pre-sort and the
// app-level `compareRisk` agree on tier order.
const PRIORITY_RANK_SQL = `CASE priority_tier
    WHEN 'CRITICAL' THEN 4
    WHEN 'HIGH' THEN 3
    WHEN 'MEDIUM' THEN 2
    WHEN 'LOW' THEN 1
    ELSE 0 END`;

export async function fetchCustomerReports(
  authPool: Pool,
  customerPool: Pool,
  customerId: string,
  customerName: string,
  cap: number,
  fetchCap: number = FETCH_CAP,
): Promise<CustomerSlice<ReportOverviewRow>> {
  // Reports follow the proven discover/enrich split (`report-index-page-
  // loader.ts`): the auth-DB `periodic_report_state` is the source of truth,
  // the customer-DB `periodic_report_result` is enrichment. Reading the result
  // table alone would surface buckets whose state row is `archived` (or gone)
  // but whose result still lingers — the detail loader 404s exactly those
  // (`report-result-page-loader.ts` returns not_found on missing/archived
  // state), so such rows would render dead links and inflate the count.
  //
  // Step 1 — discover the renderable, non-archived buckets (`ready`/`dirty`)
  // from the auth DB. `pending` (no result yet — nothing to rank or show) and
  // `archived` (retention-removed) are excluded, mirroring the threat-story
  // lifecycle filter. This row set is BOTH the disclosure count AND the
  // eligible key set handed to the customer DB, so the risk `LIMIT` below is
  // applied only after the lifecycle intersection (an archived bucket whose
  // result lingers can never occupy the over-fetch window).
  const stateRes = await authPool.query<{
    period: PeriodKind;
    bucket_date: string;
    tz: string;
  }>(
    `SELECT period, bucket_date::text AS bucket_date, tz
       FROM periodic_report_state
      WHERE customer_id = $1
        AND status IN ('ready', 'dirty')`,
    [customerId],
  );
  const total = stateRes.rows.length;
  if (total === 0) return { rows: [], total: 0 };
  const periods = stateRes.rows.map((r) => r.period);
  const bucketDates = stateRes.rows.map((r) => r.bucket_date);
  const tzs = stateRes.rows.map((r) => r.tz);

  // Step 2 — enrich from the customer DB: the canonical default-variant, non-
  // superseded, latest-generation result per `(period, bucket_date, tz)`,
  // RESTRICTED to the eligible buckets (`JOIN wanted`) BEFORE ranking, then
  // ordered HIGH-RISK FIRST and bounded to the top `fetchCap` (see its doc).
  // Ordering uses the aggregate scores (not displayed); `tz` is carried
  // through to pin the detail link.
  const candRes = await customerPool.query<{
    period: PeriodKind;
    bucket_date: string;
    tz: string;
    priority_tier: PriorityTier;
    aggregate_severity_score: number;
    aggregate_likelihood_score: number;
    requested_at: Date;
  }>(
    `WITH wanted(period, bucket_date, tz) AS (
       SELECT p, d::date, z
         FROM unnest($5::text[], $6::date[], $7::text[]) AS u(p, d, z)
     ),
     canonical AS (
       SELECT DISTINCT ON (r.period, r.bucket_date, r.tz)
              r.period, r.bucket_date::text AS bucket_date, r.tz,
              r.priority_tier,
              r.aggregate_severity_score, r.aggregate_likelihood_score,
              r.requested_at
         FROM periodic_report_result r
         JOIN wanted w
           ON w.period = r.period
          AND w.bucket_date = r.bucket_date
          AND w.tz = r.tz
        WHERE r.customer_id = $1
          AND r.lang = $2 AND r.model_name = $3 AND r.model = $4
          AND r.superseded_at IS NULL
        ORDER BY r.period, r.bucket_date, r.tz, r.generation DESC
     )
     SELECT period, bucket_date, tz, priority_tier,
            aggregate_severity_score, aggregate_likelihood_score, requested_at
       FROM canonical
      ORDER BY ${PRIORITY_RANK_SQL} DESC,
               aggregate_severity_score DESC, aggregate_likelihood_score DESC,
               requested_at DESC, period ASC, bucket_date ASC, tz ASC
      LIMIT $8`,
    [
      customerId,
      DEFAULT_LANG,
      DEFAULT_MODEL_NAME,
      DEFAULT_MODEL,
      periods,
      bucketDates,
      tzs,
      fetchCap,
    ],
  );

  const rows: ReportOverviewRow[] = candRes.rows.map((r) => ({
    customerId,
    customerName,
    period: r.period,
    bucketDate: r.bucket_date,
    tz: r.tz,
    priorityTier: r.priority_tier,
    aggregateSeverityScore: r.aggregate_severity_score,
    aggregateLikelihoodScore: r.aggregate_likelihood_score,
    requestedAt: r.requested_at,
  }));
  return { rows: rankAndCap(rows, reportKey, cap), total };
}

export async function fetchCustomerEvents(
  pool: Pool,
  customerId: string,
  customerName: string,
  cap: number,
): Promise<CustomerSlice<EventOverviewRow>> {
  // Customer DB only. `event_analysis_result` has no `customer_id` column —
  // the DB the row came from IS the customer attribution, so no
  // `detection_events` join is needed. Canonical row per `(aice_id,
  // event_key)`: default variant, latest generation, not superseded.
  const res = await pool.query<{
    aice_id: string;
    event_key: string;
    priority_tier: PriorityTier;
    severity_score: number;
    likelihood_score: number;
    requested_at: Date;
    lang: string;
    model_name: string;
    model: string;
    total_count: string;
  }>(
    `WITH canonical AS (
       SELECT DISTINCT ON (aice_id, event_key)
              aice_id::text AS aice_id,
              event_key::text AS event_key,
              priority_tier, severity_score, likelihood_score, requested_at,
              lang, model_name, model
         FROM event_analysis_result
        WHERE lang = $1 AND model_name = $2 AND model = $3
          AND superseded_at IS NULL
        ORDER BY aice_id, event_key, generation DESC
     )
     SELECT aice_id, event_key, priority_tier,
            severity_score, likelihood_score, requested_at,
            lang, model_name, model,
            COUNT(*) OVER () AS total_count
       FROM canonical
      ORDER BY ${PRIORITY_RANK_SQL} DESC,
               severity_score DESC, likelihood_score DESC, requested_at DESC,
               aice_id ASC, event_key ASC
      LIMIT $4`,
    [DEFAULT_LANG, DEFAULT_MODEL_NAME, DEFAULT_MODEL, cap],
  );
  const total = res.rows.length > 0 ? Number(res.rows[0].total_count) : 0;
  const rows: EventOverviewRow[] = res.rows.map((r) => ({
    customerId,
    customerName,
    aiceId: r.aice_id,
    eventKey: r.event_key,
    priorityTier: r.priority_tier,
    severityScore: r.severity_score,
    likelihoodScore: r.likelihood_score,
    requestedAt: r.requested_at,
    lang: r.lang,
    modelName: r.model_name,
    model: r.model,
  }));
  return { rows, total };
}

export async function fetchCustomerStories(
  authPool: Pool,
  customerPool: Pool,
  customerId: string,
  customerName: string,
  cap: number,
  fetchCap: number = FETCH_CAP,
): Promise<CustomerSlice<StoryOverviewRow>> {
  // Step 1 — the full lifecycle-eligible set from the auth-DB
  // `story_analysis_state`. `ready`/`dirty` only — `archived` (retention-
  // removed) and `pending` (no result yet) are excluded exactly as the story
  // detail loader hides them. This row set is BOTH the disclosure count AND
  // the eligible key set (carrying each row's recency, `last_ready_at` →
  // `updated_at`, for the final ordering tiebreak) handed to the customer DB,
  // so the risk `LIMIT` below is applied only after the lifecycle
  // intersection — an archived/pending story can never occupy the over-fetch
  // window and hide an eligible high-risk story.
  const stateRes = await authPool.query<{
    story_id: string;
    recency_at: Date;
  }>(
    `SELECT story_id::text AS story_id,
            COALESCE(last_ready_at, updated_at) AS recency_at
       FROM story_analysis_state
      WHERE customer_id = $1
        AND status IN ('ready', 'dirty')`,
    [customerId],
  );
  const total = stateRes.rows.length;
  if (total === 0) return { rows: [], total: 0 };
  const recencyById = new Map<string, Date>();
  for (const r of stateRes.rows) recencyById.set(r.story_id, r.recency_at);
  const eligibleIds = stateRes.rows.map((r) => r.story_id);

  // Step 2 — candidate priority/scores from the customer DB
  // `story_analysis_result`: canonical default variant, latest generation, not
  // superseded, RESTRICTED to the eligible story ids (`story_id = ANY(...)`)
  // BEFORE ranking, then ordered HIGH-RISK FIRST and bounded to the top
  // `fetchCap`. Bounding the eligible set by priority (not recency) keeps the
  // displayed top-K aligned with the acceptance ordering even for a customer
  // with a long story history (#392's denormalization is the unbounded-
  // guarantee path).
  const candRes = await customerPool.query<{
    story_id: string;
    priority_tier: PriorityTier;
    severity_score: number;
    likelihood_score: number;
  }>(
    `WITH canonical AS (
       SELECT DISTINCT ON (story_id)
              story_id::text AS story_id,
              priority_tier, severity_score, likelihood_score
         FROM story_analysis_result
        WHERE customer_id = $1
          AND lang = $2 AND model_name = $3 AND model = $4
          AND superseded_at IS NULL
          AND story_id = ANY($5::bigint[])
        ORDER BY story_id, generation DESC
     )
     SELECT story_id, priority_tier, severity_score, likelihood_score
       FROM canonical
      ORDER BY ${PRIORITY_RANK_SQL} DESC,
               severity_score DESC, likelihood_score DESC, story_id ASC
      LIMIT $6`,
    [
      customerId,
      DEFAULT_LANG,
      DEFAULT_MODEL_NAME,
      DEFAULT_MODEL,
      eligibleIds,
      fetchCap,
    ],
  );

  const rows: StoryOverviewRow[] = [];
  for (const r of candRes.rows) {
    const recencyAt = recencyById.get(r.story_id);
    // The candidate set is already intersected with the eligible ids in SQL;
    // this guards only the degenerate case of a result row with no matching
    // state row (which the `ANY` filter already excludes).
    if (!recencyAt) continue;
    rows.push({
      customerId,
      customerName,
      storyId: r.story_id,
      priorityTier: r.priority_tier,
      severityScore: r.severity_score,
      likelihoodScore: r.likelihood_score,
      recencyAt,
    });
  }
  // Pre-cap per customer using the same key the cross-customer merge applies,
  // so a customer with thousands of ready stories contributes only its own
  // top-K to the merge.
  return { rows: rankAndCap(rows, storyKey, cap), total };
}

// ---------------------------------------------------------------------------
// Fan-out + merge — partial-failure tolerant.
// ---------------------------------------------------------------------------

/**
 * Fan out a per-customer fetcher across the permitted customers, merge the
 * rows (rank + cap), and sum the counts. A single unreachable customer DB
 * degrades to a `failedCustomers` entry rather than zeroing the aggregate or
 * blanking the page (#391 partial-failure policy). Pure over its injected
 * fetcher; unit-tested with fake pools.
 */
export async function aggregateSurface<T>(
  customers: AccessibleCustomerDetailed[],
  fetch: (customer: AccessibleCustomerDetailed) => Promise<CustomerSlice<T>>,
  toKey: (row: T) => RiskKey,
  cap: number,
): Promise<SurfaceResult<T>> {
  const settled = await Promise.allSettled(customers.map((c) => fetch(c)));
  const merged: T[] = [];
  const failedCustomers: FailedCustomer[] = [];
  let totalCount = 0;
  settled.forEach((outcome, i) => {
    const customer = customers[i];
    if (outcome.status === "fulfilled") {
      merged.push(...outcome.value.rows);
      totalCount += outcome.value.total;
    } else {
      failedCustomers.push({ id: customer.id, name: customer.name });
    }
  });
  return { items: rankAndCap(merged, toKey, cap), totalCount, failedCustomers };
}

// ---------------------------------------------------------------------------
// Top-level loader.
// ---------------------------------------------------------------------------

async function resolveAccount(): Promise<
  | { kind: "unauthorized" }
  | { kind: "bridge" }
  | { kind: "ok"; accountId: string }
> {
  const token = await getAuthCookie("general");
  if (!token) return { kind: "unauthorized" };
  let claims: Awaited<ReturnType<typeof verifyJwtFull>>;
  try {
    claims = await verifyJwtFull(token, "general");
  } catch {
    return { kind: "unauthorized" };
  }

  const authPool = getAuthPool();
  try {
    const policy = await getSessionPolicy();
    const session = await validateSession(authPool, claims.sid, policy.general);
    // Bridge sessions cannot read cross-customer surfaces (#390). The page
    // already short-circuits via `loadScopePage`, but the aggregator
    // re-checks off the server session fields as defense in depth.
    if (session.bridgeAiceId !== null || session.bridgeCustomerIds !== null) {
      return { kind: "bridge" };
    }
  } catch {
    return { kind: "unauthorized" };
  }
  return { kind: "ok", accountId: claims.sub };
}

export async function loadCrossCustomerOverview(
  input: CrossCustomerOverviewInput,
): Promise<CrossCustomerOverviewOutcome> {
  const account = await resolveAccount();
  if (account.kind !== "ok") return account;

  const authPool = getAuthPool();
  const detailed = await withTransaction(authPool, (client) =>
    listAccessibleCustomersDetailed(client, account.accountId, null),
  );

  const cap = input.cap ?? OVERVIEW_CAP;
  const scopeIds = input.scopeCustomerIds;
  const wanted = new Set(input.surfaces);
  const result: CrossCustomerOverviewOutcome = { kind: "ok" };

  if (wanted.has("reports")) {
    const customers = permittedCustomers(
      detailed,
      scopeIds,
      SURFACE_PERMISSION.reports,
    );
    result.reports = await aggregateSurface(
      customers,
      (c) =>
        fetchCustomerReports(
          authPool,
          getCustomerRuntimePool(c.id),
          c.id,
          c.name,
          cap,
        ),
      reportKey,
      cap,
    );
  }

  if (wanted.has("stories")) {
    const customers = permittedCustomers(
      detailed,
      scopeIds,
      SURFACE_PERMISSION.stories,
    );
    result.stories = await aggregateSurface(
      customers,
      (c) =>
        fetchCustomerStories(
          authPool,
          getCustomerRuntimePool(c.id),
          c.id,
          c.name,
          cap,
        ),
      storyKey,
      cap,
    );
  }

  if (wanted.has("events")) {
    const customers = permittedCustomers(
      detailed,
      scopeIds,
      SURFACE_PERMISSION.events,
    );
    result.events = await aggregateSurface(
      customers,
      (c) =>
        fetchCustomerEvents(getCustomerRuntimePool(c.id), c.id, c.name, cap),
      eventKey,
      cap,
    );
  }

  return result;
}
