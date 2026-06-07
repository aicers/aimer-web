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

const DEFAULT_MODEL = { modelName: "openai", model: "gpt-4o" };

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
        primaryLabel="GPT-4o"
        compare={compare}
        compareTargetLabel="Claude 3.5"
        defaultModel={DEFAULT_MODEL}
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
        primaryLabel="GPT-4o"
        compare={compare}
        compareTargetLabel="Claude 3.5"
        defaultModel={DEFAULT_MODEL}
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

  // A non-default compare column with empty leaf-derived sections.
  function nonDefaultEmptyLeafCompare(): ReportCompareOutcome {
    return {
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
  }

  it("surfaces the #379 leaf-coverage note when a non-default compare column has empty leaf sections", () => {
    const { getByTestId } = render(
      <ReportCompareView
        primary={primary}
        primaryLabel="GPT-4o"
        compare={nonDefaultEmptyLeafCompare()}
        compareTargetLabel="Claude 3.5"
        defaultModel={DEFAULT_MODEL}
        regenerateCta={<div data-testid="cta" />}
        t={t}
      />,
    );
    expect(getByTestId("compare-leaf-coverage")).toBeTruthy();
  });

  it("surfaces the note when the PRIMARY column is a non-default model with empty leaf sections (compare complete)", () => {
    // The currently-open variant can itself be a non-default model. Driving
    // the note off the compare column alone would miss this case.
    const nonDefaultPrimary = {
      ...primary,
      modelName: "anthropic",
      model: "claude-3-5",
      sections: sections({ story_highlights: [], notable_events: [] }),
    };
    const compare: ReportCompareOutcome = {
      kind: "ok",
      data: {
        modelName: "openai",
        model: "gpt-4o",
        modelActualVersion: "2026-01",
        promptVersion: "v5",
        generation: 2,
        lang: "ENGLISH",
        priorityTier: "HIGH",
        aggregateSeverityScore: 0.5,
        aggregateLikelihoodScore: 0.5,
        sections: sections(), // default model, fully populated
      },
    };
    const { getByTestId } = render(
      <ReportCompareView
        primary={nonDefaultPrimary}
        primaryLabel="Claude 3.5"
        compare={compare}
        compareTargetLabel="GPT-4o"
        defaultModel={DEFAULT_MODEL}
        regenerateCta={<div data-testid="cta" />}
        t={t}
      />,
    );
    expect(getByTestId("compare-leaf-coverage")).toBeTruthy();
  });

  it("does NOT show the note when an empty leaf section belongs to the DEFAULT model", () => {
    // A default-model column with a genuinely empty leaf section is not the
    // #379 coverage caveat (that is specific to non-default models).
    const compare: ReportCompareOutcome = {
      kind: "ok",
      data: {
        modelName: "openai",
        model: "gpt-4o",
        modelActualVersion: "2026-01",
        promptVersion: "v5",
        generation: 2,
        lang: "ENGLISH",
        priorityTier: "HIGH",
        aggregateSeverityScore: 0.5,
        aggregateLikelihoodScore: 0.5,
        sections: sections({ story_highlights: [], notable_events: [] }),
      },
    };
    const { queryByTestId } = render(
      <ReportCompareView
        primary={primary}
        primaryLabel="GPT-4o"
        compare={compare}
        compareTargetLabel="GPT-4o"
        defaultModel={DEFAULT_MODEL}
        regenerateCta={<div data-testid="cta" />}
        t={t}
      />,
    );
    expect(queryByTestId("compare-leaf-coverage")).toBeNull();
  });
});
