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
 * Format a UTC instant in an already-resolved display `timeZone` as a
 * general, locale-aware date-time. Ported verbatim from aice-web-next's
 * `formatDateTime` (`src/lib/format-date.ts`) so the two products produce
 * byte-identical strings for the same `(instant, timezone)`: it follows the
 * **browser** locale (`undefined`), includes seconds, is 12-hour where the
 * locale dictates, and carries no timezone label — e.g. EN `6/3/2026,
 * 2:05:30 PM`, KO `2026. 6. 3. 오후 2:05:30`.
 *
 * The deliberate `undefined` locale must NOT be "fixed" to the app locale:
 * that asymmetry vs {@link formatDateTimeCompact} is what keeps parity with
 * aice-web-next. Because the result depends on the browser locale (unknown
 * on the server), the `<Timestamp>` component renders {@link
 * formatDateTimePremount} pre-mount and switches to this only after mount.
 */
export function formatDateTime(
  date: string | Date,
  timezone?: string | null,
): string {
  const d = typeof date === "string" ? new Date(date) : date;
  return d.toLocaleString(undefined, {
    timeZone: timezone ?? undefined,
    year: "numeric",
    month: "numeric",
    day: "numeric",
    hour: "numeric",
    minute: "numeric",
    second: "numeric",
  });
}

/**
 * Format a UTC instant in an already-resolved display `timeZone` as a
 * compact date-time for tight surfaces (breadcrumbs, event rows). Ported
 * verbatim from aice-web-next's `formatDateTimeCompact`: it follows the
 * **active app** `locale` and drops year and seconds — e.g. EN `6/3, 2:05
 * PM`, KO `6. 3. 오후 2:05`.
 *
 * Unlike {@link formatDateTime}, the locale is passed in explicitly (the
 * caller supplies next-intl's `useLocale()`); preserve that asymmetry for
 * exact parity with aice-web-next.
 */
export function formatDateTimeCompact(
  date: string | Date,
  timezone?: string | null,
  locale?: string | null,
): string {
  const d = typeof date === "string" ? new Date(date) : date;
  return d.toLocaleString(locale ?? undefined, {
    timeZone: timezone ?? undefined,
    month: "numeric",
    day: "numeric",
    hour: "numeric",
    minute: "numeric",
  });
}

/**
 * Deterministic pre-mount value for `<Timestamp>` (server + first client
 * paint). It uses the SAME `Intl` option shape as {@link formatDateTime}
 * (or {@link formatDateTimeCompact} when `compact`), but pins a **fixed
 * locale** (`en-US`) in **UTC** so the server output and the first client
 * output are byte-identical — no hydration mismatch. After mount the
 * component re-renders through the browser-/app-locale formatters.
 */
export function formatDateTimePremount(
  date: string | Date,
  compact = false,
): string {
  const d = typeof date === "string" ? new Date(date) : date;
  return d.toLocaleString("en-US", {
    timeZone: "UTC",
    ...(compact
      ? {
          month: "numeric",
          day: "numeric",
          hour: "numeric",
          minute: "numeric",
        }
      : {
          year: "numeric",
          month: "numeric",
          day: "numeric",
          hour: "numeric",
          minute: "numeric",
          second: "numeric",
        }),
  });
}
