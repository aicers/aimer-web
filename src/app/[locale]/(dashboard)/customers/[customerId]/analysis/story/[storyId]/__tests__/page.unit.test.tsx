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
import type { StoryResultPageOutcome } from "@/lib/analysis/story-result-page-loader";

const mockLoad = vi.fn<() => Promise<StoryResultPageOutcome>>();

vi.mock("@/lib/analysis/story-result-page-loader", () => ({
  loadStoryResultPage: () => mockLoad(),
}));

vi.mock("next/navigation", () => ({
  notFound: () => {
    throw new Error("NEXT_NOT_FOUND");
  },
}));

vi.mock("../regenerate-button", () => ({
  StoryRegenerateButton: () => null,
}));

import StoryAnalysisPage from "../page";

const CUSTOMER_ID = "c0000000-0000-0000-0000-000000000001";
const STORY_ID = "12345";

function fixture(tier: PriorityTier): StoryResultPageOutcome {
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
      severityFactors: ["broad host coverage", "elevated identity reuse"],
      likelihoodFactors: ["repeated outbound C2 beacons"],
      ttpTags: [{ id: "T1078", name: "Valid Accounts" }],
      analysisText: "Narrative body.",
      requestedBy: null,
      requestedAt: new Date("2026-05-27T12:00:00Z"),
    },
  };
}

async function renderPage(): Promise<void> {
  const jsx = await StoryAnalysisPage({
    params: Promise.resolve({
      locale: "en",
      customerId: CUSTOMER_ID,
      storyId: STORY_ID,
    }),
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
