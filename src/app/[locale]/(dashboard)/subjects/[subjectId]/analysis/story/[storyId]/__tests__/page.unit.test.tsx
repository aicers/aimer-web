// @vitest-environment jsdom
//
// LOW-tier disclosure contract for the story analysis page (#333):
// severity / likelihood factor lists collapse under native `<details>`
// for `priority_tier === "LOW"` and render outside any disclosure for
// the higher tiers. The priority badge, numeric scores, and TTP chips
// stay always-visible regardless of tier (option (b) of the locked
// decision).

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PriorityTier } from "@/lib/analysis/priority-tier";
import type {
  CoverageStatus,
  StoryResultPageOutcome,
} from "@/lib/analysis/story-result-page-loader";

const mockLoad = vi.fn<() => Promise<StoryResultPageOutcome>>();

vi.mock("@/lib/analysis/story-result-page-loader", () => ({
  loadStoryResultPage: () => mockLoad(),
}));

// The model catalog (#458) is a `server-only` module; stub it so importing
// the page in jsdom does not pull `server-only`. An empty catalog keeps the
// analyst-only compare controls out of these (non-compare) render assertions.
vi.mock("@/lib/analysis/model-catalog", () => ({
  getModelCatalog: () => [],
}));

// The page also loads the reverse "Cited by" trail (T2 #396); stub it to
// an empty trail so these disclosure / pin tests stay isolated.
vi.mock("@/lib/analysis/cited-by-loader", () => ({
  loadCitedByReports: async () => [],
}));

vi.mock("next/navigation", () => ({
  notFound: () => {
    throw new Error("NEXT_NOT_FOUND");
  },
  // Read by the breadcrumb label registrar mounted on the ok path.
  usePathname: () => "/en/subjects/c1/analysis/story/12345",
}));

// `<Timestamp>` reads the active locale via `useLocale()`; this page test
// renders it outside a `NextIntlClientProvider`, so supply a fixed locale
// while keeping the rest of next-intl real (the server mock below still
// resolves the real `createTranslator`).
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

// Render an identifiable element (not `null`) so present/absent assertions
// on the analyst gate (#457) are meaningful rather than vacuous.
vi.mock("../regenerate-button", () => ({
  StoryRegenerateButton: () => (
    <button type="button" data-testid="regenerate-button" />
  ),
}));

import StoryAnalysisPage from "../page";

describe("StoryAnalysisPage — generation pin", () => {
  beforeEach(() => mockLoad.mockReset());
  afterEach(() => cleanup());

  it("shows the evidence-unavailable notice for a pin_unavailable outcome", async () => {
    mockLoad.mockResolvedValueOnce({ kind: "pin_unavailable", generation: 7 });
    await renderPage({ generation: "7" });
    expect(screen.getByTestId("pin-unavailable-banner")).toBeTruthy();
    expect(screen.getByTestId("pin-unavailable-banner").textContent).toContain(
      "no longer available",
    );
  });

  it("404s a present-but-invalid generation rather than resolving latest", async () => {
    await expect(renderPage({ generation: "0" })).rejects.toThrow(
      "NEXT_NOT_FOUND",
    );
    expect(mockLoad).not.toHaveBeenCalled();
  });
});

const CUSTOMER_ID = "c0000000-0000-0000-0000-000000000001";
const STORY_ID = "12345";

