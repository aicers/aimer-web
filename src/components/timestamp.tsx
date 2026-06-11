"use client";

import { useLocale } from "next-intl";
import { useEffect, useState } from "react";

import { useAccountTimezone } from "@/hooks/use-account-timezone";
import {
  formatDateTime,
  formatDateTimeCompact,
  resolveDisplayTimeZone,
} from "@/lib/datetime/format-timestamp";

/**
 * A representative fixed footprint reserved for the slot before the value
 * resolves, sized (in `ch`) so the common `en`/`ko` values fit without a
 * layout shift when the placeholder is swapped for the real value. The
 * general format carries the year + seconds, the compact form drops both,
 * so each mode reserves its own width.
 */
const RESERVED_WIDTH = { general: "24ch", compact: "17ch" } as const;

/**
 * A representative pre-mount placeholder string. It is never announced
 * (`aria-hidden`) and never shown (`visibility: hidden`); it exists only to
 * give the reserved slot a real text baseline/height so the swap to the
 * resolved value does not nudge the line.
 */
const PLACEHOLDER = {
  general: "0000. 00. 00. 00:00:00",
  compact: "00. 00. 00:00",
} as const;

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
 *   includes seconds, no timezone label.
 * - `compact` → {@link formatDateTimeCompact}: follows the active app locale
 *   (`useLocale()`) and drops year + seconds; for tight surfaces.
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
  const locale = useLocale();
  // `null` until mounted ⇒ server / first paint render the deterministic
  // placeholder, avoiding a hydration mismatch against the browser.
  const [timeZone, setTimeZone] = useState<string | null>(null);

  useEffect(() => {
    setTimeZone(resolveDisplayTimeZone(accountTimezone));
  }, [accountTimezone]);

  const iso = typeof at === "string" ? at : at.toISOString();
  const mode = compact ? "compact" : "general";

  if (timeZone === null) {
    return (
      <time
        dateTime={iso}
        className={className}
        aria-busy="true"
        style={{ display: "inline-block", minWidth: RESERVED_WIDTH[mode] }}
        suppressHydrationWarning
      >
        <span aria-hidden="true" style={{ visibility: "hidden" }}>
          {PLACEHOLDER[mode]}
        </span>
      </time>
    );
  }

  const text = compact
    ? formatDateTimeCompact(at, timeZone, locale)
    : formatDateTime(at, timeZone);

  return (
    <time
      dateTime={iso}
      className={className}
      style={{ display: "inline-block", minWidth: RESERVED_WIDTH[mode] }}
      suppressHydrationWarning
    >
      {text}
    </time>
  );
}
