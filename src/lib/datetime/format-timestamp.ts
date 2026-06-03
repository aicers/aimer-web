/**
 * Central, pure timestamp-formatting utility (#400).
 *
 * Input instants are always UTC (`TIMESTAMPTZ`, RFC 3339 with offset).
 * User-facing timestamps are displayed in the resolution order
 * `accounts.timezone` → browser timezone → UTC — parallel to the language
 * resolution order (parent #386 "Timestamp display timezone" contract).
 *
 * This module does NOT fetch anything: the caller (the `<Timestamp>`
 * component / its provider) supplies the account timezone, which keeps the
 * util usable from both the dashboard and admin auth contexts. The display
 * timezone is *distinct* from the report bucket tz (`customers.timezone`,
 * which defines DAILY/WEEKLY/MONTHLY bucket boundaries and is report
 * identity) — bucket tz is unchanged; this only localizes the display of
 * individual instants.
 */

/** Whether `tz` is an IANA timezone `Intl` accepts (a bad value throws). */
export function isValidTimeZone(tz: string): boolean {
  if (!tz) return false;
  try {
    new Intl.DateTimeFormat("en-CA", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/** The browser/runtime timezone, or `undefined` if it cannot be read. */
function getRuntimeTimeZone(): string | undefined {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || undefined;
  } catch {
    return undefined;
  }
}

/**
 * Resolve the display timezone as `accountTimezone` → browser/runtime
 * timezone → `UTC`. Each candidate must be a valid IANA zone to be used;
 * an invalid one is skipped rather than allowed to throw downstream.
 *
 * `browserTimeZone` is injectable so the resolution order is testable
 * without depending on the host's actual zone; when omitted it is read
 * from `Intl.DateTimeFormat().resolvedOptions().timeZone`.
 */
export function resolveDisplayTimeZone(
  accountTimezone: string | null | undefined,
  browserTimeZone: string | undefined = getRuntimeTimeZone(),
): string {
  if (accountTimezone && isValidTimeZone(accountTimezone)) {
    return accountTimezone;
  }
  if (browserTimeZone && isValidTimeZone(browserTimeZone)) {
    return browserTimeZone;
  }
  return "UTC";
}

/**
 * Format a UTC instant in an already-resolved display `timeZone` as
 * `YYYY-MM-DD HH:mm <TZ>` (24-hour, with an explicit timezone label, e.g.
 * `2026-06-03 14:05 GMT+9`). Resolution (`resolveDisplayTimeZone`) is kept
 * separate so the `<Timestamp>` component can resolve once on the client
 * and render a deterministic UTC value on the server / first paint.
 *
 * A malformed `timeZone` makes `Intl.DateTimeFormat` throw `RangeError`;
 * swallow it and fall back to UTC so a bad zone cannot crash a render. An
 * invalid `Date` yields an empty string.
 */
export function formatTimestamp(
  instant: Date | string,
  timeZone: string,
): string {
  const date = typeof instant === "string" ? new Date(instant) : instant;
  if (Number.isNaN(date.getTime())) return "";

  const opts: Intl.DateTimeFormatOptions = {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
    timeZoneName: "short",
  };

  let parts: Intl.DateTimeFormatPart[];
  try {
    parts = new Intl.DateTimeFormat("en-CA", {
      timeZone,
      ...opts,
    }).formatToParts(date);
  } catch {
    parts = new Intl.DateTimeFormat("en-CA", {
      timeZone: "UTC",
      ...opts,
    }).formatToParts(date);
  }

  const get = (type: Intl.DateTimeFormatPartTypes): string =>
    parts.find((p) => p.type === type)?.value ?? "";

  const date_ = `${get("year")}-${get("month")}-${get("day")}`;
  const time = `${get("hour")}:${get("minute")}`;
  const tzLabel = get("timeZoneName");
  return tzLabel ? `${date_} ${time} ${tzLabel}` : `${date_} ${time}`;
}
