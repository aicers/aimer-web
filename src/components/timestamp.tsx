"use client";

import { useLocale } from "next-intl";
import { useEffect, useState } from "react";

import { useAccountTimezone } from "@/hooks/use-account-timezone";
import {
  formatDateTime,
  formatDateTimeCompact,
  formatDateTimePremount,
  resolveDisplayTimeZone,
} from "@/lib/datetime/format-timestamp";

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
 * Hydration: neither the browser locale nor the browser timezone is knowable
 * on the server, so the server (and the first client paint) render the
 * deterministic {@link formatDateTimePremount} value (fixed `en-US`, UTC).
 * Because that value is byte-identical on both sides there is no mismatch;
 * after mount the timezone resolves and the value re-renders through the
 * real formatters. `suppressHydrationWarning` is kept only defensively.
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
  // pre-mount value, avoiding a hydration mismatch against the browser.
  const [timeZone, setTimeZone] = useState<string | null>(null);

  useEffect(() => {
    setTimeZone(resolveDisplayTimeZone(accountTimezone));
  }, [accountTimezone]);

  const iso = typeof at === "string" ? at : at.toISOString();

  let text: string;
  if (timeZone === null) {
    text = formatDateTimePremount(at, compact);
  } else if (compact) {
    text = formatDateTimeCompact(at, timeZone, locale);
  } else {
    text = formatDateTime(at, timeZone);
  }

  return (
    <time dateTime={iso} className={className} suppressHydrationWarning>
      {text}
    </time>
  );
}