function fixture(
  tier: PriorityTier,
  viewer: {
    isViewerAnalyst?: boolean;
    canRegenerate?: boolean;
    coverageStatus?: CoverageStatus | null;
  } = {},
): StoryResultPageOutcome {
  const isViewerAnalyst = viewer.isViewerAnalyst ?? true;
  return {
    kind: "ok",
    data: {
      customerId: CUSTOMER_ID,
      storyId: STORY_ID,
      lang: "ENGLISH",
      modelName: "openai",
      model: "gpt-4o",
      modelActualVersion: "gpt-4o-2024-08-06",
      promptVersion: "v1",
      generation: 1,
      severityScore: 0.5,
      likelihoodScore: 0.5,
      priorityTier: tier,
      coverageStatus: viewer.coverageStatus ?? null,
      severityFactors: ["broad host coverage", "elevated identity reuse"],
      likelihoodFactors: ["repeated outbound C2 beacons"],
      ttpTags: [{ id: "T1078", name: "Valid Accounts" }],
      analysisText: "Narrative body.",
      requestedBy: null,
      requestedAt: new Date("2026-05-27T12:00:00Z"),
      isViewerAnalyst,
      canRegenerate: viewer.canRegenerate ?? isViewerAnalyst,
      memberEvents: [],
      memberEventVariant: {
        lang: "ENGLISH",
        modelName: "openai",
        model: "gpt-4o",
      },
    },
  };
}

async function renderPage(
  searchParams?: Record<string, string>,
): Promise<void> {
  const jsx = await StoryAnalysisPage({
    params: Promise.resolve({
      locale: "en",
      subjectId: CUSTOMER_ID,
      storyId: STORY_ID,
    }),
    searchParams: searchParams ? Promise.resolve(searchParams) : undefined,
  });
  render(jsx);
}

beforeEach(() => {
  mockLoad.mockReset();
});

afterEach(() => {
  cleanup();
});

describe("StoryAnalysisPage — LOW-tier disclosure", () => {
  it("wraps severity and likelihood factor rows in a closed <details> for LOW", async () => {
    mockLoad.mockResolvedValueOnce(fixture("LOW"));
    await renderPage();

    const severityDetails = screen.getByTestId(
      "severity-factors-details",
    ) as HTMLDetailsElement;
    const likelihoodDetails = screen.getByTestId(
      "likelihood-factors-details",
    ) as HTMLDetailsElement;
    expect(severityDetails.tagName).toBe("DETAILS");
    expect(severityDetails.open).toBe(false);
    expect(likelihoodDetails.open).toBe(false);

    // The summaries carry the disclosure trigger label; native
    // `<details>` exposes the open/closed state to AT via the user
    // agent, so no explicit `aria-expanded` is wired on the trigger.
    expect(severityDetails.querySelector("summary")).not.toBeNull();
    expect(severityDetails.querySelector("summary")?.textContent).toMatch(
      /severity/i,
    );

    // Priority badge and TTP chips stay visible without interaction.
    expect(screen.getByTestId("priority-tier-badge")).toBeTruthy();
    expect(screen.getByTestId("ttp-tags")).toBeTruthy();
  });

  it("expands when the disclosure trigger is activated", async () => {
    mockLoad.mockResolvedValueOnce(fixture("LOW"));
    await renderPage();

    const severityDetails = screen.getByTestId(
      "severity-factors-details",
    ) as HTMLDetailsElement;
    const summary = severityDetails.querySelector("summary");
    if (!summary) throw new Error("summary missing");

    // jsdom does not dispatch the implicit `toggle` event when
    // `<summary>` is clicked the way a real user agent would; flip
    // `open` directly to simulate the end state.
    severityDetails.open = true;

    expect(severityDetails.open).toBe(true);
    expect(screen.getByTestId("severity-factors")).toBeTruthy();
    expect(summary).not.toBeNull();
  });

  it.each<PriorityTier>([
    "MEDIUM",
    "HIGH",
    "CRITICAL",
  ])("renders factor rows outside any <details> wrapper for %s", async (tier) => {
    mockLoad.mockResolvedValueOnce(fixture(tier));
    await renderPage();

    expect(screen.queryByTestId("severity-factors-details")).toBeNull();
    expect(screen.queryByTestId("likelihood-factors-details")).toBeNull();

    // Factor chip lists render directly (not behind a disclosure).
    expect(screen.getByTestId("severity-factors")).toBeTruthy();
    expect(screen.getByTestId("likelihood-factors")).toBeTruthy();
  });
});

