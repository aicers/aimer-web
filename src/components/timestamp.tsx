"use client";

import { useEffect, useState } from "react";

import { useAccountTimezone } from "@/hooks/use-account-timezone";
import {
  formatTimestamp,
  resolveDisplayTimeZone,
} from "@/lib/datetime/format-timestamp";

/**
 * Render a UTC instant in the user's display timezone (#400).
 *
 * The resolution order is `accounts.timezone` → browser timezone → UTC.
 * `accounts.timezone` is read from {@link useAccountTimezone} (mounted per
 * auth context); the browser-timezone fallback can only be read in the
 * browser, so the three analysis pages — which are *server* components —
 * bridge it through this client component.
 *
 * Hydration: the server (and the first client paint) cannot know the
 * browser timezone, so both render the deterministic UTC form. After mount
 * the timezone is resolved and the value re-renders in the display zone.
 * `suppressHydrationWarning` covers the legitimate server↔client difference.
 */
export function Timestamp({
  at,
  className,
}: {
  /** A UTC instant — a `Date` or an RFC 3339 string. */
  at: Date | string;
  className?: string;
}) {
  const accountTimezone = useAccountTimezone();
  // `null` until mounted ⇒ server / first paint format in UTC, avoiding a
  // hydration mismatch against the browser-resolved zone.
  const [timeZone, setTimeZone] = useState<string | null>(null);

  useEffect(() => {
    setTimeZone(resolveDisplayTimeZone(accountTimezone));
  }, [accountTimezone]);

  const iso = typeof at === "string" ? at : at.toISOString();

  return (
    <time dateTime={iso} className={className} suppressHydrationWarning>
      {formatTimestamp(at, timeZone ?? "UTC")}
    </time>
  );
}
