"use client";

import { useMemo } from "react";
import { useCustomerContext } from "./use-customer-context";

export interface Permissions {
  role: string | null;
  isAnalyst: boolean;
  isManager: boolean;
  /** True iff the calling account has the named permission key on the
   *  resolved customer. Returns false when there is no resolved
   *  customer or no entry for it. */
  hasPermission: (key: string) => boolean;
  canViewMembers: boolean;
  canViewCustomerSettings: boolean;
  canViewRedactionRanges: boolean;
  canWriteRedactionRanges: boolean;
  canViewRetention: boolean;
  canWriteRetention: boolean;
  canUseAnalystFeatures: boolean;
}

/**
 * Derives effective permissions for a customer.
 *
 * @param customerId - Override customer ID. When omitted, permissions
 *   resolve against the single customer in the active scope
 *   ({@link useCustomerContext}'s `singleCustomerId`). Under a multi- or
 *   all-scope that resolves to more than one customer there is no single
 *   target, so every permission is denied — Members and Customer Settings
 *   are single-customer surfaces (#390).
 */
export function usePermissions(customerId?: string): Permissions {
  const { customers, singleCustomerId } = useCustomerContext();

  const resolvedId = customerId ?? singleCustomerId;

  return useMemo(() => {
    const entry = customers.find((c) => c.id === resolvedId);

    const role = entry?.role ?? null;
    const isAnalyst = entry?.isAnalyst ?? false;
    const isManager = role === "Manager";
    const permSet = new Set(entry?.permissions ?? []);
    const hasPermission = (key: string) => permSet.has(key);
    const canViewRedactionRanges = hasPermission(
      "customer-redaction-ranges:read",
    );
    const canViewRetention = hasPermission("customer-retention:read");

    return {
      role,
      isAnalyst,
      isManager,
      hasPermission,
      canViewMembers: isManager,
      // Page-level gate: visible if the caller can read either of the
      // two surfaces currently rendered under Customer Settings. The
      // page renders each section read-only or with controls based on
      // the section-specific keys.
      canViewCustomerSettings: canViewRedactionRanges || canViewRetention,
      canViewRedactionRanges,
      canWriteRedactionRanges: hasPermission("customer-redaction-ranges:write"),
      canViewRetention,
      canWriteRetention: hasPermission("customer-retention:write"),
      canUseAnalystFeatures: isAnalyst,
    };
  }, [customers, resolvedId]);
}
