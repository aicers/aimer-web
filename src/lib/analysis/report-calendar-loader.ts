// RFC 0004 (#505) — temporal report navigation loaders.
//
// Two read paths the index loader (`report-index-page-loader.ts`) does not
// cover, both subject-generic so a group provider plugs in later:
//
//   1. `discoverCalendarBuckets` — per-bucket existence for a single
//      viewport range (one month for DAILY, one year for WEEKLY/MONTHLY).
//      Unlike the hub's `PERIOD_CAPS`-bound "recent" preview, this reaches
//      EVERY retained bucket, but is bounded by the requested viewport, so
//      unbounded retention (`analysis_days = NULL`) never implies an
//      unbounded fetch. Each enumerated bucket is classified
//      has-report / none / out-of-retention / future for the calendar grid.
//
//   2. `loadReportNeighbors` — the nearest has-report bucket older / newer
//      than the open one, for the detail page's within-period prev/next.
//
// "Has-report" follows the issue's settled predicate: a non-superseded
// `periodic_report_result` at the default model variant (any language — the
// detail page's viewer→English→any fallback always resolves when one exists)
// that ALSO has a `ready`/`dirty` `periodic_report_state` row at the same
// (bucket_date, tz). `ready`/`dirty` are the navigable candidates; a `pending`
// state is NOT. A bucket whose only state is `pending` is non-navigable even
// when a (drifted) result survives, because the worker has not yet declared the
// bucket ready — the issue calls out "pending-only" buckets as `none`.
//
// Grounding on the result row avoids the "looked has-report but opens to
// `pending`" mismatch; intersecting with a `ready`/`dirty` state row avoids the
// reverse drift — a stale customer-DB result surviving while the auth-side
// state is missing, `pending`, or `archived` (the two pools can diverge).
// `pending`-only, result-less `ready`/`dirty`, gap, and result-without-eligible-
// state buckets are all non-navigable, consistently in the calendar and
// prev/next.
//
// This predicate is deliberately STRICTER than the detail route's own 404 gate,
// which rejects only a missing/archived state and renders a `pending`+result
// bucket. The divergence is intentional and safe: the calendar never links a
// non-navigable cell, so a `pending`+result bucket is simply not reachable via
// the temporal-nav surfaces (it stays reachable by direct URL and the hub's
// "recent" preview), and no green cell or prev/next step ever lands on one.
//
// Auth DB (state) and the customer DB (results) are separate pools and cannot
// be JOINed, so discovery reads both for the viewport range and intersects in
// JS (same cross-pool constraint as the index loader).

import "server-only";

import type { Pool } from "pg";
import { authorize } from "@/lib/auth/authorization";
import { getAuthCookie } from "@/lib/auth/cookies";
import { verifyJwtFull } from "@/lib/auth/jwt";
import { getSessionPolicy } from "@/lib/auth/session-policy";
import { validateSession } from "@/lib/auth/session-validator";
import { getAuthPool, withTransaction } from "@/lib/db/client";
import { getCustomerRuntimePool } from "@/lib/db/customer-runtime-pool";
import { resolveDefaultModel } from "./default-model";
import {
  enumerateMonthDays,
  enumerateYearMonths,
  enumerateYearWeeks,
  type PeriodKind,
} from "./report-bucket-date";
import {
  createCustomerRetentionProvider,
  type SubjectRetentionProvider,
} from "./subject-retention-provider";

// Calendar periods only — LIVE is the single rolling "now" bucket and has
// no calendar (and no prev/next).
export type CalendarPeriod = "DAILY" | "WEEKLY" | "MONTHLY";

export type CalendarCellState =
  | "has-report"
  | "none"
  | "out-of-retention"
  | "future";

export interface CalendarCell {
  /** Bucket-START date (`YYYY-MM-DD`): the day (DAILY), ISO Monday (WEEKLY),
   * or first-of-month (MONTHLY). */
  bucketDate: string;
  state: CalendarCellState;
  /**
   * The `tz` to pin on the detail link, from the result row backing this
   * bucket. Null unless `state === "has-report"` (only navigable cells link).
   */
  tz: string | null;
}

export type CalendarViewport =
  | { kind: "month"; year: number; month: number } // DAILY
  | { kind: "year"; year: number }; // WEEKLY / MONTHLY

export interface ReportCalendarData {
  period: CalendarPeriod;
  viewport: CalendarViewport;
  cells: CalendarCell[];
  /** Oldest navigable bucket-start (inclusive), or null for unbounded. */
  oldestNavigableDate: string | null;
  /** Today in the subject's timezone (`YYYY-MM-DD`). */
  today: string;
}

