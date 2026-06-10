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
  useLocale: () => "en",
}));

vi.mock("next/link", () => ({
  default: ({
    href,
    children,
  }: {
    href: string;
    children: React.ReactNode;
  }) => <a href={href}>{children}</a>,
}));

vi.mock("@/hooks/use-customer-context", () => ({
  useCustomerContext: vi.fn(),
}));

// The create dialog has its own concerns (eligible fetch, preview); stub it.
vi.mock("../create-group-dialog", () => ({
  CreateGroupDialog: () => <div data-testid="create-dialog" />,
}));

import { useCustomerContext } from "@/hooks/use-customer-context";
import { GroupSettingsPage } from "../group-settings-page";

const mockedUseCustomerContext = vi.mocked(useCustomerContext);

function setContext(over: Record<string, unknown>) {
  mockedUseCustomerContext.mockReturnValue({
    me: { accountId: "acct-1" },
    isBridgeSession: false,
    loading: false,
    ...over,
  } as unknown as ReturnType<typeof useCustomerContext>);
}

afterEach(() => cleanup());

beforeEach(() => {
  mockApiFetch.mockReset();
  mockedUseCustomerContext.mockReset();
});

describe("GroupSettingsPage", () => {
  it("shows the forbidden state and does not fetch under a bridge session", async () => {
    setContext({ isBridgeSession: true });
    mockApiFetch.mockResolvedValue({ groups: [] });

    render(<GroupSettingsPage />);

    await waitFor(() => expect(screen.getByText("forbidden")).toBeDefined());
    // The list fetch still fires from the effect, but the surface is denied.
    expect(screen.queryByTestId("create-dialog")).toBeNull();
  });

  it("renders the empty state when no manageable groups exist", async () => {
    setContext({});
    mockApiFetch.mockResolvedValue({ groups: [] });

    render(<GroupSettingsPage />);

    await waitFor(() => expect(screen.getByText("empty")).toBeDefined());
    expect(screen.getByTestId("create-dialog")).toBeDefined();
  });

  it("lists groups and tags the caller's owned group", async () => {
    setContext({});
    mockApiFetch.mockResolvedValue({
      groups: [
        {
          id: "g1",
          name: "Owned Group",
          memberCount: 3,
          databaseStatus: "active",
          ownerId: "acct-1",
          createdBy: "acct-1",
        },
        {
          id: "g2",
          name: "Other Group",
          memberCount: 2,
          databaseStatus: "failed",
          ownerId: "acct-9",
          createdBy: "acct-9",
        },
      ],
    });

    render(<GroupSettingsPage />);

    await waitFor(() => expect(screen.getByText("Owned Group")).toBeDefined());
    expect(screen.getByText("Other Group")).toBeDefined();
    // Owner badge shows for the caller-owned group only (one occurrence).
    expect(screen.getAllByText("ownerBadge")).toHaveLength(1);
    // Detail links are locale-prefixed.
    const link = screen
      .getByText("Owned Group")
      .closest("a") as HTMLAnchorElement;
    expect(link.getAttribute("href")).toBe("/en/settings/groups/g1");
  });

  it("shows the list error when the fetch fails", async () => {
    setContext({});
    mockApiFetch.mockRejectedValue(new Error("boom"));

    render(<GroupSettingsPage />);

    await waitFor(() => expect(screen.getByText("listError")).toBeDefined());
  });
});
