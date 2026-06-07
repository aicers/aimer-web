// @vitest-environment jsdom
//
// #458 — analyst-only report compare view. Verifies two columns render section
// by section when both variants exist, the missing-variant CTA replaces the
// second column (and never auto-generates), and the #379 leaf-coverage note
// surfaces when the compare column's leaf-derived sections are empty.

import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import type {
  ReportCompareOutcome,
  ReportSections,
} from "@/lib/analysis/report-result-page-loader";
import { ReportCompareView } from "../report-compare-view";

// Minimal translator stub: echo the key (and vars) so assertions can key off
// the message id without depending on the catalog copy.
// biome-ignore lint/suspicious/noExplicitAny: test translator stub
const t = ((key: string) => key) as any;

function sections(overrides: Partial<ReportSections> = {}): ReportSections {
  return {
    executive_summary: [{ text: "Primary exec summary." }],
    story_highlights: [{ text: "Primary highlights." }],
    notable_events: [{ text: "Primary events." }],
    baseline_observations: "Primary baseline.",
    period_outlook: "Primary outlook.",
    ...overrides,
  };
}

const primary = {
  modelName: "openai",
  model: "gpt-4o",
  modelActualVersion: "2026-01",
  promptVersion: "v5",
  generation: 3,
  sections: sections(),
};

afterEach(cleanup);

describe("ReportCompareView", () => {
  it("renders both columns section by section when the compare variant exists", () => {
    const compare: ReportCompareOutcome = {
      kind: "ok",
      data: {
        modelName: "anthropic",
        model: "claude-3-5",
        modelActualVersion: "2026-02",
        promptVersion: "v5",
        generation: 1,
        lang: "ENGLISH",
        priorityTier: "HIGH",
        aggregateSeverityScore: 0.5,
        aggregateLikelihoodScore: 0.5,
        sections: sections({
          executive_summary: [{ text: "Compared exec summary." }],
        }),
      },
    };
    const { getByTestId, queryByTestId } = render(
      <ReportCompareView
        primary={primary}
        compare={compare}
        compareTargetLabel="Claude 3.5"
        regenerateCta={<div data-testid="cta" />}
        t={t}
      />,
    );
    // Each of the five sections has a primary + compare cell.
    for (const key of [
      "executive_summary",
      "story_highlights",
      "notable_events",
      "baseline_observations",
      "period_outlook",
    ]) {
      expect(getByTestId(`compare-primary-${key}`)).toBeTruthy();
      expect(getByTestId(`compare-compare-${key}`)).toBeTruthy();
    }
    expect(
      getByTestId("compare-primary-executive_summary").textContent,
    ).toContain("Primary exec summary.");
    expect(
      getByTestId("compare-compare-executive_summary").textContent,
    ).toContain("Compared exec summary.");
    // No not-generated CTA when the variant exists.
    expect(queryByTestId("compare-not-generated")).toBeNull();
  });

  it("shows the regenerate CTA and no second column when the compare variant is missing", () => {
    const compare: ReportCompareOutcome = {
      kind: "not_generated",
      modelName: "anthropic",
      model: "claude-3-5",
    };
    const { getByTestId, queryByTestId } = render(
      <ReportCompareView
        primary={primary}
        compare={compare}
        compareTargetLabel="Claude 3.5"
        regenerateCta={<div data-testid="cta" />}
        t={t}
      />,
    );
    expect(getByTestId("compare-not-generated")).toBeTruthy();
    expect(getByTestId("cta")).toBeTruthy();
    // The primary column still renders; there is no compare column.
    expect(getByTestId("compare-primary-executive_summary")).toBeTruthy();
    expect(queryByTestId("compare-compare-executive_summary")).toBeNull();
  });

  it("surfaces the #379 leaf-coverage note when compare leaf sections are empty", () => {
    const compare: ReportCompareOutcome = {
      kind: "ok",
      data: {
        modelName: "anthropic",
        model: "claude-3-5",
        modelActualVersion: "2026-02",
        promptVersion: "v5",
        generation: 1,
        lang: "ENGLISH",
        priorityTier: "HIGH",
        aggregateSeverityScore: 0.5,
        aggregateLikelihoodScore: 0.5,
        // Non-default model: leaves not yet re-analyzed → empty leaf sections.
        sections: sections({ story_highlights: [], notable_events: [] }),
      },
    };
    const { getByTestId } = render(
      <ReportCompareView
        primary={primary}
        compare={compare}
        compareTargetLabel="Claude 3.5"
        regenerateCta={<div data-testid="cta" />}
        t={t}
      />,
    );
    expect(getByTestId("compare-leaf-coverage")).toBeTruthy();
  });
});