export type CalendarPageOutcome =
  | { kind: "unauthorized" }
  | { kind: "forbidden" }
  | { kind: "ok"; data: ReportCalendarData };

export interface CalendarPageInput {
  subjectId: string;
  period: CalendarPeriod;
  viewport: CalendarViewport;
}

// --- Viewport helpers ------------------------------------------------------

/** Enumerate every bucket-start in `viewport` for `period`, in ascending order. */
function enumerateViewport(
  period: CalendarPeriod,
  viewport: CalendarViewport,
): string[] {
  if (period === "DAILY") {
    if (viewport.kind !== "month") return [];
    return enumerateMonthDays(viewport.year, viewport.month);
  }
  if (viewport.kind !== "year") return [];
  return period === "MONTHLY"
    ? enumerateYearMonths(viewport.year)
    : enumerateYearWeeks(viewport.year);
}

/** Inclusive [start, end] bucket-start range covering the viewport. */
function viewportRange(
  buckets: string[],
): { start: string; end: string } | null {
  if (buckets.length === 0) return null;
  return { start: buckets[0], end: buckets[buckets.length - 1] };
}

// --- Pure discovery (exported for db tests, no auth preamble) ---------------

/**
 * Classify every bucket in the viewport. Subject-generic: the retention
 * boundary comes from the injected `provider`, and results from the
 * `customerPool` (the subject's report DB). Enrichment is best-effort — a
 * customer-DB failure degrades has-report cells to "none" rather than
 * failing the page.
 */
export async function discoverCalendarBuckets(args: {
  authPool: Pool;
  customerPool: Pool;
  subjectId: string;
  period: CalendarPeriod;
  viewport: CalendarViewport;
  provider: SubjectRetentionProvider;
}): Promise<ReportCalendarData> {
  const { authPool, customerPool, subjectId, period, viewport, provider } =
    args;

  const buckets = enumerateViewport(period, viewport);
  const range = viewportRange(buckets);
  const { oldestNavigableDate, today } = await provider.resolveBoundary(period);

  // has-report lookup: a non-superseded result at the default variant (any
  // language) that ALSO has a `ready`/`dirty` state row at the same
  // (bucket_date, tz) — the issue's navigable predicate, so a green cell never
  // opens to a non-navigable bucket. Both reads are viewport-range-bounded, and
  // additionally clamped to the retention boundary: a bucket before
  // `oldestNavigableDate` can only ever be greyed (out-of-retention), so there
  // is no point fetching its rows. The full viewport is still enumerated below
  // for the greyed cells; only the result/state QUERIES skip the aged-out span.
  // This keeps discovery retention-bounded even for a year viewport with a
  // short retention window. Best-effort — leave the map empty on any failure.
  const queryStart =
    oldestNavigableDate !== null && range && oldestNavigableDate > range.start
      ? oldestNavigableDate
      : range?.start;
  const resultTz = new Map<string, string>();
  if (range && queryStart !== undefined) {
    try {
      const def = await resolveDefaultModel(subjectId, authPool);
      // `ready`/`dirty` state rows (auth DB) keyed on bucket/tz: these are the
      // navigable candidates. A `pending` state is excluded here — a
      // `pending`-only bucket is non-navigable per the issue, even when a
      // drifted result survives in the customer DB. A missing/archived state is
      // likewise excluded, matching what the detail route would reject.
      const stateRes = await authPool.query<{
        bucket_date: string;
        tz: string;
      }>(
        `SELECT bucket_date::text AS bucket_date, tz
           FROM periodic_report_state
          WHERE subject_id = $1
            AND period = $2
            AND status IN ('ready', 'dirty')
            AND bucket_date BETWEEN $3::date AND $4::date`,
        [subjectId, period, queryStart, range.end],
      );
      const stateKeys = new Set(
        stateRes.rows.map((r) => `${r.bucket_date}|${r.tz}`),
      );
      const { rows } = await customerPool.query<{
        bucket_date: string;
        tz: string;
      }>(
        `SELECT bucket_date::text AS bucket_date, tz
           FROM periodic_report_result
          WHERE subject_id = $1
            AND period = $2
            AND model_name = $3 AND model = $4
            AND superseded_at IS NULL
            AND bucket_date BETWEEN $5::date AND $6::date
          ORDER BY bucket_date, generation DESC`,
        [subjectId, period, def.modelName, def.model, queryStart, range.end],
      );
      // Per bucket, the highest-generation result whose tz also has a live
      // state row wins (rows arrive newest-generation first). A result-only
      // (drifted) bucket never enters the map → stays "none".
      for (const row of rows) {
        if (resultTz.has(row.bucket_date)) continue;
        if (stateKeys.has(`${row.bucket_date}|${row.tz}`)) {
          resultTz.set(row.bucket_date, row.tz);
        }
      }
    } catch {
      // Degrade to "no results"; cells fall back to "none" within retention.
    }
  }

  const cells: CalendarCell[] = buckets.map((bucketDate) => {
    if (bucketDate > today) {
      return { bucketDate, state: "future", tz: null };
    }
    if (oldestNavigableDate !== null && bucketDate < oldestNavigableDate) {
      return { bucketDate, state: "out-of-retention", tz: null };
    }
    const tz = resultTz.get(bucketDate);
    if (tz !== undefined) {
      return { bucketDate, state: "has-report", tz };
    }
    return { bucketDate, state: "none", tz: null };
  });

  return { period, viewport, cells, oldestNavigableDate, today };
}

