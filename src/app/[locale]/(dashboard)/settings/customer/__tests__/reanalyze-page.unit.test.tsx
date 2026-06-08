// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The re-analysis entry point (#473 Scope 7 / #466 / #470) is the stable,
// customer-scoped in-app destination the post-change offer deep-links to.
// These tests cover its scope/permission gating and that it renders the
// entry-point copy, the story-leaf backfill panel (#466, stubbed), and the
// event-leaf backfill panel (#470) — never enqueuing anything.

const mockApiFetch = vi.fn();
vi.mock("@/lib/api/client", () => ({
  apiFetch: (...args: unknown[]) => mockApiFetch(...args),
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

vi.mock("@/hooks/use-customer-context", () => ({
  useCustomerContext: vi.fn(),
}));
vi.mock("@/hooks/use-permissions", () => ({
  usePermissions: vi.fn(),
}));

// The backfill panel (#466) has its own unit test; stub it here so the page
// test stays focused on scope/permission gating and the panel wiring.
const mockPanel = vi.fn();
vi.mock("@/components/analysis/reanalyze-backfill-panel", () => ({
  ReanalyzeBackfillPanel: (props: { apiBase: string }) => {
    mockPanel(props);
    return <div>backfill-panel</div>;
  },
}));

// The #469 report-variant refresh panel has its own unit test; stub it here
// (like the #466 panel) so the page test stays focused on wiring.
const mockReportPanel = vi.fn();
vi.mock("@/components/analysis/report-variant-refresh-panel", () => ({
  ReportVariantRefreshPanel: (props: { apiBase: string }) => {
    mockReportPanel(props);
    return <div>report-refresh-panel</div>;
  },
}));

import { useCustomerContext } from "@/hooks/use-customer-context";
import { usePermissions } from "@/hooks/use-permissions";
import CustomerReanalyzePage from "../reanalyze/page";

const mockedUseCustomerContext = vi.mocked(useCustomerContext);
const mockedUsePermissions = vi.mocked(usePermissions);

function arrange(opts: {
  singleCustomerId: string | null;
  canViewCustomerSettings: boolean;
}): void {
  mockedUseCustomerContext.mockReturnValue({
    singleCustomerId: opts.singleCustomerId,
  } as ReturnType<typeof useCustomerContext>);
  mockedUsePermissions.mockReturnValue({
    canViewCustomerSettings: opts.canViewCustomerSettings,
  } as ReturnType<typeof usePermissions>);
}

beforeEach(() => {
  mockApiFetch.mockReset();
  mockPanel.mockReset();
  mockReportPanel.mockReset();
  mockedUseCustomerContext.mockReset();
  mockedUsePermissions.mockReset();
});

afterEach(() => cleanup());

describe("CustomerReanalyzePage", () => {
  it("shows the scope-required notice under a multi-/all-scope", () => {
    arrange({ singleCustomerId: null, canViewCustomerSettings: true });
    render(<CustomerReanalyzePage />);
    expect(screen.getByText("scopeRequired")).toBeDefined();
    expect(mockApiFetch).not.toHaveBeenCalled();
  });

  it("shows forbidden when access is denied", () => {
    arrange({ singleCustomerId: "c1", canViewCustomerSettings: false });
    render(<CustomerReanalyzePage />);
    expect(screen.getByText("forbidden")).toBeDefined();
  });

  it("renders the entry-point copy, both backfill panels, and the new default model", async () => {
    arrange({ singleCustomerId: "c1", canViewCustomerSettings: true });
    mockApiFetch.mockImplementation(async (url: string) => {
      const routed = routeBackfillFetch(url);
      if (routed) return routed;
      return {
        effective: { modelName: "openai", model: "gpt-5.5" },
        source: "customer",
      };
    });
    render(<CustomerReanalyzePage />);

    expect(screen.getByText("title")).toBeDefined();
    // The #470 event-leaf backfill panel replaces the placeholder.
    expect(screen.getByText("panelTitle")).toBeDefined();
    expect(screen.getByText("guaranteeNote")).toBeDefined();
    expect(screen.getByText("backfill-panel")).toBeDefined();
    expect(mockPanel).toHaveBeenCalledWith(
      expect.objectContaining({
        apiBase: "/api/customers/c1/analysis/reanalyze",
      }),
    );
    expect(screen.getByText("report-refresh-panel")).toBeDefined();
    expect(mockReportPanel).toHaveBeenCalledWith(
      expect.objectContaining({
        apiBase: "/api/customers/c1/analysis/report-refresh",
      }),
    );
    // The current default model is shown once the lookup resolves.
    await waitFor(() =>
      expect(
        screen.getByText('targetModel:{"model":"openai / gpt-5.5"}'),
      ).toBeDefined(),
    );
    expect(mockApiFetch).toHaveBeenCalledWith(
      "/api/customers/c1/analysis/default-model",
    );
  });
});
