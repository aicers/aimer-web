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
  // The phase-2 status poller is a client component that calls useRouter.
  useRouter: () => ({ refresh: vi.fn() }),
}));

// Server-component translations: echo the key so assertions can target
// testids rather than localized copy (mirrors other dashboard page tests).
vi.mock("next-intl/server", () => ({
  getTranslations: async () => (key: string) => key,
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
      citedSources: {
        stories: [
          {
            storyId: "555",
            variant: {
              generation: 2,
              lang: "ENGLISH",
              modelName: "openai",
              model: "gpt-4o",
            },
            display: {
              priorityTier: "HIGH",
              severityScore: 0.6,
              likelihoodScore: 0.7,
              ttpTags: [{ id: "T1078", name: "Valid Accounts" }],
            },
          },
        ],
        events: [
          {
            aiceId: "aice-9",
            eventKey: "777",
            variant: {
              generation: 2,
              lang: "ENGLISH",
              modelName: "openai",
              model: "gpt-4o",
            },
            display: {
              priorityTier: "MEDIUM",
              severityScore: 0.4,
              likelihoodScore: 0.5,
            },
          },
        ],
      },
      requestedBy: null,
      requestedAt: new Date("2026-05-27T12:00:00Z"),
      requestedLocale: "en",
      availableLocales: ["en"],
      languageFallback: null,
    },
  };
}

