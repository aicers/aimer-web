// Sources panel for the periodic report detail page (T1, #395).
//
// Renders the report-level cited story/event leaves the generation was
// built from, each as a card linking to its detail page pinned to the
// cited variant (`generation` + `lang` + `model_name` + `model`). The
// refs are a report-level input list — NOT a section/sentence-level
// citation map — so the panel is deliberately framed as "cited sources"
// and never implies per-claim provenance. It attaches only to the
// leaf-derived sections; `baseline_observations` (the drill-down's
// deliberate stopping point) gets no Sources panel.

import Link from "next/link";
import type { useTranslations } from "next-intl";
import type { PriorityTier } from "@/lib/analysis/priority-tier";
import type {
  CitedEventSource,
  CitedLeafVariant,
  CitedStorySource,
} from "@/lib/analysis/report-result-page-loader";
import { subjectPages } from "@/lib/navigation/routes";

// The `analysis`-namespace translator, resolved by the (server-component)
// caller and passed in so this presentational component stays synchronous.
type AnalysisTranslations = ReturnType<typeof useTranslations<"analysis">>;

const TIER_CLASSES: Record<PriorityTier, string> = {
  CRITICAL: "border-rose-500 bg-rose-100 text-rose-900",
  HIGH: "border-orange-400 bg-orange-100 text-orange-900",
  MEDIUM: "border-amber-300 bg-amber-50 text-amber-900",
  LOW: "border-slate-300 bg-slate-50 text-slate-700",
};

// Build the cited-variant query string for a leaf link. All four params
// are always carried so the leaf page pins the exact cited variant rather
// than resolving its latest generation (parent #386 generation-pin
// contract). Keys match what each leaf page parses (`model_name`/`model`).
// Exported so the per-unit sentence citations (#449) pin leaf links the same
// way without duplicating the contract.
export function pinQuery(variant: CitedLeafVariant): string {
  return new URLSearchParams({
    generation: String(variant.generation),
    lang: variant.lang,
    model_name: variant.modelName,
    model: variant.model,
  }).toString();
}

export function SourcesPanel({
  locale,
  sources,
  t,
}: {
  locale: string;
  sources: { stories: CitedStorySource[]; events: CitedEventSource[] };
  t: AnalysisTranslations;
}) {
  const storyCount = sources.stories.length;
  const eventCount = sources.events.length;
  if (storyCount === 0 && eventCount === 0) return null;

  return (
    <section className="mt-8" data-testid="sources-panel">
      <h2 className="mb-2 text-sm font-semibold uppercase tracking-wide text-muted-foreground">
        {t("sources.heading")}
      </h2>
      <p className="mb-1 text-xs text-muted-foreground">
        {t("sources.description")}
      </p>
      <p
        data-testid="sources-provenance"
        className="mb-3 text-xs font-medium text-foreground"
      >
        {t("sources.provenance", { storyCount, eventCount })}
      </p>
      <ul className="space-y-2">
        {sources.stories.map((s) => (
          <StorySourceCard
            key={`story-${s.customerId}-${s.storyId}-${s.variant.generation}`}
            locale={locale}
            source={s}
            t={t}
          />
        ))}
        {sources.events.map((e) => (
          <EventSourceCard
            key={`event-${e.customerId}-${e.aiceId}-${e.eventKey}-${e.variant.generation}`}
            locale={locale}
            source={e}
            t={t}
          />
        ))}
      </ul>
    </section>
  );
}

