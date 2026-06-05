// @vitest-environment jsdom
//
// Page test for the cross-customer combined Overview landing (WS2, #391).
// The landing is the only page that mixes all three types, so beyond the
// shared scope-outcome mapping (covered for every surface by the
// suspicious-events page test) it has unique logic worth pinning here:
//   - it renders a per-type section with each type's own disclosure count;
//   - it merges the three surfaces' `failedCustomers` into ONE notice,
//     deduped by id so the same unreachable DB is named once.
// The aggregator is mocked; its merge/permission logic lives in
// `cross-customer-overview.unit.test.ts`.

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CrossCustomerOverviewOutcome } from "@/lib/analysis/cross-customer-overview";
import type { ScopePageOutcome } from "@/lib/navigation/scope-page-loader";

const mockLoadScope = vi.fn<() => Promise<ScopePageOutcome>>();
const mockLoadOverview = vi.fn<() => Promise<CrossCustomerOverviewOutcome>>();
const redirectMock = vi.fn((t: string) => {
  throw new Error(`REDIRECT:${t}`);
});
const forbiddenMock = vi.fn(() => {
  throw new Error("FORBIDDEN");
});

vi.mock("@/lib/navigation/scope-page-loader", () => ({
  loadScopePage: () => mockLoadScope(),
}));
vi.mock("@/lib/analysis/cross-customer-overview", () => ({
  loadCrossCustomerOverview: () => mockLoadOverview(),
}));
vi.mock("next/navigation", () => ({
  redirect: (t: string) => redirectMock(t),
  forbidden: () => forbiddenMock(),
}));
vi.mock("next-intl/server", async () => {
  const { createTranslator } = await import("next-intl");
  const messages = (await import("@/i18n/messages/en.json")).default;
  return {
    getTranslations: async (namespace?: string) =>
      createTranslator({
        locale: "en",
        messages,
        namespace: namespace as never,
      }),
  };
});
vi.mock("next/link", () => ({
  default: ({
    href,
    children,
    ...props
  }: {
    href: string;
    children: React.ReactNode;
  }) => (
    <a href={href} {...props}>
      {children}
    </a>
  ),
}));

import OverviewPage from "../page";

function okScope(canonical = "all"): ScopePageOutcome {
  return {
    kind: "ok",
    scope: {
      isAll: canonical === "all",
      customerIds: ["c1", "c2"],
      canonical,
    },
  };
}

async function renderPage() {
  const jsx = await OverviewPage({
    params: Promise.resolve({ locale: "en" }),
    searchParams: Promise.resolve({}),
  });
  render(jsx);
}

describe("cross-customer overview landing page", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockLoadScope.mockResolvedValue(okScope());
    mockLoadOverview.mockResolvedValue({
      kind: "ok",
      reports: { items: [], totalCount: 7, failedCustomers: [] },
      stories: { items: [], totalCount: 3, failedCustomers: [] },
      events: { items: [], totalCount: 11, failedCustomers: [] },
    });
  });
  afterEach(() => cleanup());

  it("redirects unauthenticated users to sign-in", async () => {
    mockLoadScope.mockResolvedValue({ kind: "unauthorized" });
    await expect(renderPage()).rejects.toThrow("REDIRECT:/api/auth/sign-in");
  });

  it("redirects to the canonical scope target", async () => {
    mockLoadScope.mockResolvedValue({
      kind: "redirect",
      target: "/en/overview?scope=c1,c2",
    });
    await expect(renderPage()).rejects.toThrow(
      "REDIRECT:/en/overview?scope=c1,c2",
    );
  });

  it("403s for a bridge session", async () => {
    mockLoadScope.mockResolvedValue({ kind: "bridge" });
    await expect(renderPage()).rejects.toThrow("FORBIDDEN");
  });

  it("renders a per-type count for each of the three surfaces", async () => {
    await renderPage();
    const counts = screen
      .getAllByTestId("overview-count")
      .map((el) => el.getAttribute("data-count"));
    // reports / stories / events, in section order.
    expect(counts).toEqual(["7", "3", "11"]);
  });

  it("points each section's 'view all' link at its dedicated page, carrying a non-'all' scope", async () => {
    mockLoadScope.mockResolvedValue(okScope("c1,c2"));
    await renderPage();
    const hrefs = screen
      .getAllByRole("link")
      .map((a) => a.getAttribute("href"))
      .filter((h): h is string => h != null);
    expect(hrefs).toContain("/en/reports?scope=c1%2Cc2");
    expect(hrefs).toContain("/en/threat-stories?scope=c1%2Cc2");
    expect(hrefs).toContain("/en/suspicious-events?scope=c1%2Cc2");
  });

  it("omits the scope param on 'view all' links when scope is 'all'", async () => {
    await renderPage();
    const hrefs = screen
      .getAllByRole("link")
      .map((a) => a.getAttribute("href"));
    expect(hrefs).toContain("/en/reports");
    expect(hrefs).not.toContain("/en/reports?scope=all");
  });

  it("merges failed customers across surfaces into one notice, deduped by id", async () => {
    mockLoadOverview.mockResolvedValue({
      kind: "ok",
      // The same unreachable DB (c2/Globex) fails on two surfaces; a third
      // surface adds a distinct one (c3/Initech). The notice must name each
      // once.
      reports: {
        items: [],
        totalCount: 0,
        failedCustomers: [{ id: "c2", name: "Globex" }],
      },
      stories: {
        items: [],
        totalCount: 0,
        failedCustomers: [{ id: "c2", name: "Globex" }],
      },
      events: {
        items: [],
        totalCount: 0,
        failedCustomers: [{ id: "c3", name: "Initech" }],
      },
    });
    await renderPage();
    const notices = screen.getAllByTestId("overview-partial-failure");
    // One merged notice, not one per surface.
    expect(notices).toHaveLength(1);
    const text = notices[0].textContent ?? "";
    expect(text).toContain("Globex");
    expect(text).toContain("Initech");
    // Globex appears once despite failing on two surfaces.
    expect(text.match(/Globex/g)).toHaveLength(1);
  });
});