async function renderPage(
  period: string,
  bucketDate: string,
  searchParams?: Record<string, string | string[] | undefined>,
): Promise<void> {
  const jsx = await ReportDetailPage({
    params: Promise.resolve({
      locale: "en",
      customerId: CUSTOMER_ID,
      period,
      bucketDate,
    }),
    searchParams: searchParams ? Promise.resolve(searchParams) : undefined,
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

  it("renders a Sources panel with cited story/event cards and N stories · M events", async () => {
    await renderPage("DAILY", "2026-05-26");
    expect(screen.getByTestId("sources-panel")).toBeTruthy();
    expect(screen.getByTestId("sources-provenance").textContent).toBe(
      "1 story · 1 event",
    );
    expect(screen.getByTestId("source-story-555")).toBeTruthy();
    expect(screen.getByTestId("source-event-aice-9-777")).toBeTruthy();
  });

  it("pins each Sources link to the cited variant (generation + lang + model)", async () => {
    await renderPage("DAILY", "2026-05-26");
    const storyHref = screen
      .getByTestId("source-story-555")
      .getAttribute("href");
    // The four params guard against linking to the latest generation.
    expect(storyHref).toContain("/analysis/story/555");
    expect(storyHref).toContain("generation=2");
    expect(storyHref).toContain("lang=ENGLISH");
    expect(storyHref).toContain("model_name=openai");
    expect(storyHref).toContain("model=gpt-4o");

    const eventHref = screen
      .getByTestId("source-event-aice-9-777")
      .getAttribute("href");
    expect(eventHref).toContain("/aice/aice-9/events/777/analysis");
    expect(eventHref).toContain("generation=2");
    expect(eventHref).toContain("lang=ENGLISH");
    expect(eventHref).toContain("model_name=openai");
    expect(eventHref).toContain("model=gpt-4o");
  });

  it("attaches the Sources panel to the leaf-derived sections, not baseline", async () => {
    await renderPage("DAILY", "2026-05-26");
    // Exactly one report-level Sources panel, and it is not nested inside
    // the baseline section (the drill-down's deliberate stopping point).
    expect(screen.getAllByTestId("sources-panel")).toHaveLength(1);
    const baseline = screen.getByTestId("section-baseline_observations");
    expect(baseline.querySelector('[data-testid="sources-panel"]')).toBeNull();
    // The panel precedes the baseline section in document order.
    const panel = screen.getByTestId("sources-panel");
    expect(
      panel.compareDocumentPosition(baseline) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  it("degrades a Sources card to ID/generation when the pinned row is unavailable", async () => {
    const base = okFixture();
    if (base.kind !== "ok") throw new Error("fixture must be ok");
    mockLoad.mockResolvedValue({
      kind: "ok",
      data: {
        ...base.data,
        citedSources: {
          stories: [
            {
              storyId: "555",
              variant: {
                generation: 1,
                lang: "ENGLISH",
                modelName: "openai",
                model: "gpt-4o",
              },
              display: null,
            },
          ],
          events: [],
        },
      },
    });
    await renderPage("DAILY", "2026-05-26");
    const card = screen.getByTestId("source-story-555");
    // The card still links to the pinned generation and shows the ID...
    expect(card.getAttribute("href")).toContain("generation=1");
    expect(card.textContent).toContain("Story 555");
    expect(card.textContent).toContain("generation 1");
    // ...but degrades to the unavailable note instead of display fields.
    expect(screen.getByTestId("source-unavailable")).toBeTruthy();
  });

  it("omits the Sources panel when there are no cited sources", async () => {
    const base = okFixture();
    if (base.kind !== "ok") throw new Error("fixture must be ok");
    mockLoad.mockResolvedValue({
      kind: "ok",
      data: { ...base.data, citedSources: { stories: [], events: [] } },
    });
    await renderPage("DAILY", "2026-05-26");
    expect(screen.queryByTestId("sources-panel")).toBeNull();
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

  it("renders the language switcher marking available vs unavailable locales", async () => {
    const base = okFixture();
    if (base.kind !== "ok") throw new Error("fixture must be ok");
    mockLoad.mockResolvedValue({
      kind: "ok",
      data: { ...base.data, availableLocales: ["en"] },
    });
    await renderPage("DAILY", "2026-05-26");
    expect(screen.getByTestId("report-language-switcher")).toBeTruthy();
    // English is shown + available; Korean is offered but not yet available.
    expect(
      screen.getByTestId("report-lang-en").getAttribute("data-active"),
    ).toBe("true");
    expect(
      screen.getByTestId("report-lang-ko").getAttribute("data-available"),
    ).toBe("false");
    // The Korean option deep-links with ?lang=ko, preserving variant params.
    expect(screen.getByTestId("report-lang-ko").getAttribute("href")).toContain(
      "lang=ko",
    );
  });

  it("shows the fallback notice + on-demand status when the requested language is unavailable", async () => {
    const base = okFixture();
    if (base.kind !== "ok") throw new Error("fixture must be ok");
    // Korean requested, English shown — a fallback with a queued on-demand job.
    mockLoad.mockResolvedValue({
      kind: "ok",
      data: {
        ...base.data,
        lang: "ENGLISH",
        requestedLocale: "ko",
        availableLocales: ["en"],
        languageFallback: {
          requestedLocale: "ko",
          shownLocale: "en",
          jobStatus: "queued",
        },
      },
    });
    await renderPage("DAILY", "2026-05-26", { lang: "ko" });
    expect(screen.getByTestId("report-language-fallback")).toBeTruthy();
    const status = screen.getByTestId("report-language-status");
    expect(status.getAttribute("data-status")).toBe("queued");
  });

  it("surfaces a failed on-demand job as a non-blocking error, not a spinner", async () => {
    const base = okFixture();
    if (base.kind !== "ok") throw new Error("fixture must be ok");
    mockLoad.mockResolvedValue({
      kind: "ok",
      data: {
        ...base.data,
        lang: "ENGLISH",
        requestedLocale: "ko",
        availableLocales: ["en"],
        languageFallback: {
          requestedLocale: "ko",
          shownLocale: "en",
          jobStatus: "failed",
        },
      },
    });
    await renderPage("DAILY", "2026-05-26", { lang: "ko" });
    const status = screen.getByTestId("report-language-status");
    expect(status.getAttribute("data-status")).toBe("failed");
    expect(status.getAttribute("role")).toBe("alert");
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