function StorySourceCard({
  locale,
  source,
  t,
}: {
  locale: string;
  source: CitedStorySource;
  t: AnalysisTranslations;
}) {
  // Link to the OWNING MEMBER customer's detail (#513), carried on the source —
  // not the report subject, which for a group is the group, not where the leaf
  // lives. Degrades to the report's own customer id for a single-customer report.
  const href = `${subjectPages.story(
    locale,
    source.customerId,
    encodeURIComponent(source.storyId),
  )}?${pinQuery(source.variant)}`;
  return (
    <li>
      <Link
        href={href}
        data-testid={`source-story-${source.storyId}`}
        className="block rounded border border-border bg-card px-4 py-3 transition-colors hover:border-foreground"
      >
        <div className="flex items-center justify-between gap-3">
          <div className="min-w-0">
            <div className="truncate text-sm font-medium text-foreground">
              {t("sources.storyLabel", { storyId: source.storyId })}
            </div>
            <div className="mt-0.5 text-xs text-muted-foreground">
              {t("common.generation", {
                generation: source.variant.generation,
              })}
              {source.display ? (
                <>
                  {" • "}
                  {t("sources.cardScores", {
                    severity: source.display.severityScore.toFixed(3),
                    likelihood: source.display.likelihoodScore.toFixed(3),
                  })}
                </>
              ) : null}
            </div>
            {source.display ? (
              <TtpChipRow tags={source.display.ttpTags} t={t} />
            ) : (
              <UnavailableNote t={t} />
            )}
          </div>
          {source.display ? (
            <PriorityBadge tier={source.display.priorityTier} />
          ) : null}
        </div>
      </Link>
    </li>
  );
}

function EventSourceCard({
  locale,
  source,
  t,
}: {
  locale: string;
  source: CitedEventSource;
  t: AnalysisTranslations;
}) {
  // Link to the owning member customer's event detail (#513) — see StorySourceCard.
  const href = `${subjectPages.eventAnalysis(
    locale,
    source.customerId,
    encodeURIComponent(source.aiceId),
    encodeURIComponent(source.eventKey),
  )}?${pinQuery(source.variant)}`;
  return (
    <li>
      <Link
        href={href}
        data-testid={`source-event-${source.aiceId}-${source.eventKey}`}
        className="block rounded border border-border bg-card px-4 py-3 transition-colors hover:border-foreground"
      >
        <div className="flex items-center justify-between gap-3">
          <div className="min-w-0">
            <div className="truncate text-sm font-medium text-foreground">
              {t("sources.eventLabel", {
                aiceId: source.aiceId,
                eventKey: source.eventKey,
              })}
            </div>
            <div className="mt-0.5 text-xs text-muted-foreground">
              {t("common.generation", {
                generation: source.variant.generation,
              })}
              {source.display ? (
                <>
                  {" • "}
                  {t("sources.cardScores", {
                    severity: source.display.severityScore.toFixed(3),
                    likelihood: source.display.likelihoodScore.toFixed(3),
                  })}
                </>
              ) : null}
            </div>
            {source.display ? null : <UnavailableNote t={t} />}
          </div>
          {source.display ? (
            <PriorityBadge tier={source.display.priorityTier} />
          ) : null}
        </div>
      </Link>
    </li>
  );
}

// Shown when the pinned leaf row is missing or superseded: the card keeps
// the stored ID + generation but cannot show display fields.
function UnavailableNote({ t }: { t: AnalysisTranslations }) {
  return (
    <div
      data-testid="source-unavailable"
      className="mt-1 text-xs text-muted-foreground"
    >
      {t("sources.unavailable")}
    </div>
  );
}

// Scoped testid (`source-priority-badge`, not `priority-tier-badge`) so it
// does not collide with the report page's own top-level tier badge.
function PriorityBadge({ tier }: { tier: PriorityTier }) {
  return (
    <span
      data-testid="source-priority-badge"
      data-tier={tier}
      className={`inline-flex shrink-0 items-center rounded-full border px-2 py-0.5 text-xs font-semibold ${TIER_CLASSES[tier]}`}
    >
      {tier}
    </span>
  );
}

function TtpChipRow({
  tags,
  t,
}: {
  tags: ReadonlyArray<{ id: string; name: string | null }>;
  t: AnalysisTranslations;
}) {
  if (tags.length === 0) return null;
  return (
    <ul
      aria-label={t("common.ttpTags")}
      data-testid="source-ttp-tags"
      className="mt-2 flex flex-wrap gap-1"
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
