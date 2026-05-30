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
