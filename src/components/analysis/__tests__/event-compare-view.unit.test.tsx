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
  cveRefs: [
    {
      cve: "CVE-2024-3400",
      cvss: { score: 9.8, source: "nvd" as const },
      kev: { knownExploited: true, source: "kev" as const },
      epss: { score: 0.94, percentile: 0.99, source: "epss" as const },
      summary: "PAN-OS GlobalProtect RCE",
      inTheWild: true,
      sources: ["nvd" as const, "kev" as const, "epss" as const],
    },
  ],
  cveStatus: "complete" as const,
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
        cveRefs: [
          {
            cve: "CVE-2023-44487",
            cvss: { score: 7.5, source: "nvd" },
            kev: { knownExploited: true, source: "kev" },
            epss: { score: 0.86, percentile: 0.99, source: "epss" },
            summary: "HTTP/2 Rapid Reset",
            inTheWild: true,
            sources: ["nvd", "kev", "epss"],
          },
        ],
        cveStatus: "complete",
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
    // RFC 0005 — CVE chips align across both columns, with their
    // source-cited CVSS / KEV / EPSS payload available on expansion.
    const primaryCve = getByTestId("compare-primary-cve").textContent ?? "";
    expect(primaryCve).toContain("CVE-2024-3400");
    expect(primaryCve).toContain("CVSS 9.8");
    expect(primaryCve).toContain("[NVD]");
    expect(primaryCve).toContain("KEV");
    expect(primaryCve).toContain("[CISA]");
    expect(primaryCve).toContain("EPSS 0.94");
    expect(primaryCve).toContain("[FIRST]");
    expect(getByTestId("compare-compare-cve").textContent).toContain(
      "CVE-2023-44487",
    );
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

  it("renders NO CVE row at all when both columns are feature-not-active (cveStatus null)", () => {
    // RFC 0005 (i): a pre-#498 / `cve_status NULL` event must leak no CVE
    // surface in compare mode either — not even a `—` placeholder.
    const primaryInactive = {
      ...primary,
      cveRefs: [],
      cveStatus: null,
    };
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
        ttpTags: [],
        cveRefs: [],
        cveStatus: null,
        analysisText: "Compared narrative.",
      },
    };
    const { queryByTestId } = render(
      <EventCompareView
        primary={primaryInactive}
        compare={compare}
        compareTargetLabel="Claude 3.5"
        regenerateCta={<div data-testid="cta" />}
        t={t}
      />,
    );
    expect(queryByTestId("compare-primary-cve")).toBeNull();
    expect(queryByTestId("compare-compare-cve")).toBeNull();
    // No `—` leaks: the heading text must be the only place cveRefs appears,
    // and even that is omitted — the whole row is gone.
    expect(document.body.textContent).not.toContain("common.cveRefs");
  });

  it("renders the degraded could-not-verify state for a zero-CVE column whose check was degraded", () => {
    // RFC 0005 (iii): a live-but-degraded (`unknown`/`stale`) zero-CVE
    // column must show "could not verify", never a blank that reads as
    // "checked, none apply" — distinct from the feature-not-active absence.
    const primaryDegraded = {
      ...primary,
      cveRefs: [],
      cveStatus: "unknown" as const,
    };
    const compare: EventCompareOutcome = {
      kind: "not_generated",
      modelName: "x",
      model: "y",
    };
    const { getByTestId, queryByTestId } = render(
      <EventCompareView
        primary={primaryDegraded}
        compare={compare}
        compareTargetLabel="Claude 3.5"
        regenerateCta={null}
        t={t}
      />,
    );
    const cell = getByTestId("compare-primary-cve");
    expect(cell.getAttribute("data-cve-state")).toBe("could_not_verify");
    expect(cell.textContent).toContain("cve.couldNotVerifyBadge");
    // The single-column compare has no compare column to render.
    expect(queryByTestId("compare-compare-cve")).toBeNull();
  });

  it("keeps the heading and renders one column when the other is feature-not-active", () => {
    // Mixed: primary has validated chips, compare's CVE path did not run.
    // The shared heading shows (primary has a surface); the compare cell is
    // a fully absent (null) surface — no `—`.
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
        ttpTags: [],
        cveRefs: [],
        cveStatus: null,
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
    expect(getByTestId("compare-primary-cve").textContent).toContain(
      "CVE-2024-3400",
    );
    // Compare column's CVE path did not run → no surface, not a `—`. The
    // column still holds an empty grid cell so the primary chip cell stays
    // anchored in the left/primary column.
    expect(queryByTestId("compare-compare-cve")).toBeNull();
    expect(queryByTestId("compare-compare-cve-empty")).toBeTruthy();
  });

  it("keeps each CVE cell in its own column when the primary column is surfaceless", () => {
    // Inverse mixed case: the primary variant's CVE path did not run while the
    // compare variant has validated chips. Without an explicit empty cell for
    // the surfaceless primary column, the grid would collapse it and the
    // compare chip cell would slide into the left/primary slot, misattributing
    // the compared model's CVE state to the primary model.
    const primaryAbsent = {
      ...primary,
      cveRefs: [],
      cveStatus: null,
    };
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
        ttpTags: [],
        cveRefs: [
          {
            cve: "CVE-2023-44487",
            cvss: { score: 7.5, source: "nvd" },
            kev: { knownExploited: true, source: "kev" },
            epss: { score: 0.86, percentile: 0.99, source: "epss" },
            summary: "HTTP/2 Rapid Reset",
            inTheWild: true,
            sources: ["nvd", "kev", "epss"],
          },
        ],
        cveStatus: "complete",
        analysisText: "Compared narrative.",
      },
    };
    const { getByTestId, queryByTestId } = render(
      <EventCompareView
        primary={primaryAbsent}
        compare={compare}
        compareTargetLabel="Claude 3.5"
        regenerateCta={<div data-testid="cta" />}
        t={t}
      />,
    );
    // Primary column's CVE path did not run → an empty placeholder, not chips.
    const primaryEmpty = getByTestId("compare-primary-cve-empty");
    expect(queryByTestId("compare-primary-cve")).toBeNull();
    // Compare column keeps its chips.
    const compareCell = getByTestId("compare-compare-cve");
    expect(compareCell.textContent).toContain("CVE-2023-44487");
    // The empty primary cell precedes the compare cell within the shared grid,
    // so the compare chips render in the right/compare column — not the left.
    const grid = primaryEmpty.parentElement;
    expect(grid).not.toBeNull();
    expect(compareCell.parentElement).toBe(grid);
    const children = grid ? Array.from(grid.children) : [];
    expect(children.indexOf(primaryEmpty)).toBe(0);
    expect(children.indexOf(compareCell)).toBe(1);
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
