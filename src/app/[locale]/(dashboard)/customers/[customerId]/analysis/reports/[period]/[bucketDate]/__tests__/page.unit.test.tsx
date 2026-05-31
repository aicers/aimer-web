// @vitest-environment jsdom
//
// RFC 0002 Phase 2 (#297) — periodic report detail page. Verifies:
//   - uppercase-period case lock (lowercase period → notFound)
//   - LIVE pinned to the synthetic epoch bucket
//   - WEEKLY/MONTHLY render (Phase 3 / #298)
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

// The period tabs navigate via `next/link`; render it as a plain anchor
// so the cross-period `href` assertions below can read the attribute.
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

// `@/lib/instrumentation/time` is `server-only` (throws on import in
// jsdom) and seeds the LIVE-tab reference day; pin it to a fixed clock.
// 20:00Z is past the Asia/Seoul (UTC+9) date boundary, so the resolved-tz
// LIVE-tab test below can tell the Seoul calendar day (2026-05-28) apart
// from the UTC day (2026-05-27).
vi.mock("@/lib/instrumentation/time", () => ({
  getCurrentTimestamp: () => new Date("2026-05-27T20:00:00Z"),
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
        notable_events: "One notable event.",
        baseline_observations: "Malware up 30%.",
        period_outlook: "Watch the SSO endpoint tomorrow.",
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
    expect(
      screen.getByTestId("section-baseline_observations").textContent,
    ).toBe("Malware up 30%.");
  });

  it("renders the period tabs with the active period marked and cross-period links", async () => {
    // DAILY 2026-05-26 (a Tuesday): WEEKLY tab → ISO Monday 2026-05-25,
    // MONTHLY tab → 2026-05-01, LIVE tab → the synthetic epoch bucket.
    await renderPage("DAILY", "2026-05-26");
    expect(screen.getByTestId("report-period-tabs")).toBeTruthy();
    expect(
      screen.getByTestId("report-tab-DAILY").getAttribute("data-active"),
    ).toBe("true");
    expect(
      screen.getByTestId("report-tab-WEEKLY").getAttribute("href"),
    ).toContain("/reports/WEEKLY/2026-05-25");
    expect(
      screen.getByTestId("report-tab-MONTHLY").getAttribute("href"),
    ).toContain("/reports/MONTHLY/2026-05-01");
    expect(
      screen.getByTestId("report-tab-LIVE").getAttribute("href"),
    ).toContain("/reports/LIVE/1970-01-01");
  });

  it("shows the pending banner when the report is still generating", async () => {
    mockLoad.mockResolvedValue({
      kind: "pending",
      stateStatus: "ready",
      tz: "Asia/Seoul",
    });
    await renderPage("DAILY", "2026-05-26");
    expect(screen.getByLabelText("pending-banner")).toBeTruthy();
  });

  it("anchors the LIVE tabs on the resolved report tz, not UTC", async () => {
    // LIVE active → the cross-period tabs anchor on "today" in the report's
    // resolved tz. At 2026-05-27T20:00Z the Asia/Seoul day is 2026-05-28
    // (UTC+9), so DAILY must link to 2026-05-28, NOT the UTC day 2026-05-27.
    // This is the bug the loader's resolved tz fixes: a default LIVE URL has
    // no `?tz`, so anchoring off the raw query value would wrongly use UTC.
    const base = okFixture();
    if (base.kind !== "ok") throw new Error("fixture must be ok");
    mockLoad.mockResolvedValue({
      kind: "ok",
      data: {
        ...base.data,
        period: "LIVE",
        bucketDate: "1970-01-01",
        tz: "Asia/Seoul",
      },
    });
    await renderPage("LIVE", "1970-01-01");
    expect(
      screen.getByTestId("report-tab-DAILY").getAttribute("href"),
    ).toContain("/reports/DAILY/2026-05-28");
    expect(
      screen.getByTestId("report-tab-MONTHLY").getAttribute("href"),
    ).toContain("/reports/MONTHLY/2026-05-01");
  });

  it("does not 500 a LIVE page when the resolved tz is malformed", async () => {
    // A bad pinned `?tz` must not crash the tab bar via `Intl`'s RangeError;
    // it falls back to the UTC calendar day (2026-05-27 at 20:00Z).
    mockLoad.mockResolvedValue({
      kind: "pending",
      stateStatus: "ready",
      tz: "Not/AZone",
    });
    await renderPage("LIVE", "1970-01-01");
    expect(screen.getByLabelText("pending-banner")).toBeTruthy();
    expect(
      screen.getByTestId("report-tab-DAILY").getAttribute("href"),
    ).toContain("/reports/DAILY/2026-05-27");
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

  it.each([
    "WEEKLY",
    "MONTHLY",
  ])("renders %s reports (lifted in #298)", async (period) => {
    const base = okFixture();
    if (base.kind !== "ok") throw new Error("fixture must be ok");
    mockLoad.mockResolvedValue({
      kind: "ok",
      data: { ...base.data, period },
    });
    await renderPage(period, "2026-05-25");
    expect(mockLoad).toHaveBeenCalled();
    expect(
      screen.getByTestId("priority-tier-badge").getAttribute("data-tier"),
    ).toBe("HIGH");
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
