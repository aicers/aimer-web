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
// "Has-report" is grounded on the RESULT row (a non-superseded
// `periodic_report_result` at the default model variant, any language —
// the detail page's viewer→English→any fallback always resolves when one
// exists), NOT the `periodic_report_state` value. This is the same predicate
// the detail loader effectively applies, so a bucket never looks navigable
// in the calendar but returns `pending` on open: `pending`-only and
// result-less `ready`/`dirty` buckets are non-navigable.
//
// Auth DB and the customer DB are separate pools and cannot be JOINed, so
// discovery enumerates the viewport in JS and looks up results in the
// customer DB in a second step (same constraint as the index loader).

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

  // has-report lookup: a non-superseded result at the default variant, any
  // language. Viewport-range-bounded so unbounded retention never widens the
  // query. Best-effort — leave the map empty on any failure.
  const resultTz = new Map<string, string>();
  if (range) {
    try {
      const def = await resolveDefaultModel(subjectId, authPool);
      const { rows } = await customerPool.query<{
        bucket_date: string;
        tz: string;
      }>(
        `SELECT DISTINCT ON (bucket_date)
                bucket_date::text AS bucket_date, tz
           FROM periodic_report_result
          WHERE subject_id = $1
            AND period = $2
            AND model_name = $3 AND model = $4
            AND superseded_at IS NULL
            AND bucket_date BETWEEN $5::date AND $6::date
          ORDER BY bucket_date, generation DESC`,
        [subjectId, period, def.modelName, def.model, range.start, range.end],
      );
      for (const row of rows) resultTz.set(row.bucket_date, row.tz);
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
   * True when there is no navigable older bucket — the explicit
   * retention-boundary / oldest stop the detail page renders instead of a
   * dead link. Always false for LIVE (no temporal nav).
   */
  olderStop: boolean;
}

/**
 * Resolve the nearest has-report buckets on either side of `bucketDate`,
 * subject-generic via the injected `provider`. The caller (detail page) has
 * already authorized the read, so this performs no auth preamble. Older
 * neighbors are clamped to the retention boundary; the newer side is
 * unbounded (it stops naturally at the most recent report). Best-effort: a
 * customer-DB failure yields no neighbors rather than a thrown page.
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
    const prevRes = await customerPool.query<{
      bucket_date: string;
      tz: string;
    }>(
      `SELECT bucket_date::text AS bucket_date, tz
         FROM periodic_report_result
        WHERE subject_id = $1
          AND period = $2
          AND model_name = $3 AND model = $4
          AND superseded_at IS NULL
          AND bucket_date < $5::date
          AND ($6::date IS NULL OR bucket_date >= $6::date)
        ORDER BY bucket_date DESC, generation DESC
        LIMIT 1`,
      [
        subjectId,
        period,
        def.modelName,
        def.model,
        bucketDate,
        oldestNavigableDate,
      ],
    );
    const nextRes = await customerPool.query<{
      bucket_date: string;
      tz: string;
    }>(
      `SELECT bucket_date::text AS bucket_date, tz
         FROM periodic_report_result
        WHERE subject_id = $1
          AND period = $2
          AND model_name = $3 AND model = $4
          AND superseded_at IS NULL
          AND bucket_date > $5::date
        ORDER BY bucket_date ASC, generation DESC
        LIMIT 1`,
      [subjectId, period, def.modelName, def.model, bucketDate],
    );
    const prev =
      prevRes.rows.length > 0
        ? { bucketDate: prevRes.rows[0].bucket_date, tz: prevRes.rows[0].tz }
        : null;
    const next =
      nextRes.rows.length > 0
        ? { bucketDate: nextRes.rows[0].bucket_date, tz: nextRes.rows[0].tz }
        : null;
    return { prev, next, olderStop: prev === null };
  } catch {
    return { prev: null, next: null, olderStop: true };
  }
}
