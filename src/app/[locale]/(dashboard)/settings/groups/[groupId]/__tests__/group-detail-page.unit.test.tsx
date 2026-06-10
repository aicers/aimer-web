// @vitest-environment jsdom
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { ManagedGroupDetail } from "@/lib/api/types";

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

// Stable translation function — a fresh closure each render would re-fire the
// component's `reload` effect (its `t` dep would change) and wipe state.
const t = (key: string) => key;
vi.mock("next-intl", () => ({
  useTranslations: () => t,
}));

vi.mock("next/navigation", () => ({
  useParams: () => ({ groupId: "g1" }),
}));

const mockPush = vi.fn();
vi.mock("@/i18n/navigation", () => ({
  useRouter: () => ({ push: mockPush }),
}));

const mockUseCustomerContext = vi.fn();
vi.mock("@/hooks/use-customer-context", () => ({
  useCustomerContext: () => mockUseCustomerContext(),
}));

import { ApiError } from "@/lib/api/client";
import { GroupDetailPage } from "../group-detail-page";

const DETAIL: ManagedGroupDetail = {
  id: "g1",
  name: "Acme Group",
  description: "A test group",
  members: [
    { id: "m1", name: "Member One" },
    { id: "m2", name: "Member Two" },
  ],
  tz: "Asia/Seoul",
  ownerId: "acct-1",
  createdBy: "acct-1",
  databaseStatus: "active",
  groupPolicyDays: 1095,
};

/** Route apiFetch by url + method; GET detail returns `detail`, writes resolve. */
function arrangeServer(detail: ManagedGroupDetail = DETAIL) {
  mockApiFetch.mockImplementation((url: string, opts?: RequestInit) => {
    const method = opts?.method ?? "GET";
    if (method === "GET" && url === "/api/groups/g1") {
      return Promise.resolve(detail);
    }
    return Promise.resolve(undefined);
  });
}

function setOwner(isOwner: boolean) {
  mockUseCustomerContext.mockReturnValue({
    me: { accountId: isOwner ? "acct-1" : "acct-9" },
  });
}

function writeCalls(method: string) {
  return mockApiFetch.mock.calls.filter(
    (c) => ((c[1] as RequestInit | undefined)?.method ?? "GET") === method,
  );
}

beforeEach(() => {
  mockApiFetch.mockReset();
  mockUseCustomerContext.mockReset();
  mockPush.mockReset();
  setOwner(true);
});

afterEach(() => cleanup());

