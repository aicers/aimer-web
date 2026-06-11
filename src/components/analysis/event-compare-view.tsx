// Analyst-only side-by-side event comparison (#464). Renders the currently
// open variant (primary column) against a second stored model variant (compare
// column): analysis text, severity/likelihood scores + factors, TTP tags,
// priority tier, and per-column provenance — each aligned across the two
// columns. On mobile the columns stack. When the compare variant has not been
// generated, a notice + regenerate CTA is shown instead of a second column —
// entering compare mode must NEVER auto-generate.
//
// Mirrors `story-compare-view.tsx` but additionally aligns TTP tags and the
// priority tier (the event surface carries both per variant). An event analysis
// is self-contained (it re-uses the same stored redacted event across models),
// so — like the story view and UNLIKE the report view — there is no
// leaf-coverage caveat to render here (#379 does not apply).

import type { useTranslations } from "next-intl";
import { AnalysisBody } from "@/components/analysis-body";
import type { PriorityTier } from "@/lib/analysis/priority-tier";
import type { EventCompareOutcome } from "@/lib/analysis/result-page-loader";

type AnalysisTranslations = ReturnType<typeof useTranslations<"analysis">>;

interface EventColumn {
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
  ttpTags: Array<{ id: string; name: string | null }>;
  analysisText: string;
}

const TIER_CLASSES: Record<PriorityTier, string> = {
  CRITICAL: "border-rose-500 bg-rose-100 text-rose-900",
  HIGH: "border-orange-400 bg-orange-100 text-orange-900",
  MEDIUM: "border-amber-300 bg-amber-50 text-amber-900",
  LOW: "border-slate-300 bg-slate-50 text-slate-700",
};

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

function TierCell({ tier, testid }: { tier: PriorityTier; testid: string }) {
  return (
    <div data-testid={testid}>
      <span
        data-tier={tier}
        className={`inline-flex items-center rounded-full border px-2 py-0.5 text-xs font-semibold ${TIER_CLASSES[tier]}`}
      >
        {tier}
      </span>
    </div>
  );
}

function TtpCell({
  tags,
  ariaLabel,
  testid,
}: {
  tags: ReadonlyArray<{ id: string; name: string | null }>;
  ariaLabel: string;
  testid: string;
}) {
  if (tags.length === 0)
    return (
      <div className="text-sm" data-testid={testid}>
        —
      </div>
    );
  return (
    <ul
      aria-label={ariaLabel}
      data-testid={testid}
      className="flex flex-wrap gap-1"
    >
      {tags.map((tag) => (
        <li
          key={tag.id}
          title={tag.name ?? undefined}
          data-tag-id={tag.id}
          className="inline-flex items-center rounded-full border border-indigo-300 bg-indigo-50 px-2 py-0.5 text-xs font-medium text-indigo-900"
        >
          {tag.id}
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
  col: EventColumn;
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

export function EventCompareView({
  primary,
  compare,
  compareTargetLabel,
  regenerateCta,
  t,
}: {
  primary: EventColumn;
  compare: EventCompareOutcome;
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
            {t("compare.notGeneratedEvent", { model: compareTargetLabel })}
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
          {t("fields.priorityTier")}
        </h3>
        <div className={grid}>
          <TierCell tier={primary.priorityTier} testid="compare-primary-tier" />
          {compareData ? (
            <TierCell
              tier={compareData.priorityTier}
              testid="compare-compare-tier"
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

      <div className="mt-6">
        <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          {t("common.ttpTags")}
        </h3>
        <div className={grid}>
          <TtpCell
            tags={primary.ttpTags}
            ariaLabel={t("common.ttpTags")}
            testid="compare-primary-ttp"
          />
          {compareData ? (
            <TtpCell
              tags={compareData.ttpTags}
              ariaLabel={t("common.ttpTags")}
              testid="compare-compare-ttp"
            />
          ) : null}
        </div>
      </div>
    </section>
  );
}