// --- Page loader (auth preamble + discovery) -------------------------------

export async function loadReportCalendarPage(
  input: CalendarPageInput,
): Promise<CalendarPageOutcome> {
  const token = await getAuthCookie("general");
  if (!token) return { kind: "unauthorized" };
  let claims: Awaited<ReturnType<typeof verifyJwtFull>>;
  try {
    claims = await verifyJwtFull(token, "general");
  } catch {
    return { kind: "unauthorized" };
  }

  const authPool = getAuthPool();

  let bridgeAiceId: string | null = null;
  let bridgeCustomerIds: string[] | null = null;
  try {
    const policy = await getSessionPolicy();
    const session = await validateSession(authPool, claims.sid, policy.general);
    bridgeAiceId = session.bridgeAiceId;
    bridgeCustomerIds = session.bridgeCustomerIds;
  } catch {
    return { kind: "unauthorized" };
  }

  const auth = await withTransaction(authPool, (client) =>
    authorize(client, "general", claims.sub, "reports:read", {
      customerId: input.subjectId,
      operationKind: "read",
      // Bridge sessions cannot read these surfaces (round-15 S3), matching
      // the detail and index loaders.
      allowInBridge: false,
      bridgeScope: bridgeCustomerIds
        ? { aiceId: bridgeAiceId ?? "", customerIds: bridgeCustomerIds }
        : null,
    }),
  );
  if (!auth.authorized) {
    // Same mapping as the detail/index loaders: bridge denial and
    // member-without-permission → 403; non-membership / non-existent → 404.
    if (auth.reason === "bridge_not_allowed") return { kind: "forbidden" };
    if (auth.permissions !== undefined) return { kind: "forbidden" };
    return { kind: "unauthorized" };
  }

  const data = await discoverCalendarBuckets({
    authPool,
    customerPool: getCustomerRuntimePool(input.subjectId),
    subjectId: input.subjectId,
    period: input.period,
    viewport: input.viewport,
    provider: createCustomerRetentionProvider(input.subjectId, authPool),
  });
  return { kind: "ok", data };
}

// --- Within-period prev/next neighbors -------------------------------------

export interface NeighborBucket {
  bucketDate: string;
  tz: string;
}

export interface ReportNeighbors {
  /** Nearest has-report bucket older than the open one, within retention. */
  prev: NeighborBucket | null;
  /** Nearest has-report bucket newer than the open one (null = newest). */
  next: NeighborBucket | null;
  /**
   * True ONLY when the older step is blocked by the retention boundary — an
   * older report exists but falls outside the retained range. This is the
   * explicit "no older reports retained" state the detail page renders instead
   * of a dead link. It is deliberately NOT set when `prev` is null for other
   * reasons — the open bucket is simply the first report (no older bucket at
   * all, or unbounded retention), or a best-effort lookup failed — since those
   * are not retention stops and the UI shows no affordance rather than falsely
   * blaming retention. Always false for LIVE (no temporal nav).
   */
  olderStop: boolean;
}

// Cap on how many drifted (result-without-live-state) buckets the neighbor
// probe will skip before giving up, so a long run of stale customer-DB rows
// can't loop unbounded. Consistent state/result is the norm, so the first
// probe almost always resolves; this is a safety backstop, not a budget.
const NEIGHBOR_PROBE_LIMIT = 16;

/**
 * Step from `from` to the nearest navigable bucket in one direction. A bucket
 * is navigable only when a non-superseded default-variant result AND a
 * `ready`/`dirty` state row coexist at the same (bucket_date, tz) — the issue's
 * navigable predicate. The result is probed nearest-first (auth/customer pools
 * are separate, so this can't be one JOIN); a result whose state is missing,
 * `pending`, or `archived` is skipped and the probe advances past its date
 * until an eligible one is found, the direction is exhausted, or the cap hits.
 */
