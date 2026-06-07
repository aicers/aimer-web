// Analyst-only side-by-side report comparison (#458). Renders the currently
// open variant (primary column) against a second stored model variant
// (compare column), aligned section by section across the five report
// sections. On mobile the two columns stack vertically. When the compare
// variant has not been generated, a notice + regenerate CTA is shown instead
// of a second column — entering compare mode must NEVER auto-generate.
//
// Synchronous presentational server component: the `analysis` translator is
// resolved by the (server-component) caller and passed in, matching
// `CitedReportSection`.

import type { useTranslations } from "next-intl";
import { AnalysisBody } from "@/components/analysis-body";
import type {
  CitationUnit,
  ReportCompareOutcome,
  ReportSections,
} from "@/lib/analysis/report-result-page-loader";

type AnalysisTranslations = ReturnType<typeof useTranslations<"analysis">>;

// Flatten leaf-derived citation units to a plain Markdown block for the
// comparison (the per-sentence citation links are a single-variant affordance;
// compare mode is about narrative content across models).
function unitsText(units: CitationUnit[]): string {
  return units.map((u) => u.text).join("\n\n");
}

interface ProvenanceColumn {
  modelName: string;
  model: string;
  modelActualVersion: string;
  promptVersion: string;
  generation: number;
}

function Provenance({
  col,
  heading,
  t,
}: {
  col: ProvenanceColumn;
  heading: string;
  t: AnalysisTranslations;
}) {
  return (
    <div className="rounded border border-border bg-muted/40 p-3 text-xs text-muted-foreground">
      <div className="mb-1 text-[0.7rem] font-semibold uppercase tracking-wide text-foreground">
        {heading}
      </div>
      <div>
        {t("fields.model")}: {col.modelName} / {col.model}
      </div>
      <div>
        {t("fields.modelSnapshot")}: {col.modelActualVersion}
      </div>
      <div>
        {t("fields.promptVersion")}: {col.promptVersion}
      </div>
      <div>{t("common.generation", { generation: col.generation })}</div>
    </div>
  );
}

export function ReportCompareView({
  primary,
  primaryLabel,
  compare,
  compareTargetLabel,
  defaultModel,
  regenerateCta,
  t,
}: {
  primary: ProvenanceColumn & { sections: ReportSections };
  /** Display label for the primary (currently-open) model. */
  primaryLabel: string;
  compare: ReportCompareOutcome;
  /** Display label for the compare-target model (for the not-generated copy). */
  compareTargetLabel: string;
  /** The configured default `(modelName, model)`; the #379 note applies only
   *  to displayed columns whose model is NOT this pair. */
  defaultModel: { modelName: string; model: string };
  /** Regenerate CTA shown when the compare variant is not generated. */
  regenerateCta: React.ReactNode;
  t: AnalysisTranslations;
}) {
  const hasCompare = compare.kind === "ok";
  const compareData = compare.kind === "ok" ? compare.data : null;

  const sectionDefs: Array<{ key: keyof ReportSections; title: string }> = [
    {
      key: "executive_summary",
      title: t("reportDetail.sectionExecutiveSummary"),
    },
    {
      key: "story_highlights",
      title: t("reportDetail.sectionStoryHighlights"),
    },
    { key: "notable_events", title: t("reportDetail.sectionNotableEvents") },
    {
      key: "baseline_observations",
      title: t("reportDetail.sectionSuspiciousEventTrends"),
    },
    { key: "period_outlook", title: t("reportDetail.sectionPeriodOutlook") },
  ];

  const sectionString = (
    s: ReportSections,
    key: keyof ReportSections,
  ): string => {
    const v = s[key];
    return Array.isArray(v) ? unitsText(v) : v;
  };

  // #379: a non-default-model report aggregates only same-model leaves, so
  // `story_highlights` / `notable_events` can be empty until the underlying
  // leaves are re-analyzed under that model. The caveat is specific to
  // NON-default columns, and EITHER displayed column can be the non-default
  // one (the primary is the currently-open variant, which may itself be a
  // non-default model). So drive the note off any displayed non-default column
  // with an empty leaf-derived section — not the compare column alone, and not
  // a default column that merely happens to have an empty section.
  const isDefaultModel = (col: { modelName: string; model: string }): boolean =>
    col.modelName === defaultModel.modelName &&
    col.model === defaultModel.model;
  const hasEmptyLeafSection = (s: ReportSections): boolean =>
    sectionString(s, "story_highlights").length === 0 ||
    sectionString(s, "notable_events").length === 0;
  const incompleteModels: string[] = [];
  if (!isDefaultModel(primary) && hasEmptyLeafSection(primary.sections)) {
    incompleteModels.push(primaryLabel);
  }
  if (
    compareData !== null &&
    !isDefaultModel(compareData) &&
    hasEmptyLeafSection(compareData.sections)
  ) {
    incompleteModels.push(compareTargetLabel);
  }
  const leafCoverageIncomplete = incompleteModels.length > 0;

  return (
    <section className="mt-8" data-testid="compare-view">
      <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-muted-foreground">
        {t("compare.heading")}
      </h2>

      {compare.kind === "not_generated" ? (
        <div
          role="status"
          data-testid="compare-not-generated"
          className="mb-4 rounded border border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-900"
        >
          <p className="mb-3 font-medium">{t("compare.notGeneratedTitle")}</p>
          <p className="mb-3">
            {t("compare.notGeneratedReport", { model: compareTargetLabel })}
          </p>
          {regenerateCta}
        </div>
      ) : null}

      {leafCoverageIncomplete ? (
        <div
          role="note"
          data-testid="compare-leaf-coverage"
          className="mb-4 rounded border border-sky-300 bg-sky-50 px-4 py-3 text-sm text-sky-900"
        >
          {t("compare.leafCoverageNote", {
            model: incompleteModels.join(", "),
          })}
        </div>
      ) : null}

      <div
        className={`grid grid-cols-1 gap-4 ${hasCompare ? "sm:grid-cols-2" : ""}`}
      >
        <Provenance col={primary} heading={t("compare.columnCurrent")} t={t} />
        {compareData ? (
          <Provenance
            col={compareData}
            heading={t("compare.columnCompare")}
            t={t}
          />
        ) : null}
      </div>

      {sectionDefs.map(({ key, title }) => (
        <div className="mt-6" key={key} data-testid={`compare-section-${key}`}>
          <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            {title}
          </h3>
          <div
            className={`grid grid-cols-1 gap-4 ${hasCompare ? "sm:grid-cols-2" : ""}`}
          >
            <AnalysisBody
              text={sectionString(primary.sections, key)}
              testid={`compare-primary-${key}`}
              emptyFallback="—"
            />
            {compareData ? (
              <AnalysisBody
                text={sectionString(compareData.sections, key)}
                testid={`compare-compare-${key}`}
                emptyFallback="—"
              />
            ) : null}
          </div>
        </div>
      ))}
    </section>
  );
}
