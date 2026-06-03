"use client";

import { createContext, type ReactNode, useContext } from "react";

/**
 * Carries the active auth context's `accounts.timezone` (or `null` when the
 * account stores no preference) down to the `<Timestamp>` component (#400).
 *
 * It is a dedicated context — separate from `useCustomerContext` — so
 * `<Timestamp>` works in *both* the dashboard (general auth) and admin
 * (admin auth) trees without coupling to either. The two trees fetch their
 * own `me` (`/api/auth/me` vs `/api/admin-auth/me`) and each mounts its own
 * provider. With no provider present the value is `null`, so `<Timestamp>`
 * still degrades gracefully through browser timezone → UTC.
 */
const AccountTimezoneContext = createContext<string | null>(null);

export function AccountTimezoneProvider({
  timezone,
  children,
}: {
  timezone: string | null;
  children: ReactNode;
}) {
  return (
    <AccountTimezoneContext.Provider value={timezone}>
      {children}
    </AccountTimezoneContext.Provider>
  );
}

/** The active account's stored timezone, or `null` when none is set. */
export function useAccountTimezone(): string | null {
  return useContext(AccountTimezoneContext);
}
