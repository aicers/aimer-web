// @vitest-environment jsdom
import { act, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mockApiFetch = vi.fn();

vi.mock("@/lib/api/client", () => ({
  apiFetch: (...args: unknown[]) => mockApiFetch(...args),
  ApiError: class ApiError extends Error {
    status: number;
    constructor(message: string, status: number) {
      super(message);
      this.name = "ApiError";
      this.status = status;
    }
  },
}));

const mockPush = vi.fn();
let mockSearchParams = new URLSearchParams();

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: mockPush }),
  usePathname: () => "/en/reports",
  useSearchParams: () => mockSearchParams,
}));

import {
  CustomerContextProvider,
  useCustomerContext,
} from "../use-customer-context";

const mockMe = {
  accountId: "acc-1",
  sessionId: "sess-1",
  authContext: "general",
  username: "test",
  displayName: "Test User",
  email: "test@example.com",
  locale: null,
  timezone: null,
  analystEligible: false,
  bridge: { active: false, aiceId: null, customerIds: null },
  memberships: [],
};

const mockCustomers = {
  customers: [
    {
      id: "c1",
      externalKey: "ext-1",
      name: "Customer 1",
      role: "Manager",
      isAnalyst: false,
      permissions: [],
    },
    {
      id: "c2",
      externalKey: "ext-2",
      name: "Customer 2",
      role: "User",
      isAnalyst: false,
      permissions: [],
    },
  ],
};

function wrapper({ children }: { children: ReactNode }) {
  return <CustomerContextProvider>{children}</CustomerContextProvider>;
}

describe("useCustomerContext", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    mockPush.mockReset();
    mockSearchParams = new URLSearchParams();
    mockApiFetch.mockImplementation((url: string) => {
      if (url === "/api/auth/me") return Promise.resolve(mockMe);
      if (url === "/api/auth/customers") return Promise.resolve(mockCustomers);
      return Promise.reject(new Error(`Unexpected URL: ${url}`));
    });
    Object.defineProperty(window, "location", {
      value: { href: "" },
      writable: true,
    });
  });

  it("fetches /api/auth/me and /api/auth/customers in parallel on mount", async () => {
    const { result } = renderHook(() => useCustomerContext(), { wrapper });

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });

    expect(mockApiFetch).toHaveBeenCalledWith("/api/auth/me");
    expect(mockApiFetch).toHaveBeenCalledWith("/api/auth/customers");
  });

  it("defaults to the all-scope (full accessible set) when no scope param", async () => {
    const { result } = renderHook(() => useCustomerContext(), { wrapper });

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });

    expect(result.current.scope.isAll).toBe(true);
    expect(result.current.scope.customerIds).toEqual(["c1", "c2"]);
    // More than one customer ⇒ no single customer.
    expect(result.current.singleCustomerId).toBeNull();
    expect(result.current.isBridgeSession).toBe(false);
  });

  it("derives a subset scope from the URL scope param", async () => {
    mockSearchParams = new URLSearchParams("scope=c2");
    const { result } = renderHook(() => useCustomerContext(), { wrapper });

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });

    expect(result.current.scope.isAll).toBe(false);
    expect(result.current.scope.customerIds).toEqual(["c2"]);
    expect(result.current.singleCustomerId).toBe("c2");
  });

  it("singleCustomerId is set under an all-scope with one accessible customer", async () => {
    mockApiFetch.mockImplementation((url: string) => {
      if (url === "/api/auth/me") return Promise.resolve(mockMe);
      if (url === "/api/auth/customers")
        return Promise.resolve({ customers: [mockCustomers.customers[0]] });
      return Promise.reject(new Error(`Unexpected URL: ${url}`));
    });

    const { result } = renderHook(() => useCustomerContext(), { wrapper });

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });

    expect(result.current.scope.isAll).toBe(true);
    expect(result.current.singleCustomerId).toBe("c1");
  });

  it("setScope rewrites the URL, merging existing params", async () => {
    mockSearchParams = new URLSearchParams("tz=UTC&lang=en");
    const { result } = renderHook(() => useCustomerContext(), { wrapper });

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });

    act(() => {
      result.current.setScope(["c2"]);
    });

    expect(mockPush).toHaveBeenCalledWith(
      "/en/reports?lang=en&scope=c2&tz=UTC",
    );
  });

  it("setScope('all') drops the scope param while preserving other params", async () => {
    mockSearchParams = new URLSearchParams("scope=c2&tz=UTC");
    const { result } = renderHook(() => useCustomerContext(), { wrapper });

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });

    act(() => {
      result.current.setScope("all");
    });

    expect(mockPush).toHaveBeenCalledWith("/en/reports?tz=UTC");
  });

  it("setScope is a no-op in a bridge session", async () => {
    const bridgeMe = {
      ...mockMe,
      bridge: {
        active: true,
        aiceId: "env-1.example.com",
        customerIds: ["c2"],
      },
    };
    mockApiFetch.mockImplementation((url: string) => {
      if (url === "/api/auth/me") return Promise.resolve(bridgeMe);
      if (url === "/api/auth/customers") return Promise.resolve(mockCustomers);
      return Promise.reject(new Error(`Unexpected URL: ${url}`));
    });

    const { result } = renderHook(() => useCustomerContext(), { wrapper });

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });

    expect(result.current.isBridgeSession).toBe(true);

    act(() => {
      result.current.setScope(["c1"]);
    });

    expect(mockPush).not.toHaveBeenCalled();
  });

  it("throws error when used outside provider", () => {
    expect(() => {
      renderHook(() => useCustomerContext());
    }).toThrow(
      "useCustomerContext must be used within a CustomerContextProvider",
    );
  });

  it("redirects to sign-in on 401", async () => {
    const { ApiError } = await import("@/lib/api/client");

    mockApiFetch.mockRejectedValue(new ApiError("Unauthorized", 401));

    renderHook(() => useCustomerContext(), { wrapper });

    await waitFor(() => {
      expect(window.location.href).toBe("/api/auth/sign-in");
    });
  });

  it("sets loading=false after fetch completes", async () => {
    const { result } = renderHook(() => useCustomerContext(), { wrapper });

    expect(result.current.loading).toBe(true);

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });

    expect(result.current.me).toEqual(mockMe);
    expect(result.current.customers).toEqual(mockCustomers.customers);
  });
});
