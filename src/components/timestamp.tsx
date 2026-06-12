"use client";

import { useLocale } from "next-intl";
import { useEffect, useState } from "react";

import { useAccountTimeFormat } from "@/hooks/use-account-time-format";
import { useAccountTimezone } from "@/hooks/use-account-timezone";
import {
  formatDateTime,
  formatDateTimeCompact,
  reservedWidthCh,
  resolveDisplayTimeZone,
} from "@/lib/datetime/format-timestamp";

/**
 * A short pre-mount placeholder string. It is never announced (`aria-hidden`)
 * and never shown (`visibility: hidden`); it exists only to give the reserved
 * slot a real text baseline/height so the swap to the resolved value does not
 * nudge the line. It is deliberately narrower than the slimmest possible
 * resolved value, so the slot's `min-width` (computed from the resolved
 * options, see {@link reservedWidthCh}) — never this string — drives the
 * reserved width in both phases, leaving no room for a layout shift.
 */
const PLACEHOLDER = "00:00";

/**
 * Render a UTC instant in the user's display timezone (#400), matching
 * aice-web-next's time format (#553).
 *
 * The resolution order is `accounts.timezone` → browser timezone → UTC.
 * `accounts.timezone` is read from {@link useAccountTimezone} (mounted per
 * auth context); the browser-timezone fallback can only be read in the
 * browser, so the three analysis pages — which are *server* components —
 * bridge it through this client component.
 *
 * Format:
 * - Default (general) → {@link formatDateTime}: follows the browser locale,
 *   includes seconds, no timezone label. The account's display-format
 *   preference (#556), resolved by {@link useAccountTimeFormat}, overrides
 *   these defaults — locale, hour cycle, seconds, and timezone label.
 * - `compact` → {@link formatDateTimeCompact}: follows the active app locale
 *   (`useLocale()`) and drops year + seconds; for tight surfaces. The
 *   preference applies only its locale and hour cycle here — seconds and the
 *   timezone label are always omitted in compact (#556).
 *
 * Pre-mount (server + first client paint): neither the browser locale nor the
 * browser timezone is knowable on the server, so rather than render a
 * real-looking but wrong UTC value that then flashes to the resolved local
 * value (#555), we render a deterministic, layout-stable **placeholder** — a
 * fixed-width slot whose text is `aria-hidden` and `visibility: hidden`, under
 * `aria-busy="true"`. Because the placeholder is a static constant the server
 * and first client paint are byte-identical, so there is no hydration
 * mismatch. After mount the timezone resolves and the real value renders
 * through the formatters, clearing `aria-busy`. The machine-readable
 * `<time dateTime>` ISO is exposed in both phases. `suppressHydrationWarning`
 * is kept only defensively.
 */
export function Timestamp({
  at,
  className,
  compact = false,
}: {
  /** A UTC instant — a `Date` or an RFC 3339 string. */
  at: Date | string;
  className?: string;
  /** Render the compact (locale-aware, no year/seconds) form. */
  compact?: boolean;
}) {
  const accountTimezone = useAccountTimezone();
  const timeFormat = useAccountTimeFormat();
  const locale = useLocale();
  // `null` until mounted ⇒ server / first paint render the deterministic
  // placeholder, avoiding a hydration mismatch against the browser.
  const [timeZone, setTimeZone] = useState<string | null>(null);

  useEffect(() => {
    setTimeZone(resolveDisplayTimeZone(accountTimezone));
  }, [accountTimezone]);

  const iso = typeof at === "string" ? at : at.toISOString();
  const mode = compact ? "compact" : "general";
  // Recompute the reserved width from the resolved options: the chosen format
  // changes the worst case (24-hour + seconds + tz label is widest), so a
  // fixed reservation would either shift or over-reserve. Identical pre- and
  // post-mount (the options are stable across the swap), so no layout shift.
  const minWidth = `${reservedWidthCh(mode, timeFormat)}ch`;

  if (timeZone === null) {
    return (
      <time
        dateTime={iso}
        className={className}
        aria-busy="true"
        style={{ display: "inline-block", minWidth }}
        suppressHydrationWarning
      >
        <span aria-hidden="true" style={{ visibility: "hidden" }}>
          {PLACEHOLDER}
        </span>
      </time>
    );
  }

  const text = compact
    ? formatDateTimeCompact(at, timeZone, timeFormat.locale ?? locale, {
        hourCycle: timeFormat.hourCycle,
      })
    : formatDateTime(at, timeZone, timeFormat);

  return (
    <time
      dateTime={iso}
      className={className}
      style={{ display: "inline-block", minWidth }}
      suppressHydrationWarning
    >
      {text}
    </time>
  );
}
