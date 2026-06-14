// @vitest-environment jsdom
//
// #458 — analyst-only story compare view. Verifies two columns (analysis,
// scores, factors) render when both variants exist, and that the missing
// compare variant shows the regenerate CTA instead of a second column.

import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import type { StoryCompareOutcome } from "@/lib/analysis/story-result-page-loader";
import { StoryCompareView } from "../story-compare-view";

// biome-ignore lint/suspicious/noExplicitAny: test translator stub
const t = ((key: string) => key) as any;

const primary = {
  modelName: "openai",
  model: "gpt-4o",
  modelActualVersion: "2026-01",
  promptVersion: "v3",
  generation: 3,
  severityScore: 0.6,
  likelihoodScore: 0.4,
  priorityTier: "HIGH" as const,
  severityFactors: ["primary sev factor"],
  likelihoodFactors: ["primary lik factor"],
  analysisText: "Primary narrative.",
};

afterEach(cleanup);

describe("StoryCompareView", () => {
  it("renders both columns (analysis + scores) when the compare variant exists", () => {
    const compare: StoryCompareOutcome = {
      kind: "ok",
      data: {
        modelName: "anthropic",
        model: "claude-3-5",
        modelActualVersion: "2026-02",
        promptVersion: "v3",
        generation: 1,
        lang: "ENGLISH",
        severityScore: 0.9,
        likelihoodScore: 0.8,
        priorityTier: "CRITICAL",
        severityFactors: ["compare sev factor"],
        likelihoodFactors: ["compare lik factor"],
        ttpTags: [],
        cveRefs: [],
        cveStatus: null,
        analysisText: "Compared narrative.",
      },
    };
    const { getByTestId, queryByTestId } = render(
      <StoryCompareView
        primary={primary}
        compare={compare}
        compareTargetLabel="Claude 3.5"
        regenerateCta={<div data-testid="cta" />}
        t={t}
      />,
    );
    expect(getByTestId("compare-primary-analysis").textContent).toContain(
      "Primary narrative.",
    );
    expect(getByTestId("compare-compare-analysis").textContent).toContain(
      "Compared narrative.",
    );
    expect(getByTestId("compare-primary-severity")).toBeTruthy();
    expect(getByTestId("compare-compare-severity")).toBeTruthy();
    expect(getByTestId("compare-compare-likelihood")).toBeTruthy();
    expect(queryByTestId("compare-not-generated")).toBeNull();
  });

  it("shows the regenerate CTA and no second column when the compare variant is missing", () => {
    const compare: StoryCompareOutcome = {
      kind: "not_generated",
      modelName: "anthropic",
      model: "claude-3-5",
    };
    const { getByTestId, queryByTestId } = render(
      <StoryCompareView
        primary={primary}
        compare={compare}
        compareTargetLabel="Claude 3.5"
        regenerateCta={<div data-testid="cta" />}
        t={t}
      />,
    );
    expect(getByTestId("compare-not-generated")).toBeTruthy();
    expect(getByTestId("cta")).toBeTruthy();
    expect(getByTestId("compare-primary-analysis")).toBeTruthy();
    expect(queryByTestId("compare-compare-analysis")).toBeNull();
  });
});
