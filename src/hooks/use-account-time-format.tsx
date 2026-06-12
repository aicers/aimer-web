"use client";

import { useLocale } from "next-intl";
import { createContext, type ReactNode, useContext } from "react";

import {
  DEFAULT_TIME_FORMAT,
  type ResolvedTimeFormat,
  resolveTimeFormat,
  type StoredTimeFormat,
} from "@/lib/datetime/format-timestamp";

/**
 * Carries the active auth context's stored date/time DISPLAY format
 * preference (#556) down to the `<Timestamp>` component — parallel to
 * {@link useAccountTimezone}, and mounted alongside it in both the dashboard
 * (general auth) and admin (admin auth) trees. With no provider present the
 * value is `null`, so `<Timestamp>` falls back to the aice-matched default.
 */
const AccountTimeFormatContext = createContext<StoredTimeFormat | null>(null);

export function AccountTimeFormatProvider({
  timeFormat,
  children,
}: {
  timeFormat: StoredTimeFormat | null;
  children: ReactNode;
}) {
  return (
    <AccountTimeFormatContext.Provider value={timeFormat}>
      {children}
    </AccountTimeFormatContext.Provider>
  );
}

/**
 * The account's display-format preference resolved into concrete `Intl`
 * options (account → app-locale → default). The `'app'` locale sentinel is
 * resolved against the active app locale here, keeping the resolution in one
 * place; `<Timestamp>` threads the result straight into the formatters.
 */
export function useAccountTimeFormat(): ResolvedTimeFormat {
  const stored = useContext(AccountTimeFormatContext);
  const appLocale = useLocale();
  if (!stored) return DEFAULT_TIME_FORMAT;
  return resolveTimeFormat(stored, appLocale);
}
