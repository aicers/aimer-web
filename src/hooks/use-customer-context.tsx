"use client";

import { usePathname, useRouter, useSearchParams } from "next/navigation";
import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from "react";

import { AccountTimeFormatProvider } from "@/hooks/use-account-time-format";
import { AccountTimezoneProvider } from "@/hooks/use-account-timezone";
import { ApiError, apiFetch } from "@/lib/api/client";
import type { CustomerEntry, GroupEntry, MeResponse } from "@/lib/api/types";
import { mergeQuery } from "@/lib/navigation/query";
import {
  type NormalizedScope,
  normalizeScope,
  SCOPE_PARAM,
} from "@/lib/navigation/scope";

interface CustomerContextValue {
  me: MeResponse | null;
  /** Ambient set: the customers this account can access. */
  customers: CustomerEntry[];
  /**
   * The customer groups this account can surface as summary subjects (#513):
   * those where the viewer holds `reports:read` on every member. Drives the
   * sidebar group navigation and the scope-filter presets. Empty for a bridge
   * session (the endpoint short-circuits to `[]`).
   */
  groups: GroupEntry[];
  /**
   * Active customer scope, derived from the URL `scope` param against the
   * ambient set. `all` (default) ⇒ the full accessible set; `c1,c2` ⇒ that
   * subset. See {@link normalizeScope}.
   */
  scope: NormalizedScope;
  /**
   * The single customer id when the active scope resolves to exactly one
   * customer, else `null`. Drives single-customer gating (Members,
   * Customer Settings, and {@link usePermissions}).
   */
  singleCustomerId: string | null;
  /**
   * Rewrite the URL `scope` param, merging (not replacing) the other query
   * params already on the URL. Pass `"all"` or a list of customer ids; the
   * value is normalized before it is written. No-op in a bridge session.
   */
  setScope: (next: "all" | string[]) => void;
  isBridgeSession: boolean;
  loading: boolean;
}

const CustomerContext = createContext<CustomerContextValue | null>(null);

export function CustomerContextProvider({ children }: { children: ReactNode }) {
  const [me, setMe] = useState<MeResponse | null>(null);
  const [customers, setCustomers] = useState<CustomerEntry[]>([]);
  const [groups, setGroups] = useState<GroupEntry[]>([]);
  const [loading, setLoading] = useState(true);

  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();

  const isBridgeSession = me?.bridge.active ?? false;

  const accessibleIds = useMemo(() => customers.map((c) => c.id), [customers]);

  // Current scope is derived from the URL, not client state.
  const rawScope = searchParams.get(SCOPE_PARAM);
  const scope = useMemo(
    () => normalizeScope(rawScope, accessibleIds),
    [rawScope, accessibleIds],
  );

  const singleCustomerId =
    scope.customerIds.length === 1 ? scope.customerIds[0] : null;

  const setScope = useCallback(
    (next: "all" | string[]) => {
      // Bridge sessions are pinned to a fixed bridge scope — short-circuit.
      if (isBridgeSession) return;
      const norm = normalizeScope(
        next === "all" ? "all" : next.join(","),
        accessibleIds,
      );
      // Represent the all-scope as an absent param to keep URLs clean
      // (absence ⇔ all). Merge so report-variant params are preserved.
      const scopeValue = norm.isAll ? null : norm.canonical;
      const qs = mergeQuery(searchParams, { [SCOPE_PARAM]: scopeValue });
      router.push(qs ? `${pathname}?${qs}` : pathname);
    },
    [accessibleIds, isBridgeSession, pathname, router, searchParams],
  );

  // Fetch /api/auth/me, /api/auth/customers, and /api/auth/groups in parallel
  // on mount. The accessible customer set is the ambient set the scope
  // normalizes against; the group set (#513) feeds the sidebar group
  // navigation and the scope-filter presets (empty for a bridge session).
  useEffect(() => {
    let cancelled = false;

    async function load() {
      try {
        const [meData, customersData, groupsData] = await Promise.all([
          apiFetch<MeResponse>("/api/auth/me"),
          apiFetch<{ customers: CustomerEntry[] }>("/api/auth/customers"),
          apiFetch<{ groups: GroupEntry[] }>("/api/auth/groups"),
        ]);

        if (cancelled) return;

        setMe(meData);
        setCustomers(customersData.customers);
        setGroups(groupsData.groups);
      } catch (err) {
        if (err instanceof ApiError && err.status === 401) {
          window.location.href = "/api/auth/sign-in";
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    load();
    return () => {
      cancelled = true;
    };
  }, []);

  const value = useMemo<CustomerContextValue>(
    () => ({
      me,
      customers,
      groups,
      scope,
      singleCustomerId,
      setScope,
      isBridgeSession,
      loading,
    }),
    [
      me,
      customers,
      groups,
      scope,
      singleCustomerId,
      setScope,
      isBridgeSession,
      loading,
    ],
  );

  return (
    <CustomerContext.Provider value={value}>
      <AccountTimezoneProvider timezone={me?.timezone ?? null}>
        <AccountTimeFormatProvider
          timeFormat={
            me
              ? {
                  locale: me.timeFormatLocale,
                  hourCycle: me.timeFormatHourCycle,
                  seconds: me.timeFormatSeconds,
                  tzLabel: me.timeFormatTzLabel,
                }
              : null
          }
        >
          {children}
        </AccountTimeFormatProvider>
      </AccountTimezoneProvider>
    </CustomerContext.Provider>
  );
}

export function useCustomerContext(): CustomerContextValue {
  const ctx = useContext(CustomerContext);
  if (!ctx) {
    throw new Error(
      "useCustomerContext must be used within a CustomerContextProvider",
    );
  }
  return ctx;
}
