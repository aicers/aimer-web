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
    },
    {
      id: "c2",
      externalKey: "ext-2",
      name: "Customer 2",
      role: "User",
      isAnalyst: false,
    },
  ],
};

const mockEnvironments = {
  environments: [{ aiceId: "env-1.example.com", name: "Env 1" }],
};

function wrapper({ children }: { children: ReactNode }) {
  return <CustomerContextProvider>{children}</CustomerContextProvider>;
}

describe("useCustomerContext", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    mockApiFetch.mockImplementation((url: string) => {
      if (url === "/api/auth/me") return Promise.resolve(mockMe);
      if (url === "/api/auth/customers") return Promise.resolve(mockCustomers);
      if (url.startsWith("/api/auth/environments"))
        return Promise.resolve(mockEnvironments);
      return Promise.reject(new Error(`Unexpected URL: ${url}`));
    });
    // Reset location mock
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

  it("auto-selects first customer when no bridge", async () => {
    const { result } = renderHook(() => useCustomerContext(), { wrapper });

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });

    expect(result.current.selectedCustomerId).toBe("c1");
    expect(result.current.isBridgeSession).toBe(false);
  });

  it("auto-selects bridge customer in bridge session", async () => {
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
      if (url.startsWith("/api/auth/environments"))
        return Promise.resolve(mockEnvironments);
      return Promise.reject(new Error(`Unexpected URL: ${url}`));
    });

    const { result } = renderHook(() => useCustomerContext(), { wrapper });

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });

    expect(result.current.selectedCustomerId).toBe("c2");
    expect(result.current.isBridgeSession).toBe(true);
  });

  it("fetches environments when selectedCustomerId changes", async () => {
    const { result } = renderHook(() => useCustomerContext(), { wrapper });

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });

    // After auto-selecting c1, environments should be fetched
    await waitFor(() => {
      expect(mockApiFetch).toHaveBeenCalledWith(
        "/api/auth/environments?customer_id=c1",
      );
    });

    expect(result.current.environments).toEqual(mockEnvironments.environments);
    expect(result.current.selectedEnvironmentId).toBe("env-1.example.com");
  });

  it("setSelectedCustomerId is no-op in bridge session", async () => {
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
      if (url.startsWith("/api/auth/environments"))
        return Promise.resolve(mockEnvironments);
      return Promise.reject(new Error(`Unexpected URL: ${url}`));
    });

    const { result } = renderHook(() => useCustomerContext(), { wrapper });

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });

    expect(result.current.selectedCustomerId).toBe("c2");

    act(() => {
      result.current.setSelectedCustomerId("c1");
    });

    expect(result.current.selectedCustomerId).toBe("c2");
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

    // Initially loading
    expect(result.current.loading).toBe(true);

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });

    expect(result.current.me).toEqual(mockMe);
    expect(result.current.customers).toEqual(mockCustomers.customers);
  });
});