async function findNeighbor(args: {
  authPool: Pool;
  customerPool: Pool;
  subjectId: string;
  period: PeriodKind;
  def: { modelName: string; model: string };
  from: string;
  direction: "older" | "newer";
  /** Retention floor for the older direction (inclusive); null = unbounded. */
  lowerBound: string | null;
}): Promise<NeighborBucket | null> {
  const { authPool, customerPool, subjectId, period, def, lowerBound } = args;
  const older = args.direction === "older";
  let cursor = args.from;
  for (let probe = 0; probe < NEIGHBOR_PROBE_LIMIT; probe++) {
    const res = await customerPool.query<{ bucket_date: string; tz: string }>(
      `SELECT bucket_date::text AS bucket_date, tz
         FROM periodic_report_result
        WHERE subject_id = $1
          AND period = $2
          AND model_name = $3 AND model = $4
          AND superseded_at IS NULL
          AND bucket_date ${older ? "<" : ">"} $5::date
          AND ($6::date IS NULL OR bucket_date >= $6::date)
        ORDER BY bucket_date ${older ? "DESC" : "ASC"}, generation DESC
        LIMIT 1`,
      [subjectId, period, def.modelName, def.model, cursor, lowerBound],
    );
    if (res.rows.length === 0) return null;
    const { bucket_date, tz } = res.rows[0];
    const state = await authPool.query(
      `SELECT 1 FROM periodic_report_state
        WHERE subject_id = $1 AND period = $2
          AND bucket_date = $3::date AND tz = $4
          AND status IN ('ready', 'dirty')
        LIMIT 1`,
      [subjectId, period, bucket_date, tz],
    );
    if (state.rows.length > 0) return { bucketDate: bucket_date, tz };
    // Non-navigable (result with a missing / `pending` / `archived` state)
    // bucket. Skip its date and keep probing in the same direction.
    cursor = bucket_date;
  }
  return null;
}

/**
 * Resolve the nearest has-report buckets on either side of `bucketDate`,
 * subject-generic via the injected `provider`. The caller (detail page) has
 * already authorized the read, so this performs no auth preamble. "Has-report"
 * uses the same result + `ready`/`dirty`-state predicate as the calendar, so
 * prev/next never link to a non-navigable bucket. Older neighbors are clamped
 * to the retention boundary; the newer side is unbounded (it stops naturally
 * at the most recent report). Best-effort: a read failure yields no neighbors
 * — and, critically, `olderStop: false`, never falsely blaming retention.
 */
export async function loadReportNeighbors(args: {
  authPool: Pool;
  customerPool: Pool;
  subjectId: string;
  period: PeriodKind;
  bucketDate: string;
  provider?: SubjectRetentionProvider;
}): Promise<ReportNeighbors> {
  const { authPool, customerPool, subjectId, period, bucketDate } = args;
  if (period === "LIVE") return { prev: null, next: null, olderStop: false };

  const provider =
    args.provider ?? createCustomerRetentionProvider(subjectId, authPool);

  try {
    // Inside the try so a boundary or default-model read failure degrades to
    // "no neighbors" rather than crashing the detail page.
    const { oldestNavigableDate } = await provider.resolveBoundary(period);
    const def = await resolveDefaultModel(subjectId, authPool);
    const prev = await findNeighbor({
      authPool,
      customerPool,
      subjectId,
      period,
      def,
      from: bucketDate,
      direction: "older",
      lowerBound: oldestNavigableDate,
    });
    const next = await findNeighbor({
      authPool,
      customerPool,
      subjectId,
      period,
      def,
      from: bucketDate,
      direction: "newer",
      lowerBound: null,
    });

    // Only claim the retention boundary when an older NAVIGABLE report actually
    // exists beyond it. With no prev under unbounded retention (or simply no
    // older report at all), this is the first report — show no affordance, not
    // a "no older retained" stop. The evidence probe reuses `findNeighbor` from
    // the boundary going older with no lower bound, so it applies the SAME
    // result+`ready`/`dirty`-state predicate as prev/next: a bare result whose
    // state is missing, `pending`, or archived is not evidence that a navigable
    // report aged out, and must not make the UI falsely blame retention (the
    // same cross-DB drift class as the prev/next gating, applied to the stop).
    let olderStop = false;
    if (prev === null && oldestNavigableDate !== null) {
      const olderNavigable = await findNeighbor({
        authPool,
        customerPool,
        subjectId,
        period,
        def,
        from: oldestNavigableDate,
        direction: "older",
        lowerBound: null,
      });
      olderStop = olderNavigable !== null;
    }
    return { prev, next, olderStop };
  } catch {
    // Lookup failed: surface no neighbors and — unlike a true boundary — no
    // older stop, so the UI does not misattribute an unknown failure to
    // retention.
    return { prev: null, next: null, olderStop: false };
  }
}
