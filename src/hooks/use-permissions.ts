"use client";

import { useMemo } from "react";
import { useCustomerContext } from "./use-customer-context";

export interface Permissions {
  role: string | null;
  isAnalyst: boolean;
  isManager: boolean;
  canViewMembers: boolean;
  canViewCustomerSettings: boolean;
  canUseAnalystFeatures: boolean;
}

/**
 * Derives effective permissions for a customer.
 *
 * @param customerId - Override customer ID. When omitted the currently
 *   selected customer from {@link useCustomerContext} is used.
 */
export function usePermissions(customerId?: string): Permissions {
  const { customers, selectedCustomerId } = useCustomerContext();

  const resolvedId = customerId ?? selectedCustomerId;

  return useMemo(() => {
    const entry = customers.find((c) => c.id === resolvedId);

    const role = entry?.role ?? null;
    const isAnalyst = entry?.isAnalyst ?? false;
    const isManager = role === "Manager";

    return {
      role,
      isAnalyst,
      isManager,
      canViewMembers: isManager,
      canViewCustomerSettings: isManager,
      canUseAnalystFeatures: isAnalyst,
    };
  }, [customers, resolvedId]);
}