describe("StoryAnalysisPage — analyst gating (#457)", () => {
  it("shows provenance fields and the Regenerate button for an analyst", async () => {
    mockLoad.mockResolvedValueOnce(
      fixture("HIGH", { isViewerAnalyst: true, canRegenerate: true }),
    );
    await renderPage();

    // Analytically-meaningful fields stay visible to everyone.
    expect(screen.getByTestId("priority-tier-badge")).toBeTruthy();
    expect(screen.getByText("Language")).toBeTruthy();
    expect(screen.getByText("Severity score (if real, how bad)")).toBeTruthy();

    // Six provenance fields (provider + model split into two here).
    expect(screen.getByText("Provider")).toBeTruthy();
    expect(screen.getByText("Model")).toBeTruthy();
    expect(screen.getByText("Model snapshot")).toBeTruthy();
    expect(screen.getByText("Prompt version")).toBeTruthy();
    expect(screen.getByText("Requested by")).toBeTruthy();
    expect(screen.getByText("Requested at")).toBeTruthy();

    expect(screen.getByTestId("regenerate-button")).toBeTruthy();
  });

  it("hides provenance fields and the Regenerate button for a non-analyst", async () => {
    mockLoad.mockResolvedValueOnce(
      fixture("HIGH", { isViewerAnalyst: false, canRegenerate: false }),
    );
    await renderPage();

    // Analytically-meaningful fields remain visible to a non-analyst.
    expect(screen.getByTestId("priority-tier-badge")).toBeTruthy();
    expect(screen.getByText("Language")).toBeTruthy();
    expect(screen.getByText("Severity score (if real, how bad)")).toBeTruthy();

    // Provenance fields and the Regenerate button are gone.
    expect(screen.queryByText("Provider")).toBeNull();
    expect(screen.queryByText("Model")).toBeNull();
    expect(screen.queryByText("Model snapshot")).toBeNull();
    expect(screen.queryByText("Prompt version")).toBeNull();
    expect(screen.queryByText("Requested by")).toBeNull();
    expect(screen.queryByText("Requested at")).toBeNull();
    expect(screen.queryByTestId("regenerate-button")).toBeNull();
  });

  it("shows provenance but hides the Regenerate button for a bridge-session analyst", async () => {
    // A bridge-session analyst reads the story (provenance is analyst-gated,
    // so visible) but cannot regenerate: the endpoint authorizes a WRITE,
    // which a bridge session can never pass. `canRegenerate` is false even
    // though `isViewerAnalyst` is true — the button must be absent.
    mockLoad.mockResolvedValueOnce(
      fixture("HIGH", { isViewerAnalyst: true, canRegenerate: false }),
    );
    await renderPage();

    expect(screen.getByText("Provider")).toBeTruthy();
    expect(screen.getByText("Model snapshot")).toBeTruthy();
    expect(screen.getByText("Requested at")).toBeTruthy();

    expect(screen.queryByTestId("regenerate-button")).toBeNull();
  });
});

describe("StoryAnalysisPage — IOC coverage status banner (#498)", () => {
  it.each<CoverageStatus>([
    "unknown",
    "stale",
    "partial",
  ])("shows the incomplete-coverage banner for %s", async (status) => {
    mockLoad.mockResolvedValueOnce(fixture("LOW", { coverageStatus: status }));
    await renderPage();

    const banner = screen.getByTestId("coverage-status-banner");
    expect(banner).toBeTruthy();
    expect(banner.getAttribute("data-coverage-status")).toBe(status);
    expect(banner.textContent).toContain("Threat-intel coverage incomplete");
  });

  it("renders no banner for complete coverage (clean miss reads cleanly)", async () => {
    mockLoad.mockResolvedValueOnce(
      fixture("LOW", { coverageStatus: "complete" }),
    );
    await renderPage();
    expect(screen.queryByTestId("coverage-status-banner")).toBeNull();
  });

  it("renders no banner when coverage is unknown-to-the-loader (null)", async () => {
    mockLoad.mockResolvedValueOnce(fixture("LOW", { coverageStatus: null }));
    await renderPage();
    expect(screen.queryByTestId("coverage-status-banner")).toBeNull();
  });
});
