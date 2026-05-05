/**
 * Strict ISO 8601 parser for trust_registry.expires_at input.
 *
 * Accepts only timezone-explicit datetime strings — either the `Z` suffix
 * (UTC) or an explicit `±HH:MM` offset. Out-of-range calendar values
 * (e.g. `2026-02-30`) are rejected; we do NOT use `new Date(...)`'s
 * permissive normalization, which would silently roll those forward.
 *
 * Intentional behaviors:
 * - empty / `undefined` / `null` → `{ expiresAt: null }` (soft-expiry)
 * - timezone-less datetime (`2026-05-05T12:00:00`) → error
 * - date-only (`2026-05-05`) → error
 * - past timestamps → accepted (operator may "burn" a key on purpose)
 */

const ISO_RE =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,9}))?)?(Z|[+-]\d{2}:\d{2})$/;

const DAYS_IN_MONTH = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];

function isLeapYear(y: number): boolean {
  return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
}

function daysInMonth(year: number, month: number): number {
  if (month === 2 && isLeapYear(year)) return 29;
  return DAYS_IN_MONTH[month - 1] ?? 0;
}

export type ParseExpiresAtResult =
  | { ok: true; expiresAt: Date | null }
  | { ok: false; error: string };

/**
 * Parse an `expiresAt` value from an API request body.
 *
 * Returns `{ ok: true, expiresAt: null }` for empty / missing inputs (the
 * default soft-expiry case) and a `Date` (UTC-normalized) for valid ISO
 * strings. Anything else is a typed validation error.
 */
export function parseExpiresAtInput(value: unknown): ParseExpiresAtResult {
  if (value === undefined || value === null) {
    return { ok: true, expiresAt: null };
  }
  if (typeof value !== "string") {
    return { ok: false, error: "expiresAt must be an ISO 8601 string or null" };
  }
  const trimmed = value.trim();
  if (trimmed === "") {
    return { ok: true, expiresAt: null };
  }

  const match = ISO_RE.exec(trimmed);
  if (!match) {
    return {
      ok: false,
      error:
        "expiresAt must be a timezone-explicit ISO 8601 datetime (e.g. 2026-05-05T12:00:00Z or 2026-05-05T21:00:00+09:00)",
    };
  }

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = match[6] !== undefined ? Number(match[6]) : 0;

  if (
    month < 1 ||
    month > 12 ||
    day < 1 ||
    day > daysInMonth(year, month) ||
    hour > 23 ||
    minute > 59 ||
    second > 59
  ) {
    return {
      ok: false,
      error: `expiresAt is not a valid calendar date/time: ${trimmed}`,
    };
  }

  // After the regex + range checks the string is unambiguous, so
  // `new Date(...)` will not silently normalize anything.
  const date = new Date(trimmed);
  if (Number.isNaN(date.getTime())) {
    return { ok: false, error: `expiresAt could not be parsed: ${trimmed}` };
  }

  return { ok: true, expiresAt: date };
}