describe("GroupDetailPage", () => {
  it("renders members read-only and tags the owner", async () => {
    arrangeServer();
    render(<GroupDetailPage />);
    await waitFor(() => expect(screen.getByText("Acme Group")).toBeDefined());
    expect(screen.getByText("Member One")).toBeDefined();
    expect(screen.getByText("Member Two")).toBeDefined();
    expect(screen.getAllByText("ownerBadge").length).toBeGreaterThan(0);
    // Membership is immutable — no add/remove member controls.
    expect(screen.queryByText("addMember")).toBeNull();
  });

  it("shows the forbidden message on a 403 detail load", async () => {
    mockApiFetch.mockRejectedValue(new ApiError("Forbidden", 403));
    render(<GroupDetailPage />);
    await waitFor(() => expect(screen.getByText("forbidden")).toBeDefined());
  });

  it("shows the not-found message on a 404 detail load", async () => {
    mockApiFetch.mockRejectedValue(new ApiError("Group not found", 404));
    render(<GroupDetailPage />);
    await waitFor(() => expect(screen.getByText("notFound")).toBeDefined());
  });

  it("blocks a retention save below the 30-day minimum without calling the API", async () => {
    arrangeServer();
    render(<GroupDetailPage />);
    await waitFor(() =>
      expect(screen.getByLabelText("retentionDaysLabel")).toBeDefined(),
    );
    const input = screen.getByLabelText(
      "retentionDaysLabel",
    ) as HTMLInputElement;
    fireEvent.change(input, { target: { value: "10" } });
    fireEvent.submit(input.closest("form") as HTMLFormElement);
    await waitFor(() =>
      expect(screen.getByText("retentionTooShort")).toBeDefined(),
    );
    expect(writeCalls("PUT").length).toBe(0);
  });

  it("saves a valid retention value as a number", async () => {
    arrangeServer();
    render(<GroupDetailPage />);
    await waitFor(() =>
      expect(screen.getByLabelText("retentionDaysLabel")).toBeDefined(),
    );
    const input = screen.getByLabelText(
      "retentionDaysLabel",
    ) as HTMLInputElement;
    fireEvent.change(input, { target: { value: "365" } });
    fireEvent.submit(input.closest("form") as HTMLFormElement);
    await waitFor(() => {
      const puts = writeCalls("PUT").filter(
        (c) => (c[0] as string) === "/api/groups/g1/retention",
      );
      expect(puts.length).toBe(1);
      expect(JSON.parse(puts[0][1].body as string)).toEqual({
        groupPolicyDays: 365,
      });
    });
  });

  it("sends null when the unlimited box is checked", async () => {
    arrangeServer();
    render(<GroupDetailPage />);
    await waitFor(() =>
      expect(screen.getByLabelText("retentionUnlimitedLabel")).toBeDefined(),
    );
    fireEvent.click(screen.getByLabelText("retentionUnlimitedLabel"));
    fireEvent.submit(
      (screen.getByLabelText("retentionDaysLabel") as HTMLInputElement).closest(
        "form",
      ) as HTMLFormElement,
    );
    await waitFor(() => {
      const puts = writeCalls("PUT").filter(
        (c) => (c[0] as string) === "/api/groups/g1/retention",
      );
      expect(puts.length).toBe(1);
      expect(JSON.parse(puts[0][1].body as string)).toEqual({
        groupPolicyDays: null,
      });
    });
  });

  it("requires confirmation before deleting and then navigates away", async () => {
    arrangeServer();
    render(<GroupDetailPage />);
    await waitFor(() => expect(screen.getByText("deleteButton")).toBeDefined());
    fireEvent.click(screen.getByText("deleteButton"));
    // Confirmation dialog appears; no DELETE fired yet.
    await waitFor(() => expect(screen.getByRole("alertdialog")).toBeDefined());
    expect(writeCalls("DELETE").length).toBe(0);
    fireEvent.click(screen.getByText("delete"));
    await waitFor(() => {
      expect(writeCalls("DELETE").length).toBe(1);
      expect(mockPush).toHaveBeenCalledWith("/settings/groups");
    });
  });

  it("hides delete and retry for a non-owner", async () => {
    setOwner(false);
    arrangeServer({ ...DETAIL, databaseStatus: "failed" });
    render(<GroupDetailPage />);
    await waitFor(() => expect(screen.getByText("Acme Group")).toBeDefined());
    expect(screen.queryByText("deleteButton")).toBeNull();
    expect(screen.queryByText("retryProvision")).toBeNull();
    expect(screen.getByText("ownerOnlyHint")).toBeDefined();
  });

  it("offers retry provisioning to the owner only when the database failed", async () => {
    arrangeServer({ ...DETAIL, databaseStatus: "failed" });
    render(<GroupDetailPage />);
    await waitFor(() =>
      expect(screen.getByText("retryProvision")).toBeDefined(),
    );
    fireEvent.click(screen.getByText("retryProvision"));
    await waitFor(() => {
      const posts = writeCalls("POST").filter(
        (c) => (c[0] as string) === "/api/groups/g1/retry-provision",
      );
      expect(posts.length).toBe(1);
    });
  });

  it("does not offer retry when the database is active", async () => {
    arrangeServer();
    render(<GroupDetailPage />);
    await waitFor(() => expect(screen.getByText("Acme Group")).toBeDefined());
    expect(screen.queryByText("retryProvision")).toBeNull();
  });

  it("disables the timezone save until the value changes", async () => {
    arrangeServer();
    render(<GroupDetailPage />);
    await waitFor(() => expect(screen.getByText("Acme Group")).toBeDefined());
    const tzSelect = screen.getByLabelText(
      "timezoneTitle",
    ) as HTMLSelectElement;
    const save = tzSelect
      .closest("section")
      ?.querySelector("button") as HTMLButtonElement;
    expect(save.disabled).toBe(true);
    fireEvent.change(tzSelect, { target: { value: "UTC" } });
    expect(save.disabled).toBe(false);
  });
});
