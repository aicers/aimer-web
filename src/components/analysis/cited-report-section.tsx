// Per-unit (sentence-level) citation rendering for a report's leaf-derived
// sections (#449). Each render unit is a self-contained Markdown chunk; when
// the unit is grounded in exactly one input leaf, an inline citation link
// pins that leaf at the exact variant the report consumed (generation + lang
// + model), deepening the trust chain from "report → cited leaf list" (T1) to
// "sentence → its source". Uncited units render plain, with no dangling link.
//
// Only the three leaf-derived sections (`executive_summary`,
// `story_highlights`, `notable_events`) carry citation units;
// `period_outlook` / `baseline_observations` are not leaf-derived and render
// through the plain `AnalysisBody` path instead.

import Link from "next/link";
import type { useTranslations } from "next-intl";
import { AnalysisMarkdown } from "@/components/analysis-body";
import type { CitationUnit } from "@/lib/analysis/report-result-page-loader";
import { subjectPages } from "@/lib/navigation/routes";
import { pinQuery } from "./sources-panel";

// The `analysis`-namespace translator, resolved by the (server-component)
// caller and passed in so this presentational component stays synchronous.
type AnalysisTranslations = ReturnType<typeof useTranslations<"analysis">>;

export function CitedReportSection({
  title,
  units,
  locale,
  testid,
  t,
}: {
  title: string;
  units: CitationUnit[];
  locale: string;
  testid: string;
  t: AnalysisTranslations;
}) {
  return (
    <section className="mt-8">
      <h2 className="mb-2 text-sm font-semibold uppercase tracking-wide text-muted-foreground">
        {title}
      </h2>
      <div
        data-testid={testid}
        className="rounded border border-border bg-card px-4 py-3 text-sm text-foreground"
      >
        {units.length === 0
          ? "—"
          : units.map((unit, i) => (
              <CitedUnit
                // Units have no stable id; index is stable within a render of
                // an immutable section array.
                // biome-ignore lint/suspicious/noArrayIndexKey: stable order
                key={i}
                unit={unit}
                locale={locale}
                t={t}
              />
            ))}
      </div>
    </section>
  );
}

function CitedUnit({
  unit,
  locale,
  t,
}: {
  unit: CitationUnit;
  locale: string;
  t: AnalysisTranslations;
}) {
  return (
    <div data-testid="citation-unit" className="mb-2 last:mb-0">
      <AnalysisMarkdown
        text={unit.text}
        // The citation chip is woven into the END of the unit's Markdown flow
        // (inline after the final sentence) rather than rendered as a block
        // sibling below the paragraph (#449 review round 1).
        citation={
          unit.source ? (
            <CitationLink source={unit.source} locale={locale} t={t} />
          ) : undefined
        }
      />
    </div>
  );
}

function CitationLink({
  source,
  locale,
  t,
}: {
  source: NonNullable<CitationUnit["source"]>;
  locale: string;
  t: AnalysisTranslations;
}) {
  const query = pinQuery(source.variant);
  // Link to the OWNING MEMBER customer's leaf detail (#513), carried on the
  // source — for a group report the leaf lives in a member DB, not the group.
  const href =
    source.sourceType === "story"
      ? `${subjectPages.story(
          locale,
          source.customerId,
          encodeURIComponent(source.storyId),
        )}?${query}`
      : `${subjectPages.eventAnalysis(
          locale,
          source.customerId,
          encodeURIComponent(source.aiceId),
          encodeURIComponent(source.eventKey),
        )}?${query}`;
  const label =
    source.sourceType === "story"
      ? t("citations.storyLink", { storyId: source.storyId })
      : t("citations.eventLink", {
          aiceId: source.aiceId,
          eventKey: source.eventKey,
        });
  const testid =
    source.sourceType === "story"
      ? `citation-story-${source.storyId}`
      : `citation-event-${source.aiceId}-${source.eventKey}`;
  return (
    <Link
      href={href}
      data-testid={testid}
      aria-label={t("citations.ariaLabel")}
      className="ml-1 inline-flex items-center gap-0.5 rounded border border-border bg-muted px-1.5 py-0.5 align-middle text-xs font-medium text-muted-foreground transition-colors hover:border-foreground hover:text-foreground"
    >
      <span aria-hidden="true">↗</span>
      {label}
    </Link>
  );
}
