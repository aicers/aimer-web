// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The admin re-analysis entry point (#473 Scope 7) is the admin-context,
// customer-scoped destination the admin per-customer offer deep-links to.
// These tests cover that it renders the entry-point copy for the selected
// customer (and never enqueues anything).

const mockAdminFetch = vi.fn();
vi.mock("@/lib/api/admin-client", () => ({
  adminFetch: (...args: unknown[]) => mockAdminFetch(...args),
}));

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
  it("renders the backfill panel wired to the selected customer's admin API", async () => {
    mockAdminFetch.mockResolvedValue({
      effective: { modelName: "openai", model: "gpt-5.5" },
      source: "customer",
    });
    render(<AdminCustomerReanalyzePage />);

    expect(screen.getByText("title")).toBeDefined();
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

    // Entry-point copy is non-fatal on a failed lookup.
    expect(screen.getByText("guaranteeNote")).toBeDefined();
    await waitFor(() => expect(mockAdminFetch).toHaveBeenCalled());
    expect(screen.queryByText(/^targetModel:/)).toBeNull();
  });
});
