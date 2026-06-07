// Analyst-only side-by-side story comparison (#458). Renders the currently
// open variant (primary column) against a second stored model variant
// (compare column): analysis text, scores, and severity/likelihood factors,
// each aligned across the two columns, plus per-column provenance. On mobile
// the columns stack. When the compare variant has not been generated, a notice
// + regenerate CTA is shown instead of a second column — entering compare mode
// must NEVER auto-generate. Unlike the report, story comparison has no
// leaf-coverage caveat (a story analyzes its own members).

import type { useTranslations } from "next-intl";
import { AnalysisBody } from "@/components/analysis-body";
import type { PriorityTier } from "@/lib/analysis/priority-tier";
import type { StoryCompareOutcome } from "@/lib/analysis/story-result-page-loader";

type AnalysisTranslations = ReturnType<typeof useTranslations<"analysis">>;

interface StoryColumn {
  modelName: string;
  model: string;
  modelActualVersion: string;
  promptVersion: string;
  generation: number;
  severityScore: number;
  likelihoodScore: number;
  priorityTier: PriorityTier;
  severityFactors: string[];
  likelihoodFactors: string[];
  analysisText: string;
}

function FactorList({
  factors,
  testid,
}: {
  factors: readonly string[];
  testid: string;
}) {
  if (factors.length === 0) return <div className="text-sm">—</div>;
  return (
    <ul className="flex flex-wrap gap-1" data-testid={testid}>
      {factors.map((f) => (
        <li
          key={f}
          title={f}
          className="inline-flex items-center rounded-full border border-border bg-muted px-2 py-0.5 text-xs text-foreground"
        >
          {f}
        </li>
      ))}
    </ul>
  );
}

function Provenance({
  col,
  heading,
  t,
}: {
  col: StoryColumn;
  heading: string;
  t: AnalysisTranslations;
}) {
  return (
    <div className="rounded border border-border bg-muted/40 p-3 text-xs text-muted-foreground">
      <div className="mb-1 text-[0.7rem] font-semibold uppercase tracking-wide text-foreground">
        {heading}
      </div>
      <div>
        {t("fields.provider")}: {col.modelName}
      </div>
      <div>
        {t("fields.model")}: {col.model}
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

export function StoryCompareView({
  primary,
  compare,
  compareTargetLabel,
  regenerateCta,
  t,
}: {
  primary: StoryColumn;
  compare: StoryCompareOutcome;
  compareTargetLabel: string;
  regenerateCta: React.ReactNode;
  t: AnalysisTranslations;
}) {
  const compareData = compare.kind === "ok" ? compare.data : null;
  const hasCompare = compareData !== null;
  const grid = `grid grid-cols-1 gap-4 ${hasCompare ? "sm:grid-cols-2" : ""}`;

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
            {t("compare.notGeneratedStory", { model: compareTargetLabel })}
          </p>
          {regenerateCta}
        </div>
      ) : null}

      <div className={grid}>
        <Provenance col={primary} heading={t("compare.columnCurrent")} t={t} />
        {compareData ? (
          <Provenance
            col={compareData}
            heading={t("compare.columnCompare")}
            t={t}
          />
        ) : null}
      </div>

      <div className="mt-6">
        <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          {t("common.sectionAnalysis")}
        </h3>
        <div className={grid}>
          <AnalysisBody
            text={primary.analysisText}
            testid="compare-primary-analysis"
            emptyFallback="—"
          />
          {compareData ? (
            <AnalysisBody
              text={compareData.analysisText}
              testid="compare-compare-analysis"
              emptyFallback="—"
            />
          ) : null}
        </div>
      </div>

      <div className="mt-6">
        <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          {t("fields.severityScore")}
        </h3>
        <div className={grid}>
          <ScoreCell
            score={primary.severityScore}
            factors={primary.severityFactors}
            testid="compare-primary-severity"
          />
          {compareData ? (
            <ScoreCell
              score={compareData.severityScore}
              factors={compareData.severityFactors}
              testid="compare-compare-severity"
            />
          ) : null}
        </div>
      </div>

      <div className="mt-6">
        <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          {t("fields.likelihoodScore")}
        </h3>
        <div className={grid}>
          <ScoreCell
            score={primary.likelihoodScore}
            factors={primary.likelihoodFactors}
            testid="compare-primary-likelihood"
          />
          {compareData ? (
            <ScoreCell
              score={compareData.likelihoodScore}
              factors={compareData.likelihoodFactors}
              testid="compare-compare-likelihood"
            />
          ) : null}
        </div>
      </div>
    </section>
  );
}

function ScoreCell({
  score,
  factors,
  testid,
}: {
  score: number;
  factors: string[];
  testid: string;
}) {
  return (
    <div data-testid={testid}>
      <div className="mb-1 text-sm font-medium text-foreground">
        {score.toFixed(3)}
      </div>
      <FactorList factors={factors} testid={`${testid}-factors`} />
    </div>
  );
}
