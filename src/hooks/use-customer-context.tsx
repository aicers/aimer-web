"use client";

import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from "react";

import { ApiError, apiFetch } from "@/lib/api/client";
import type {
  CustomerEntry,
  EnvironmentEntry,
  MeResponse,
} from "@/lib/api/types";

interface CustomerContextValue {
  me: MeResponse | null;
  customers: CustomerEntry[];
  selectedCustomerId: string | null;
  setSelectedCustomerId: (id: string) => void;
  environments: EnvironmentEntry[];
  selectedEnvironmentId: string | null;
  setSelectedEnvironmentId: (id: string) => void;
  isBridgeSession: boolean;
  loading: boolean;
}

const CustomerContext = createContext<CustomerContextValue | null>(null);

export function CustomerContextProvider({ children }: { children: ReactNode }) {
  const [me, setMe] = useState<MeResponse | null>(null);
  const [customers, setCustomers] = useState<CustomerEntry[]>([]);
  const [selectedCustomerId, setSelectedCustomerIdState] = useState<
    string | null
  >(null);
  const [environments, setEnvironments] = useState<EnvironmentEntry[]>([]);
  const [selectedEnvironmentId, setSelectedEnvironmentIdState] = useState<
    string | null
  >(null);
  const [loading, setLoading] = useState(true);

  const isBridgeSession = me?.bridge.active ?? false;

  const setSelectedCustomerId = useCallback(
    (id: string) => {
      if (!isBridgeSession) {
        setSelectedCustomerIdState(id);
      }
    },
    [isBridgeSession],
  );

  const setSelectedEnvironmentId = useCallback(
    (id: string) => {
      if (!isBridgeSession) {
        setSelectedEnvironmentIdState(id);
      }
    },
    [isBridgeSession],
  );

  // Fetch /api/auth/me and /api/auth/customers in parallel on mount
  useEffect(() => {
    let cancelled = false;

    async function load() {
      try {
        const [meData, customersData] = await Promise.all([
          apiFetch<MeResponse>("/api/auth/me"),
          apiFetch<{ customers: CustomerEntry[] }>("/api/auth/customers"),
        ]);

        if (cancelled) return;

        setMe(meData);
        setCustomers(customersData.customers);

        // Auto-select: bridge customer or first available
        const firstId = customersData.customers[0]?.id ?? null;
        if (meData.bridge.active && meData.bridge.customerIds?.length) {
          setSelectedCustomerIdState(meData.bridge.customerIds[0]);
        } else {
          setSelectedCustomerIdState(firstId);
        }
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

  // Fetch environments when selected customer changes
  useEffect(() => {
    if (!selectedCustomerId) {
      setEnvironments([]);
      setSelectedEnvironmentIdState(null);
      return;
    }

    let cancelled = false;

    async function loadEnvironments() {
      try {
        const data = await apiFetch<{ environments: EnvironmentEntry[] }>(
          `/api/auth/environments?customer_id=${selectedCustomerId}`,
        );

        if (cancelled) return;

        setEnvironments(data.environments);

        // Auto-select: bridge environment or first available
        if (me?.bridge.active && me.bridge.aiceId) {
          const match = data.environments.find(
            (e) => e.aiceId === me.bridge.aiceId,
          );
          setSelectedEnvironmentIdState(match?.aiceId ?? null);
        } else {
          setSelectedEnvironmentIdState(data.environments[0]?.aiceId ?? null);
        }
      } catch {
        if (!cancelled) {
          setEnvironments([]);
          setSelectedEnvironmentIdState(null);
        }
      }
    }

    loadEnvironments();
    return () => {
      cancelled = true;
    };
  }, [selectedCustomerId, me?.bridge.active, me?.bridge.aiceId]);

  const value = useMemo<CustomerContextValue>(
    () => ({
      me,
      customers,
      selectedCustomerId,
      setSelectedCustomerId,
      environments,
      selectedEnvironmentId,
      setSelectedEnvironmentId,
      isBridgeSession,
      loading,
    }),
    [
      me,
      customers,
      selectedCustomerId,
      setSelectedCustomerId,
      environments,
      selectedEnvironmentId,
      setSelectedEnvironmentId,
      isBridgeSession,
      loading,
    ],
  );

  return (
    <CustomerContext.Provider value={value}>
      {children}
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
