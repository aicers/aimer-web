// @vitest-environment jsdom
//
// Page test for the cross-customer Suspicious Events overview (WS2, #391).
// Verifies the WS1 scope-outcome mapping (unauthorized → sign-in redirect,
// non-canonical scope → canonical redirect, bridge → 403) and that the
// aggregated rows render with the count, deep links, scores, and the partial-
// failure notice. The aggregator itself is mocked; its logic is covered by
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
// `<Timestamp>` (the event-row title since #552) reads the active locale via
// `useLocale()`; this page test renders it outside a `NextIntlClientProvider`,
// so supply a fixed locale while keeping the rest of next-intl real.
vi.mock("next-intl", async () => {
  const actual = await vi.importActual<typeof import("next-intl")>("next-intl");
  return { ...actual, useLocale: () => "en" };
});
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

import SuspiciousEventsPage from "../page";

function okScope(): ScopePageOutcome {
  return {
    kind: "ok",
    scope: { isAll: true, customerIds: ["c1", "c2"], canonical: "all" },
  };
}

async function renderPage() {
  const jsx = await SuspiciousEventsPage({
    params: Promise.resolve({ locale: "en" }),
    searchParams: Promise.resolve({}),
  });
  render(jsx);
}

describe("suspicious events overview page", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockLoadScope.mockResolvedValue(okScope());
    mockLoadOverview.mockResolvedValue({
      kind: "ok",
      events: {
        items: [
          {
            customerId: "c1",
            customerName: "Acme",
            aiceId: "aice-1",
            eventKey: "42",
            priorityTier: "CRITICAL",
            severityScore: 0.91,
            likelihoodScore: 0.77,
            requestedAt: new Date("2026-06-01T00:00:00Z"),
            eventTime: new Date("2026-05-20T00:00:00Z"),
            kind: "HttpThreat",
            lang: "ENGLISH",
            modelName: "openai",
            model: "gpt-4o",
          },
        ],
        totalCount: 1,
        failedCustomers: [],
      },
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
      target: "/en/suspicious-events?scope=c1,c2",
    });
    await expect(renderPage()).rejects.toThrow(
      "REDIRECT:/en/suspicious-events?scope=c1,c2",
    );
  });

  it("403s for a bridge session", async () => {
    mockLoadScope.mockResolvedValue({ kind: "bridge" });
    await expect(renderPage()).rejects.toThrow("FORBIDDEN");
  });

  it("renders the event row with the count and a variant-pinned deep link", async () => {
    await renderPage();
    expect(
      screen.getByTestId("overview-count").getAttribute("data-count"),
    ).toBe("1");
    const row = screen.getByTestId("overview-event-row");
    expect(row.getAttribute("href")).toBe(
      "/en/subjects/c1/aice/aice-1/events/42/analysis?lang=en&model_name=openai&model=gpt-4o",
    );
    expect(
      screen.getByTestId("priority-tier-badge").getAttribute("data-tier"),
    ).toBe("CRITICAL");
  });

  it("encodes route-significant characters in the event deep link", async () => {
    // `aice_id`/`event_key` are arbitrary non-empty strings at ingest, so a
    // `/` or `%` would corrupt the path unless each segment is encoded.
    mockLoadOverview.mockResolvedValue({
      kind: "ok",
      events: {
        items: [
          {
            customerId: "c1",
            customerName: "Acme",
            aiceId: "aice/1 a",
            eventKey: "ev?k%2",
            priorityTier: "CRITICAL",
            severityScore: 0.5,
            likelihoodScore: 0.5,
            requestedAt: new Date("2026-06-01T00:00:00Z"),
            eventTime: new Date("2026-05-20T00:00:00Z"),
            kind: null,
            lang: "ENGLISH",
            modelName: "openai",
            model: "gpt-4o",
          },
        ],
        totalCount: 1,
        failedCustomers: [],
      },
    });
    await renderPage();
    const row = screen.getByTestId("overview-event-row");
    expect(row.getAttribute("href")).toBe(
      "/en/subjects/c1/aice/aice%2F1%20a/events/ev%3Fk%252/analysis?lang=en&model_name=openai&model=gpt-4o",
    );
  });

  it("shows the empty state when no events are in scope", async () => {
    mockLoadOverview.mockResolvedValue({
      kind: "ok",
      events: { items: [], totalCount: 0, failedCustomers: [] },
    });
    await renderPage();
    expect(screen.getByTestId("suspicious-events-empty")).toBeTruthy();
  });

  it("surfaces a partial-failure notice naming the unreachable customer", async () => {
    mockLoadOverview.mockResolvedValue({
      kind: "ok",
      events: {
        items: [],
        totalCount: 0,
        failedCustomers: [{ id: "c2", name: "Globex" }],
      },
    });
    await renderPage();
    const notice = screen.getByTestId("overview-partial-failure");
    expect(notice.textContent).toContain("Globex");
  });
});
