// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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

vi.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
}));

vi.mock("@/hooks/use-customer-context", () => ({
  useCustomerContext: vi.fn(),
}));

vi.mock("@/hooks/use-permissions", () => ({
  usePermissions: vi.fn(),
}));

vi.mock("../invite-dialog", () => ({ InviteDialog: () => null }));
vi.mock("../member-table", () => ({
  MemberTable: () => <div data-testid="member-table" />,
}));
vi.mock("../pending-invitations", () => ({
  PendingInvitations: () => null,
}));

import { useCustomerContext } from "@/hooks/use-customer-context";
import { usePermissions } from "@/hooks/use-permissions";
import { MembersPage } from "../members-page";

const mockedUseCustomerContext = vi.mocked(useCustomerContext);
const mockedUsePermissions = vi.mocked(usePermissions);

afterEach(() => cleanup());

describe("MembersPage scope gating", () => {
  beforeEach(() => {
    mockApiFetch.mockReset();
    mockedUseCustomerContext.mockReset();
    mockedUsePermissions.mockReset();
    mockedUsePermissions.mockReturnValue({
      isManager: true,
    } as ReturnType<typeof usePermissions>);
  });

  it("shows the scope-required state and skips data fetching under a multi-/all-scope", async () => {
    mockedUseCustomerContext.mockReturnValue({
      me: { accountId: "acc-1", memberships: [] },
      singleCustomerId: null,
    } as unknown as ReturnType<typeof useCustomerContext>);

    render(<MembersPage />);

    await waitFor(() =>
      expect(screen.getByText("scopeRequired")).toBeDefined(),
    );
    expect(screen.queryByTestId("member-table")).toBeNull();
    // No customer in scope ⇒ no member/invitation/role requests.
    expect(mockApiFetch).not.toHaveBeenCalled();
  });

  it("loads member data when a single customer is in scope", async () => {
    mockedUseCustomerContext.mockReturnValue({
      me: { accountId: "acc-1", memberships: [] },
      singleCustomerId: "c1",
    } as unknown as ReturnType<typeof useCustomerContext>);
    mockApiFetch.mockImplementation((url: string) => {
      if (url.startsWith("/api/members"))
        return Promise.resolve({ members: [] });
      if (url.startsWith("/api/invitations"))
        return Promise.resolve({ invitations: [] });
      if (url.startsWith("/api/roles")) return Promise.resolve({ roles: [] });
      return Promise.reject(new Error(`Unexpected URL: ${url}`));
    });

    render(<MembersPage />);

    await waitFor(() =>
      expect(screen.getByTestId("member-table")).toBeDefined(),
    );
    expect(screen.queryByText("scopeRequired")).toBeNull();
    expect(mockApiFetch).toHaveBeenCalledWith("/api/members?customer_id=c1");
  });
});
