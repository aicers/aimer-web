// @vitest-environment jsdom
//
// RFC 0002 Phase 2 (#297) — periodic report detail page. Verifies:
//   - uppercase-period case lock (lowercase period → notFound)
//   - LIVE pinned to the synthetic epoch bucket
//   - WEEKLY/MONTHLY not shown in Phase 2
//   - ok render shows tier badge, aggregate scores, TTP chips, sections
//   - pending render shows the banner

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ReportResultPageOutcome } from "@/lib/analysis/report-result-page-loader";

const mockLoad = vi.fn<() => Promise<ReportResultPageOutcome>>();

vi.mock("@/lib/analysis/report-result-page-loader", () => ({
  loadReportResultPage: () => mockLoad(),
}));

vi.mock("next/navigation", () => ({
  notFound: () => {
    throw new Error("NEXT_NOT_FOUND");
  },
  forbidden: () => {
    throw new Error("NEXT_FORBIDDEN");
  },
}));

vi.mock("../regenerate-button", () => ({
  ReportRegenerateButton: () => null,
}));

import ReportDetailPage from "../page";

const CUSTOMER_ID = "c0000000-0000-0000-0000-000000000001";

function okFixture(): ReportResultPageOutcome {
  return {
    kind: "ok",
    data: {
      customerId: CUSTOMER_ID,
      period: "DAILY",
      bucketDate: "2026-05-26",
      tz: "Asia/Seoul",
      lang: "ENGLISH",
      modelName: "openai",
      model: "gpt-4o",
      modelActualVersion: "gpt-4o-2026",
      promptVersion: "periodic-1",
      generation: 2,
      priorityTier: "HIGH",
      aggregateSeverityScore: 0.85,
      aggregateLikelihoodScore: 0.7,
      ttpTags: [{ id: "T1078", name: "Valid Accounts" }],
      sections: {
        executive_summary: "A busy day.",
        story_highlights: "Top story.",
        baseline_drift: "Malware up 30%.",
        notable_events: "One notable event.",
        recommendations: "Patch promptly.",
      },
      topStoryCount: 1,
      topEventCount: 1,
      requestedBy: null,
      requestedAt: new Date("2026-05-27T12:00:00Z"),
    },
  };
}

async function renderPage(period: string, bucketDate: string): Promise<void> {
  const jsx = await ReportDetailPage({
    params: Promise.resolve({
      locale: "en",
      customerId: CUSTOMER_ID,
      period,
      bucketDate,
    }),
  });
  render(jsx);
}

describe("report detail page", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockLoad.mockResolvedValue(okFixture());
  });
  afterEach(() => cleanup());

  it("renders tier badge, aggregate scores, TTP chips, and all sections", async () => {
    await renderPage("DAILY", "2026-05-26");
    expect(
      screen.getByTestId("priority-tier-badge").getAttribute("data-tier"),
    ).toBe("HIGH");
    expect(screen.getByTestId("aggregate-scores").textContent).toContain(
      "0.850",
    );
    expect(screen.getByTestId("ttp-tags").textContent).toContain("T1078");
    expect(screen.getByTestId("section-executive_summary").textContent).toBe(
      "A busy day.",
    );
    expect(screen.getByTestId("section-baseline_drift").textContent).toBe(
      "Malware up 30%.",
    );
  });

  it("shows the pending banner when the report is still generating", async () => {
    mockLoad.mockResolvedValue({ kind: "pending", stateStatus: "ready" });
    await renderPage("DAILY", "2026-05-26");
    expect(screen.getByLabelText("pending-banner")).toBeTruthy();
  });

  it("404s a lowercase period (case lock — no case-insensitive redirect)", async () => {
    await expect(renderPage("daily", "2026-05-26")).rejects.toThrow(
      "NEXT_NOT_FOUND",
    );
    expect(mockLoad).not.toHaveBeenCalled();
  });

  it("404s LIVE with a non-epoch bucket date", async () => {
    await expect(renderPage("LIVE", "2026-05-26")).rejects.toThrow(
      "NEXT_NOT_FOUND",
    );
    expect(mockLoad).not.toHaveBeenCalled();
  });

  it("404s an impossible calendar date before hitting the loader", async () => {
    // Shape-valid (YYYY-MM-DD) but not a real day; must 404 here rather
    // than reach the loader's `$3::date` cast and 500 (#297 round 5, item 2).
    await expect(renderPage("DAILY", "2026-02-31")).rejects.toThrow(
      "NEXT_NOT_FOUND",
    );
    expect(mockLoad).not.toHaveBeenCalled();
  });

  it("404s WEEKLY/MONTHLY (not produced in Phase 2)", async () => {
    await expect(renderPage("WEEKLY", "2026-05-26")).rejects.toThrow(
      "NEXT_NOT_FOUND",
    );
    expect(mockLoad).not.toHaveBeenCalled();
  });

  it("404s when the loader reports not_found", async () => {
    mockLoad.mockResolvedValue({ kind: "not_found" });
    await expect(renderPage("DAILY", "2026-05-26")).rejects.toThrow(
      "NEXT_NOT_FOUND",
    );
  });

  it("403s (real status) when the loader reports forbidden", async () => {
    mockLoad.mockResolvedValue({ kind: "forbidden" });
    await expect(renderPage("DAILY", "2026-05-26")).rejects.toThrow(
      "NEXT_FORBIDDEN",
    );
  });
});
