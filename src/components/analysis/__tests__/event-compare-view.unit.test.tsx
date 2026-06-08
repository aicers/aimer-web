// @vitest-environment jsdom
//
// #464 — analyst-only event compare view. Verifies two columns (analysis,
// scores, factors, TTP tags, tier, provenance) render when both variants
// exist, that the missing compare variant shows the regenerate CTA instead of
// a second column, and that the report-side leaf-coverage note never renders on
// the self-contained event surface.

import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import type { EventCompareOutcome } from "@/lib/analysis/result-page-loader";
import { EventCompareView } from "../event-compare-view";

const translate = (key: string, vars?: Record<string, unknown>) =>
  vars ? `${key}:${JSON.stringify(vars)}` : key;
// biome-ignore lint/suspicious/noExplicitAny: test translator stub
const t = translate as any;

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
  ttpTags: [{ id: "T1078", name: "Valid Accounts" }],
  analysisText: "Primary narrative.",
};

afterEach(cleanup);

describe("EventCompareView", () => {
  it("renders both columns aligned across event fields when the compare variant exists", () => {
    const compare: EventCompareOutcome = {
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
        ttpTags: [{ id: "T1110", name: "Brute Force" }],
        analysisText: "Compared narrative.",
      },
    };
    const { getByTestId, queryByTestId } = render(
      <EventCompareView
        primary={primary}
        compare={compare}
        compareTargetLabel="Claude 3.5"
        regenerateCta={<div data-testid="cta" />}
        t={t}
      />,
    );
    // Analysis text, scores, tier, and TTP tags all align across both columns.
    expect(getByTestId("compare-primary-analysis").textContent).toContain(
      "Primary narrative.",
    );
    expect(getByTestId("compare-compare-analysis").textContent).toContain(
      "Compared narrative.",
    );
    expect(getByTestId("compare-primary-severity")).toBeTruthy();
    expect(getByTestId("compare-compare-severity")).toBeTruthy();
    expect(getByTestId("compare-primary-likelihood")).toBeTruthy();
    expect(getByTestId("compare-compare-likelihood")).toBeTruthy();
    expect(getByTestId("compare-primary-tier").textContent).toContain("HIGH");
    expect(getByTestId("compare-compare-tier").textContent).toContain(
      "CRITICAL",
    );
    expect(getByTestId("compare-primary-ttp").textContent).toContain("T1078");
    expect(getByTestId("compare-compare-ttp").textContent).toContain("T1110");
    expect(queryByTestId("compare-not-generated")).toBeNull();
    // The #379 leaf-coverage note is report-only; it must never render here.
    expect(t("compare.leafCoverageNote")).toBe("compare.leafCoverageNote");
    expect(
      document.body.textContent?.includes("compare.leafCoverageNote"),
    ).toBe(false);
  });

  it("shows the regenerate CTA and no second column when the compare variant is missing", () => {
    const compare: EventCompareOutcome = {
      kind: "not_generated",
      modelName: "anthropic",
      model: "claude-3-5",
    };
    const { getByTestId, queryByTestId } = render(
      <EventCompareView
        primary={primary}
        compare={compare}
        compareTargetLabel="Claude 3.5"
        regenerateCta={<div data-testid="cta" />}
        t={t}
      />,
    );
    expect(getByTestId("compare-not-generated")).toBeTruthy();
    expect(getByTestId("compare-not-generated").textContent).toContain(
      "compare.notGeneratedEvent",
    );
    expect(getByTestId("cta")).toBeTruthy();
    expect(getByTestId("compare-primary-analysis")).toBeTruthy();
    expect(queryByTestId("compare-compare-analysis")).toBeNull();
  });

  it("omits the CTA when the source event was swept by retention (no regenerateCta passed)", () => {
    // The page withholds the regenerate CTA when `canRegenerate +
    // sourceEventPresent` is not met; the view still renders the
    // not-generated/retention state without a dead control.
    const compare: EventCompareOutcome = {
      kind: "not_generated",
      modelName: "anthropic",
      model: "claude-3-5",
    };
    const { getByTestId, queryByTestId } = render(
      <EventCompareView
        primary={primary}
        compare={compare}
        compareTargetLabel="Claude 3.5"
        regenerateCta={null}
        t={t}
      />,
    );
    expect(getByTestId("compare-not-generated")).toBeTruthy();
    expect(queryByTestId("cta")).toBeNull();
  });
});
