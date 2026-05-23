/**
 * Strict RFC 3339 / ISO 8601 date-time parser for the BFF's incoming
 * `event_data.event_time` wire field. The matching upstream parser is
 * `jiff::Timestamp` in aimer's `auth-mtls` resolver — this validator's
 * job is to keep the BFF from issuing an `analyzeEvent` call that the
 * upstream side will reject for shape reasons alone.
 *
 * Naive local times (no offset) are rejected: aimer rendering would
 * otherwise depend on the BFF process's timezone, which is not part of
 * the wire contract.
 *
 * Fractional seconds are capped at 9 digits because `jiff::Timestamp`
 * on the upstream side is nanosecond-precision and rejects anything
 * finer. Catching it here keeps an over-precision payload from
 * reaching `runAnalyzeFlow`'s ingest/write step and poisoning the
 * stored `redacted_event.event_time` that later retries prefer.
 */
const RFC3339_RE =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,9})?(Z|[+-]\d{2}:\d{2})$/;

/**
 * Validate an `event_time` wire value. Returns the original string on
 * success (so upstream offset / fractional-second representation is
 * preserved exactly), or `null` if the value is missing, mis-shaped, or
 * names an impossible calendar moment (Feb 30, month 13, hour 25, …).
 *
 * Shape rejection alone is not enough: the regex above accepts impossible
 * dates like `2026-02-30`. After the regex passes we therefore construct
 * a UTC date from the captured fields and require it to round-trip to
 * the same components, so JS's silent month/day rollover (Feb 30 →
 * Mar 2) cannot leak through.
 */
export function parseEventTime(raw: unknown): string | null {
  if (typeof raw !== "string" || raw.length === 0) return null;
  const m = RFC3339_RE.exec(raw);
  if (!m) return null;
  const year = Number(m[1]);
  const month = Number(m[2]);
  const day = Number(m[3]);
  const hour = Number(m[4]);
  const minute = Number(m[5]);
  const second = Number(m[6]);

  // Calendar round-trip: rejects month=13, day=32, Feb 30, hour=24, etc.
  // Date.UTC silently rolls overflow into the next month/day/hour, so the
  // equality check is what actually does the validation.
  const utcMillis = Date.UTC(year, month - 1, day, hour, minute, second);
  if (!Number.isFinite(utcMillis)) return null;
  const date = new Date(utcMillis);
  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day ||
    date.getUTCHours() !== hour ||
    date.getUTCMinutes() !== minute ||
    date.getUTCSeconds() !== second
  ) {
    return null;
  }

  // Validate the numeric offset bounds. Per RFC 3339, time-numoffset is
  // `("+" / "-") time-hour ":" time-minute` with hour 00-23 and minute
  // 00-59. The regex pins HH:MM shape; this check pins the value range.
  const offset = m[7];
  if (offset !== "Z") {
    const offsetHour = Number(offset.slice(1, 3));
    const offsetMinute = Number(offset.slice(4, 6));
    if (offsetHour >= 24 || offsetMinute >= 60) return null;
  }

  return raw;
}
