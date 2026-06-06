// @vitest-environment jsdom
//
// Client-component test for the analyst management page. Pins two behaviors
// that have no other coverage and were flagged in review:
//   - the direct-designation dialog must not retain a stale selected account
//     after the search query changes (otherwise an admin can submit an
//     account that is no longer visible in the filtered list);
//   - a non-403 failure of a picker dependency (customers/accounts) must
//     surface a clear load-error state and disable the dependent actions,
//     rather than silently degrading to an empty picker.
//
// `adminFetch` is mocked per-URL; everything else uses the real i18n messages.

import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { NextIntlClientProvider } from "next-intl";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import messages from "@/i18n/messages/en.json";
import { ApiError } from "@/lib/api/client";
import { AnalystsPage } from "../analysts-page";

const adminFetch = vi.fn();

vi.mock("@/lib/api/admin-client", () => ({
  adminFetch: (url: string, options?: RequestInit) => adminFetch(url, options),
}));

vi.mock("@/components/timestamp", () => ({
  Timestamp: ({ at }: { at: string }) => <span>{at}</span>,
}));

const ACCOUNTS = [
  {
    id: "acc-alice",
    username: "alice",
    displayName: "Alice",
    email: "alice@example.com",
    status: "active",
  },
  {
    id: "acc-bob",
    username: "bob",
    displayName: "Bob",
    email: "bob@example.com",
    status: "active",
  },
];

const CUSTOMERS = [
  { id: "cust-1", name: "Acme", externalKey: "ACME", status: "active" },
];

// Default happy-path responses; individual tests override `adminFetch`.
function mockHappyPath() {
  adminFetch.mockImplementation((url: string) => {
    if (url === "/api/admin/analysts") return Promise.resolve({ analysts: [] });
    if (url === "/api/admin/analysts/invitations") {
      return Promise.resolve({ invitations: [] });
    }
    if (url === "/api/admin/customers") {
      return Promise.resolve({ customers: CUSTOMERS });
    }
    if (url === "/api/admin/accounts") {
      return Promise.resolve({ accounts: ACCOUNTS });
    }
    return Promise.resolve({});
  });
}

function renderPage() {
  return render(
    <NextIntlClientProvider locale="en" messages={messages}>
      <AnalystsPage />
    </NextIntlClientProvider>,
  );
}

beforeEach(() => {
  adminFetch.mockReset();
});

afterEach(() => {
  cleanup();
});

describe("AnalystsPage direct designation", () => {
  it("clears the selected account when the search query changes", async () => {
    mockHappyPath();
    renderPage();

    // Wait for the toolbar to leave its loading state.
    await waitFor(() =>
      expect(
        (
          screen.getByRole("button", {
            name: "Designate Analyst",
          }) as HTMLButtonElement
        ).disabled,
      ).toBe(false),
    );

    fireEvent.click(screen.getByRole("button", { name: "Designate Analyst" }));
    const dialog = await screen.findByRole("dialog");

    // Narrow to Alice and select her.
    fireEvent.change(
      within(dialog).getByPlaceholderText("Search accounts by name or email"),
      { target: { value: "Alice" } },
    );
    fireEvent.click(within(dialog).getByText("Alice"));
    expect(within(dialog).queryByText("Selected: Alice")).not.toBeNull();

    // Pick a customer so the only remaining gate on submit is the account.
    fireEvent.click(within(dialog).getAllByRole("checkbox")[0]);
    const submit = within(dialog).getByRole("button", {
      name: "Designate Analyst",
    }) as HTMLButtonElement;
    expect(submit.disabled).toBe(false);

    // Changing the query must drop the stale selection and re-disable submit.
    fireEvent.change(
      within(dialog).getByPlaceholderText("Search accounts by name or email"),
      { target: { value: "Bob" } },
    );
    expect(within(dialog).queryByText("Selected: Alice")).toBeNull();
    expect(submit.disabled).toBe(true);
  });
});

describe("AnalystsPage picker load failures", () => {
  it("surfaces a load error and disables actions when customers fail (non-403)", async () => {
    adminFetch.mockImplementation((url: string) => {
      if (url === "/api/admin/analysts") {
        return Promise.resolve({ analysts: [] });
      }
      if (url === "/api/admin/analysts/invitations") {
        return Promise.resolve({ invitations: [] });
      }
      if (url === "/api/admin/customers") {
        return Promise.reject(new ApiError("internal", 500));
      }
      if (url === "/api/admin/accounts") {
        return Promise.resolve({ accounts: ACCOUNTS });
      }
      return Promise.resolve({});
    });
    renderPage();

    await screen.findByText(
      "Customer list could not be loaded. Customer pickers are unavailable until it loads — reload the page to retry.",
    );
    expect(
      (
        screen.getByRole("button", {
          name: "Invite Analyst",
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(true);
    expect(
      (
        screen.getByRole("button", {
          name: "Designate Analyst",
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(true);
  });
});
