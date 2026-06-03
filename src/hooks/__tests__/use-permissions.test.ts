// @vitest-environment jsdom
import { renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { CustomerEntry } from "@/lib/api/types";

vi.mock("../use-customer-context", () => ({
  useCustomerContext: vi.fn(),
}));

import { useCustomerContext } from "../use-customer-context";
import { usePermissions } from "../use-permissions";

const mockedUseCustomerContext = vi.mocked(useCustomerContext);

const USER_PERMS = [
  "customer-redaction-ranges:read",
  "customer-retention:read",
];
const MANAGER_PERMS = [
  "customer-redaction-ranges:read",
  "customer-redaction-ranges:write",
  "customer-retention:read",
  "customer-retention:write",
];

function mockContext(
  customers: CustomerEntry[],
  singleCustomerId: string | null,
) {
  mockedUseCustomerContext.mockReturnValue({
    customers,
    singleCustomerId,
  } as ReturnType<typeof useCustomerContext>);
}

function makeCustomer(
  overrides: Partial<CustomerEntry> & { id: string },
): CustomerEntry {
  return {
    externalKey: overrides.id,
    name: `Customer ${overrides.id}`,
    role: null,
    isAnalyst: false,
    permissions: [],
    ...overrides,
  };
}

describe("usePermissions", () => {
  it("returns Manager permissions when role is Manager", () => {
    mockContext(
      [
        makeCustomer({
          id: "c1",
          role: "Manager",
          isAnalyst: false,
          permissions: MANAGER_PERMS,
        }),
      ],
      "c1",
    );

    const { result } = renderHook(() => usePermissions());

    expect(result.current).toMatchObject({
      role: "Manager",
      isManager: true,
      isAnalyst: false,
      canViewMembers: true,
      canViewCustomerSettings: true,
      canViewRedactionRanges: true,
      canWriteRedactionRanges: true,
      canViewRetention: true,
      canWriteRetention: true,
      canUseAnalystFeatures: false,
    });
  });

  it("returns User permissions when role is User", () => {
    mockContext(
      [
        makeCustomer({
          id: "c1",
          role: "User",
          isAnalyst: false,
          permissions: USER_PERMS,
        }),
      ],
      "c1",
    );

    const { result } = renderHook(() => usePermissions());

    expect(result.current).toMatchObject({
      role: "User",
      isManager: false,
      canViewMembers: false,
      // User has :read on both surfaces — section is visible (read-only).
      canViewCustomerSettings: true,
      canViewRedactionRanges: true,
      canWriteRedactionRanges: false,
      canViewRetention: true,
      canWriteRetention: false,
      canUseAnalystFeatures: false,
    });
  });

  it("returns analyst permissions", () => {
    mockContext(
      [
        makeCustomer({
          id: "c1",
          role: null,
          isAnalyst: true,
          // Analyst-only access still surfaces the two :read keys via
          // the analyst-assignment union in /api/auth/customers.
          permissions: USER_PERMS,
        }),
      ],
      "c1",
    );

    const { result } = renderHook(() => usePermissions());

    expect(result.current).toMatchObject({
      role: null,
      isManager: false,
      isAnalyst: true,
      canViewRedactionRanges: true,
      canWriteRedactionRanges: false,
      canViewRetention: true,
      canWriteRetention: false,
      canUseAnalystFeatures: true,
    });
  });

  it("returns combined Manager + analyst permissions", () => {
    mockContext(
      [
        makeCustomer({
          id: "c1",
          role: "Manager",
          isAnalyst: true,
          permissions: MANAGER_PERMS,
        }),
      ],
      "c1",
    );

    const { result } = renderHook(() => usePermissions());

    expect(result.current).toMatchObject({
      role: "Manager",
      isManager: true,
      isAnalyst: true,
      canViewMembers: true,
      canViewCustomerSettings: true,
      canWriteRedactionRanges: true,
      canWriteRetention: true,
      canUseAnalystFeatures: true,
    });
  });

  it("returns null/false when no customer found", () => {
    mockContext([], "c1");

    const { result } = renderHook(() => usePermissions());

    expect(result.current).toMatchObject({
      role: null,
      isManager: false,
      isAnalyst: false,
      canViewMembers: false,
      canViewCustomerSettings: false,
      canViewRedactionRanges: false,
      canWriteRedactionRanges: false,
      canViewRetention: false,
      canWriteRetention: false,
      canUseAnalystFeatures: false,
    });
  });

  it("uses customerId parameter over selectedCustomerId", () => {
    mockContext(
      [
        makeCustomer({
          id: "c1",
          role: "User",
          isAnalyst: false,
          permissions: USER_PERMS,
        }),
        makeCustomer({
          id: "c2",
          role: "Manager",
          isAnalyst: true,
          permissions: MANAGER_PERMS,
        }),
      ],
      "c1",
    );

    const { result } = renderHook(() => usePermissions("c2"));

    expect(result.current).toMatchObject({
      role: "Manager",
      isManager: true,
      isAnalyst: true,
      canViewMembers: true,
      canViewCustomerSettings: true,
      canWriteRedactionRanges: true,
      canWriteRetention: true,
      canUseAnalystFeatures: true,
    });
  });

  it("hasPermission queries the underlying permission set", () => {
    mockContext(
      [
        makeCustomer({
          id: "c1",
          role: "User",
          permissions: USER_PERMS,
        }),
      ],
      "c1",
    );

    const { result } = renderHook(() => usePermissions());

    expect(result.current.hasPermission("customer-retention:read")).toBe(true);
    expect(result.current.hasPermission("customer-retention:write")).toBe(
      false,
    );
  });
});
