// RFC 0002 Phase 2 (#297) — shared bucket-date validation.
//
// The report API routes and the report detail page all turn a URL
// `bucket_date` segment into a `$N::date` cast against Postgres. A
// segment that passes the `YYYY-MM-DD` shape but names an impossible
// calendar day (e.g. `2026-02-31`) would otherwise reach the query and
// make Postgres raise on the cast — a 500 instead of the intended 404.
// Both surfaces share this calendar-valid check so a bad date is
// rejected before any query runs (#297 review round 5, item 2).

// Capturing groups feed the calendar round-trip below.
export const BUCKET_DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

// LIVE rows are pinned to the synthetic bucket date `1970-01-01`.
export const LIVE_BUCKET_DATE = "1970-01-01";

/**
 * True when `value` is a real ISO calendar date (`YYYY-MM-DD`). Rejects
 * shape mismatches and impossible days (e.g. `2026-02-31`, `2026-13-01`)
 * by round-tripping through a UTC `Date` and confirming the components
 * survive normalization unchanged.
 */
export function isValidBucketDate(value: string): boolean {
  const m = BUCKET_DATE_RE.exec(value);
  if (!m) return false;
  const year = Number(m[1]);
  const month = Number(m[2]);
  const day = Number(m[3]);
  if (month < 1 || month > 12 || day < 1 || day > 31) return false;
  const d = new Date(Date.UTC(year, month - 1, day));
  return (
    d.getUTCFullYear() === year &&
    d.getUTCMonth() === month - 1 &&
    d.getUTCDate() === day
  );
}

export type PeriodKind = "LIVE" | "DAILY" | "WEEKLY" | "MONTHLY";

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

/**
 * RFC 0002 Phase 3 (#298) — derive the `bucket_date` of `period` that
 * contains the calendar day `referenceDate` (`YYYY-MM-DD`). Used by the
 * report detail page's period-tab navigation to point each tab at the
 * bucket overlapping the day the operator is currently viewing.
 *
 *   - LIVE    → the synthetic epoch bucket (`1970-01-01`); LIVE is a
 *               rolling window with no calendar bucket.
 *   - DAILY   → `referenceDate` itself.
 *   - WEEKLY  → the Monday of `referenceDate`'s week, matching Postgres
 *               `date_trunc('week', …)` (ISO weeks start Monday — see
 *               `state.ts` / `analysis-job-worker.ts`).
 *   - MONTHLY → the first day of `referenceDate`'s month, matching
 *               `date_trunc('month', …)`.
 *
 * Pure UTC calendar math: the worker truncates the event-time in the
 * customer tz, but for a navigation affordance the displayed bucket date
 * is read as a plain calendar day, so UTC truncation of that day yields
 * the same `bucket_date` string. Returns `null` for an invalid
 * `referenceDate` so callers can omit a tab rather than link to a broken
 * date.
 */
export function periodBucketDate(
  period: PeriodKind,
  referenceDate: string,
): string | null {
  if (period === "LIVE") return LIVE_BUCKET_DATE;
  if (!isValidBucketDate(referenceDate)) return null;
  const m = BUCKET_DATE_RE.exec(referenceDate);
  if (!m) return null;
  const year = Number(m[1]);
  const month = Number(m[2]);
  const day = Number(m[3]);
  if (period === "DAILY") return referenceDate;
  if (period === "MONTHLY") return `${m[1]}-${m[2]}-01`;
  // WEEKLY — back up to the ISO Monday of the reference day's week.
  const d = new Date(Date.UTC(year, month - 1, day));
  const dow = d.getUTCDay(); // 0=Sun … 6=Sat
  const offset = dow === 0 ? 6 : dow - 1; // days since Monday
  d.setUTCDate(d.getUTCDate() - offset);
  return `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())}`;
}

// ---------------------------------------------------------------------------
// Calendar-day helpers shared by the temporal-navigation surfaces (#505):
// the retention provider (today-in-tz, boundary subtraction) and the
// calendar/neighbor loaders (viewport enumeration). Kept here next to the
// existing bucket-date math so every surface derives bucket starts the same
// way the worker truncates them (UTC calendar days).
// ---------------------------------------------------------------------------

function fmtDay(d: Date): string {
  return `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())}`;
}

/**
 * Format `at` as a `YYYY-MM-DD` calendar day in `tz`. A malformed tz makes
 * `Intl.DateTimeFormat` throw `RangeError`; swallow it and fall back to UTC
 * so a bad stored timezone cannot crash a navigation surface. `en-CA` yields
 * the ISO `YYYY-MM-DD` ordering directly.
 */
export function formatDayInTz(at: Date, tz: string | undefined): string {
  const opts: Intl.DateTimeFormatOptions = {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  };
  try {
    return new Intl.DateTimeFormat("en-CA", {
      timeZone: tz || "UTC",
      ...opts,
    }).format(at);
  } catch {
    return new Intl.DateTimeFormat("en-CA", {
      timeZone: "UTC",
      ...opts,
    }).format(at);
  }
}

/**
 * `YYYY-MM-DD` shifted by `days` (negative allowed), pure UTC calendar math.
 * Returns the input unchanged when it is not a valid calendar date.
 */
export function addCalendarDays(date: string, days: number): string {
  if (!isValidBucketDate(date)) return date;
  const [y, m, d] = date.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + days);
  return fmtDay(dt);
}

/** Every `YYYY-MM-DD` day in the given month (`month` is 1-based). */
export function enumerateMonthDays(year: number, month: number): string[] {
  const days: string[] = [];
  const count = new Date(Date.UTC(year, month, 0)).getUTCDate();
  for (let day = 1; day <= count; day += 1) {
    days.push(`${year}-${pad2(month)}-${pad2(day)}`);
  }
  return days;
}

/** The twelve `YYYY-MM-01` month-start bucket dates of `year`. */
export function enumerateYearMonths(year: number): string[] {
  const months: string[] = [];
  for (let m = 1; m <= 12; m += 1) months.push(`${year}-${pad2(m)}-01`);
  return months;
}

/**
 * Every ISO-Monday week-start `YYYY-MM-DD` whose Monday falls within `year`,
 * matching the WEEKLY bucket key (`date_trunc('week')`). A week is listed
 * under the calendar year of its Monday, so a week straddling the New Year
 * appears once, under the year that contains its start.
 */
export function enumerateYearWeeks(year: number): string[] {
  // Start from the Monday of the week containing Jan 1, then step weekly,
  // keeping only Mondays whose own year is `year`.
  const jan1 = new Date(Date.UTC(year, 0, 1));
  const dow = jan1.getUTCDay();
  const offset = dow === 0 ? 6 : dow - 1;
  const cursor = new Date(jan1);
  cursor.setUTCDate(cursor.getUTCDate() - offset);
  const weeks: string[] = [];
  while (cursor.getUTCFullYear() <= year) {
    if (cursor.getUTCFullYear() === year) weeks.push(fmtDay(cursor));
    cursor.setUTCDate(cursor.getUTCDate() + 7);
  }
  return weeks;
}
