// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The admin re-analysis entry point (#473 Scope 7 / #466 / #470) is the
// admin-context, customer-scoped destination the admin per-customer offer
// deep-links to. These tests cover that it renders the entry-point copy, the
// story-leaf backfill panel (#466, stubbed), and the event-leaf backfill
// panel (#470) for the selected customer.

const mockAdminFetch = vi.fn();
vi.mock("@/lib/api/admin-client", () => ({
  adminFetch: (...args: unknown[]) => mockAdminFetch(...args),
}));

// The #470 backfill panel issues its own preview/list fetches; route each
// to a benign shape so the panel mounts without error.
function routeBackfillFetch(url: string): unknown | null {
  if (url.includes("/event-backfill/preview")) {
    return {
      target: { lang: "ENGLISH", modelName: "openai", model: "gpt-5.5" },
      windowDays: 7,
      counts: {
        totalUniverse: 0,
        reanalyze: 0,
        alreadyCurrent: 0,
        sourceUnavailable: 0,
        capExcluded: 0,
      },
    };
  }
  if (url.endsWith("/event-backfill")) return { runs: [] };
  return null;
}

const t = (key: string, vars?: Record<string, unknown>) =>
  vars ? `${key}:${JSON.stringify(vars)}` : key;
vi.mock("next-intl", () => ({
  useTranslations: () => t,
  useLocale: () => "en",
}));

// `@/i18n/navigation`'s Link transitively imports `next/navigation`, which
// does not resolve cleanly under jsdom; stub it to a plain anchor.
vi.mock("@/i18n/navigation", () => ({
  Link: ({ href, children }: { href: string; children: React.ReactNode }) => (
    <a href={href}>{children}</a>
  ),
}));

vi.mock("next/navigation", () => ({
  useParams: () => ({ customerId: "c1" }),
}));

// The backfill panel (#466) has its own unit test; stub it here so the page
// test stays focused on the entry-point copy and panel wiring.
const mockPanel = vi.fn();
vi.mock("@/components/analysis/reanalyze-backfill-panel", () => ({
  ReanalyzeBackfillPanel: (props: { apiBase: string }) => {
    mockPanel(props);
    return <div>backfill-panel</div>;
  },
}));

import AdminCustomerReanalyzePage from "../page";

beforeEach(() => {
  mockAdminFetch.mockReset();
  mockPanel.mockReset();
});

afterEach(() => cleanup());

describe("AdminCustomerReanalyzePage", () => {
  it("renders the entry-point copy, both backfill panels, and the default model", async () => {
    mockAdminFetch.mockImplementation(async (url: string) => {
      const routed = routeBackfillFetch(url);
      if (routed) return routed;
      return {
        effective: { modelName: "openai", model: "gpt-5.5" },
        source: "customer",
      };
    });
    render(<AdminCustomerReanalyzePage />);

    expect(screen.getByText("title")).toBeDefined();
    // The #470 event-leaf backfill panel replaces the placeholder.
    expect(screen.getByText("panelTitle")).toBeDefined();
    expect(screen.getByText("guaranteeNote")).toBeDefined();
    expect(screen.getByText("backfill-panel")).toBeDefined();
    expect(mockPanel).toHaveBeenCalledWith(
      expect.objectContaining({
        apiBase: "/api/admin/customers/c1/reanalyze",
      }),
    );
    // The current default model is shown once the lookup resolves, scoped
    // to the customer in the route param.
    await waitFor(() =>
      expect(
        screen.getByText('targetModel:{"model":"openai / gpt-5.5"}'),
      ).toBeDefined(),
    );
    expect(mockAdminFetch).toHaveBeenCalledWith(
      "/api/admin/customers/c1/default-model",
    );
  });

  it("still renders the entry-point copy without the model chip when the lookup fails", async () => {
    mockAdminFetch.mockRejectedValue(new Error("forbidden"));
    render(<AdminCustomerReanalyzePage />);

    // Entry-point copy + both panels are non-fatal on failed lookups.
    expect(screen.getByText("panelTitle")).toBeDefined();
    expect(screen.getByText("guaranteeNote")).toBeDefined();
    await waitFor(() => expect(mockAdminFetch).toHaveBeenCalled());
    expect(screen.queryByText(/^targetModel:/)).toBeNull();
  });
});
