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

function mockContext(
  customers: CustomerEntry[],
  selectedCustomerId: string | null,
) {
  mockedUseCustomerContext.mockReturnValue({
    customers,
    selectedCustomerId,
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
    ...overrides,
  };
}

describe("usePermissions", () => {
  it("returns Manager permissions when role is Manager", () => {
    mockContext(
      [makeCustomer({ id: "c1", role: "Manager", isAnalyst: false })],
      "c1",
    );

    const { result } = renderHook(() => usePermissions());

    expect(result.current).toMatchObject({
      role: "Manager",
      isManager: true,
      isAnalyst: false,
      canViewMembers: true,
      canViewCustomerSettings: true,
      canUseAnalystFeatures: false,
    });
  });

  it("returns User permissions when role is User", () => {
    mockContext(
      [makeCustomer({ id: "c1", role: "User", isAnalyst: false })],
      "c1",
    );

    const { result } = renderHook(() => usePermissions());

    expect(result.current).toMatchObject({
      role: "User",
      isManager: false,
      canViewMembers: false,
      canViewCustomerSettings: false,
      canUseAnalystFeatures: false,
    });
  });

  it("returns analyst permissions", () => {
    mockContext(
      [makeCustomer({ id: "c1", role: null, isAnalyst: true })],
      "c1",
    );

    const { result } = renderHook(() => usePermissions());

    expect(result.current).toMatchObject({
      role: null,
      isManager: false,
      isAnalyst: true,
      canUseAnalystFeatures: true,
    });
  });

  it("returns combined Manager + analyst permissions", () => {
    mockContext(
      [makeCustomer({ id: "c1", role: "Manager", isAnalyst: true })],
      "c1",
    );

    const { result } = renderHook(() => usePermissions());

    expect(result.current).toMatchObject({
      role: "Manager",
      isManager: true,
      isAnalyst: true,
      canViewMembers: true,
      canViewCustomerSettings: true,
      canUseAnalystFeatures: true,
    });
  });

  it("returns null/false when no customer found", () => {
    mockContext([], "c1");

    const { result } = renderHook(() => usePermissions());

    expect(result.current).toEqual({
      role: null,
      isManager: false,
      isAnalyst: false,
      canViewMembers: false,
      canViewCustomerSettings: false,
      canUseAnalystFeatures: false,
    });
  });

  it("uses customerId parameter over selectedCustomerId", () => {
    mockContext(
      [
        makeCustomer({ id: "c1", role: "User", isAnalyst: false }),
        makeCustomer({ id: "c2", role: "Manager", isAnalyst: true }),
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
      canUseAnalystFeatures: true,
    });
  });
});
