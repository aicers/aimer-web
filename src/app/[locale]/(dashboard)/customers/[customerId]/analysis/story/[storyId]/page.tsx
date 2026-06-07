import Link from "next/link";
import { notFound } from "next/navigation";
import type { useTranslations } from "next-intl";
import { getTranslations } from "next-intl/server";
import { CitedByTrail } from "@/components/analysis/cited-by-trail";
import {
  COMPARE_MODEL_NAME_PARAM,
  COMPARE_MODEL_PARAM,
  CompareModelSelector,
} from "@/components/analysis/compare-model-selector";
import { StoryCompareView } from "@/components/analysis/story-compare-view";
import { AnalysisBody } from "@/components/analysis-body";
import { BreadcrumbLabelRegistrar } from "@/components/breadcrumb-label-store";
import { Timestamp } from "@/components/timestamp";
import { loadCitedByReports } from "@/lib/analysis/cited-by-loader";
import { getModelCatalog } from "@/lib/analysis/model-catalog";
import type { PriorityTier } from "@/lib/analysis/priority-tier";
import {
  loadStoryResultPage,
  type StoryMemberEvent,
} from "@/lib/analysis/story-result-page-loader";
import { entityCrumbLabel } from "@/lib/navigation/breadcrumb-labels";
import { StoryRegenerateButton } from "./regenerate-button";

type AnalysisTranslations = ReturnType<typeof useTranslations<"analysis">>;

interface PageProps {
  params: Promise<{
    locale: string;
    customerId: string;
    storyId: string;
  }>;
  searchParams?: Promise<{
    generation?: string;
    lang?: string;
    model_name?: string;
    model?: string;
    compareModelName?: string;
    compareModel?: string;
  }>;
}

// A pinned generation (T1 Sources link) must be a positive integer; any
// other present value is rejected with a 404 rather than silently resolving
// the latest generation (parent #386 generation-pin contract).
function parseGeneration(raw: string | undefined): number | null | "invalid" {
  if (raw === undefined) return null;
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0) return "invalid";
  return n;
}

export default async function StoryAnalysisPage({
  params,
  searchParams,
}: PageProps) {
  const { locale, customerId, storyId } = await params;
  const search = (await searchParams) ?? {};

  const generation = parseGeneration(search.generation);
  if (generation === "invalid") {
    notFound();
  }
  // The pin is keyed on the full variant; carry the cited `lang`/model
  // params (report-language enum) alongside the generation so the exact
  // cited leaf row resolves instead of the latest.
  const pin =
    generation !== null
      ? {
          generation,
          lang: search.lang,
          modelName: search.model_name,
          model: search.model,
        }
      : undefined;
  // Unpinned primary variant (#458): a `?model_name=&model=` link with no
  // `?generation` opens that model as the primary column (the compare view is
  // "currently-open variant vs compare variant", so the open model must be the
  // one the URL selected, not the env default). The loader prefers `pin` when a
  // generation is present, so only forward `variant` on the unpinned path.
  const variant =
    generation === null
      ? {
          lang: search.lang,
          modelName: search.model_name,
          model: search.model,
        }
      : undefined;

  // Analyst-only compare variant (#458): a second model rendered side by side.
  // The loader resolves it via a read-only unpinned model-only lookup and
  // gates it on the analyst flag, so a non-analyst's crafted params are
  // ignored. The shared compare query params map onto the story loader's
  // camelCase `compare` shape.
  const compareModelName = search[COMPARE_MODEL_NAME_PARAM];
  const compareModel = search[COMPARE_MODEL_PARAM];
  const compareInput =
    compareModelName && compareModel
      ? { modelName: compareModelName, model: compareModel }
      : undefined;

  const outcome = await loadStoryResultPage({
    customerId,
    storyId,
    pin,
    variant,
    compare: compareInput,
  });
  const tA = await getTranslations("analysis");

  if (outcome.kind === "unauthorized") {
    // Indistinguishable 404 prevents probing of registered stories.
    notFound();
  }
  if (outcome.kind === "not_found") {
    notFound();
  }
  if (outcome.kind === "pin_unavailable") {
    return (
      <div className="mx-auto max-w-4xl px-4 py-8 sm:px-6">
        <header className="mb-6">
          <h1 className="text-2xl font-bold text-foreground">
            {tA("storyDetail.title")}
          </h1>
          <p className="mt-1 text-sm text-muted-foreground">
            {tA("storyDetail.subtitle", {
              storyId,
              generation: outcome.generation,
            })}
          </p>
        </header>
        <div
          role="status"
          data-testid="pin-unavailable-banner"
          className="rounded border border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-900"
        >
          {tA("common.evidencePinUnavailable")}
        </div>
      </div>
    );
  }
  if (outcome.kind === "pending") {
    return (
      <div className="mx-auto max-w-4xl px-4 py-8 sm:px-6">
        <header className="mb-6">
          <h1 className="text-2xl font-bold text-foreground">
            {tA("storyDetail.title")}
          </h1>
          <p className="mt-1 text-sm text-muted-foreground">
            {tA("storyDetail.subtitlePlain", { storyId })}
          </p>
        </header>
        <div
          role="status"
          data-testid="pending-banner"
          className="rounded border border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-900"
        >
          {tA("storyDetail.pendingBanner", { status: outcome.stateStatus })}
        </div>
      </div>
    );
  }

  const data = outcome.data;
  const collapseFactors = data.priorityTier === "LOW";

  // Analyst-only model catalog (#458), read server-side and passed to the
  // client picker/compare controls as serializable props (the catalog module
  // is server-only). Gated on `canRegenerate` — the story regenerate gate from
  // #457 — because the catalog exposes model identities tied to the regenerate
  // picker, and the issue ties the catalog prop to the Regenerate button's gate
  // (so a bridge-session analyst, `isViewerAnalyst && !canRegenerate`, gets
  // none). The compare view itself + per-column provenance stay `isViewerAnalyst`
  // surfaces (gated in the loader), independent of the catalog.
  const catalog = data.canRegenerate ? getModelCatalog() : [];
  const currentModel = { modelName: data.modelName, model: data.model };
  const compareTarget =
    compareInput && data.isViewerAnalyst
      ? { modelName: compareInput.modelName, model: compareInput.model }
      : null;
  const compareTargetLabel = compareTarget
    ? (catalog.find(
        (m) =>
          m.modelName === compareTarget.modelName &&
          m.model === compareTarget.model,
      )?.label ?? `${compareTarget.modelName} / ${compareTarget.model}`)
    : "";

  const t = await getTranslations("nav");
  const tPeriod = await getTranslations("reportPeriod");
  const periodLabels: Record<string, string> = {
    LIVE: tPeriod("LIVE"),
    DAILY: tPeriod("DAILY"),
    WEEKLY: tPeriod("WEEKLY"),
    MONTHLY: tPeriod("MONTHLY"),
  };

  // Reverse trail: the report(s) that cite this story (T2 #396).
  // Permission-gated inside the loader; an empty trail renders nothing.
  const citedBy = await loadCitedByReports({
    customerId,
    leaf: {
      kind: "story",
      storyId: data.storyId,
      generation: data.generation,
      modelName: data.modelName,
      model: data.model,
    },
  });
  const memberVariantQuery = new URLSearchParams({
    lang: data.memberEventVariant.lang,
    model_name: data.memberEventVariant.modelName,
    model: data.memberEventVariant.model,
  }).toString();

  return (
    <div className="mx-auto max-w-4xl px-4 py-8 sm:px-6">
      {/* Feed the breadcrumb its leaf label from already-loaded data
          (no client refetch); `<Breadcrumbs />` falls back to the same
          terminology + short-id format if this never registers (#393). */}
      <BreadcrumbLabelRegistrar
        label={entityCrumbLabel(t("threatStory"), data.storyId)}
      />
      <header className="mb-6">
        <h1 className="text-2xl font-bold text-foreground">
          {tA("storyDetail.title")}
        </h1>
        <p className="mt-1 text-sm text-muted-foreground">
          {tA("storyDetail.subtitle", {
            storyId: data.storyId,
            generation: data.generation,
          })}
        </p>
      </header>

      <section className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <Field label={tA("fields.priorityTier")}>
          <div className="flex flex-wrap items-center gap-2">
            <PriorityBadge tier={data.priorityTier} />
            <TtpChipRow tags={data.ttpTags} ariaLabel={tA("common.ttpTags")} />
          </div>
        </Field>
        <Field label={tA("fields.severityScore")}>
          <div>{data.severityScore.toFixed(3)}</div>
          <CollapsibleFactors
            collapsed={collapseFactors}
            summaryLabel={tA("fields.showSeverityFactors")}
            factors={data.severityFactors}
            ariaLabel={tA("fields.severityFactors")}
            testId="severity-factors"
          />
        </Field>
        <Field label={tA("fields.likelihoodScore")}>
          <div>{data.likelihoodScore.toFixed(3)}</div>
          <CollapsibleFactors
            collapsed={collapseFactors}
            summaryLabel={tA("fields.showLikelihoodFactors")}
            factors={data.likelihoodFactors}
            ariaLabel={tA("fields.likelihoodFactors")}
            testId="likelihood-factors"
          />
        </Field>
        <Field label={tA("fields.language")}>{data.lang}</Field>
        {/* Model/prompt provenance is operator-facing detail about how the
            artifact was produced — restricted to analysts (#457). A
            non-analyst keeps every analytically-meaningful field above. */}
        {data.isViewerAnalyst ? (
          <>
            <Field label={tA("fields.provider")}>{data.modelName}</Field>
            <Field label={tA("fields.model")}>{data.model}</Field>
            <Field label={tA("fields.modelSnapshot")}>
              {data.modelActualVersion}
            </Field>
            <Field label={tA("fields.promptVersion")}>
              {data.promptVersion}
            </Field>
            <Field label={tA("fields.requestedBy")}>
              {data.requestedBy ?? tA("common.system")}
            </Field>
            <Field label={tA("fields.requestedAt")}>
              <Timestamp at={data.requestedAt} />
            </Field>
          </>
        ) : null}
      </section>

      {/* Analyst-only compare control (#458): pick a second model to render
          side by side. Needs at least one other catalog model to offer. */}
      {data.isViewerAnalyst && catalog.length > 1 ? (
        <div className="mt-6 flex justify-end">
          <CompareModelSelector
            models={catalog}
            currentModel={currentModel}
            activeCompare={compareTarget ?? undefined}
            labels={{
              selectLabel: tA("compare.selectLabel"),
              placeholder: tA("compare.selectPlaceholder"),
              exit: tA("compare.exit"),
            }}
          />
        </div>
      ) : null}

      {data.compare ? (
        /* Analyst-only side-by-side comparison (#458): the open variant vs a
           second stored model — analysis, scores, and factors per column. The
           regenerate CTA (shown when the compare variant is not generated)
           preselects the compare-target model and follows `canRegenerate`. */
        <StoryCompareView
          primary={{
            modelName: data.modelName,
            model: data.model,
            modelActualVersion: data.modelActualVersion,
            promptVersion: data.promptVersion,
            generation: data.generation,
            severityScore: data.severityScore,
            likelihoodScore: data.likelihoodScore,
            priorityTier: data.priorityTier,
            severityFactors: data.severityFactors,
            likelihoodFactors: data.likelihoodFactors,
            analysisText: data.analysisText,
          }}
          compare={data.compare}
          compareTargetLabel={compareTargetLabel}
          regenerateCta={
            data.canRegenerate ? (
              <StoryRegenerateButton
                customerId={data.customerId}
                storyId={data.storyId}
                variant={{
                  lang: data.lang,
                  modelName: data.modelName,
                  model: data.model,
                }}
                models={catalog}
                defaultModel={compareTarget ?? undefined}
              />
            ) : null
          }
          t={tA}
        />
      ) : (
        <section className="mt-8">
          <h2 className="mb-2 text-sm font-semibold uppercase tracking-wide text-muted-foreground">
            {tA("common.sectionAnalysis")}
          </h2>
          <AnalysisBody text={data.analysisText} testid="analysis-body" />
        </section>
      )}

      {/* Story → member suspicious events, in member-ordinal order, each
          linking down to the event detail page (T2 #396). */}
      <MemberEventsSection
        locale={locale}
        customerId={customerId}
        members={data.memberEvents}
        variantQuery={memberVariantQuery}
        t={tA}
      />

      {/* Reverse "Cited by" trail back up to the citing report(s). */}
      <CitedByTrail
        locale={locale}
        customerId={customerId}
        reports={citedBy}
        t={tA}
        periodLabels={periodLabels}
      />

      {/* Force-regenerate is an analyst-only WRITE action (the endpoint
          authorizes `analyses:configure` with `operationKind: "write"`). The
          story read loader allows bridge sessions, so gate on `canRegenerate`
          (analyst AND not a bridge session) rather than the analyst flag
          alone — otherwise a bridge-session analyst's click would 403 (#457). */}
      {data.canRegenerate ? (
        <section className="mt-8">
          <StoryRegenerateButton
            customerId={data.customerId}
            storyId={data.storyId}
            variant={{
              lang: data.lang,
              modelName: data.modelName,
              model: data.model,
            }}
            models={catalog}
          />
        </section>
      ) : null}
    </div>
  );
}

function MemberEventsSection({
  locale,
  customerId,
  members,
  variantQuery,
  t,
}: {
  locale: string;
  customerId: string;
  members: StoryMemberEvent[];
  variantQuery: string;
  t: AnalysisTranslations;
}) {
  if (members.length === 0) return null;
  return (
    <section className="mt-8" data-testid="member-events">
      <h2 className="mb-2 text-sm font-semibold uppercase tracking-wide text-muted-foreground">
        {t("storyDetail.memberEventsHeading")}
      </h2>
      <p className="mb-3 text-xs text-muted-foreground">
        {t("storyDetail.memberEventsDescription")}
      </p>
      <ul className="space-y-2">
        {members.map((m) => (
          <MemberEventCard
            key={`${m.aiceId}-${m.eventKey}`}
            locale={locale}
            customerId={customerId}
            member={m}
            variantQuery={variantQuery}
            t={t}
          />
        ))}
      </ul>
    </section>
  );
}

function MemberEventCard({
  locale,
  customerId,
  member,
  variantQuery,
  t,
}: {
  locale: string;
  customerId: string;
  member: StoryMemberEvent;
  variantQuery: string;
  t: AnalysisTranslations;
}) {
  const href = `/${locale}/customers/${customerId}/aice/${encodeURIComponent(
    member.aiceId,
  )}/events/${encodeURIComponent(member.eventKey)}/analysis?${variantQuery}`;
  return (
    <li>
      <Link
        href={href}
        data-testid={`member-event-${member.aiceId}-${member.eventKey}`}
        className="block rounded border border-border bg-card px-4 py-3 transition-colors hover:border-foreground"
      >
        <div className="flex items-center justify-between gap-3">
          <div className="min-w-0">
            <div className="truncate text-sm font-medium text-foreground">
              <span className="text-muted-foreground">#{member.index}</span>{" "}
              {t("storyDetail.memberEventLabel", {
                aiceId: member.aiceId,
                eventKey: member.eventKey,
              })}
            </div>
            {member.display ? (
              <div className="mt-0.5 text-xs text-muted-foreground">
                {t("common.severityLikelihood", {
                  severity: member.display.severityScore.toFixed(3),
                  likelihood: member.display.likelihoodScore.toFixed(3),
                })}
              </div>
            ) : (
              <div
                data-testid="member-event-unavailable"
                className="mt-0.5 text-xs text-muted-foreground"
              >
                {t("storyDetail.memberUnavailable")}
              </div>
            )}
          </div>
          {member.display ? (
            <MemberPriorityBadge tier={member.display.priorityTier} />
          ) : null}
        </div>
      </Link>
    </li>
  );
}

function MemberPriorityBadge({ tier }: { tier: PriorityTier }) {
  return (
    <span
      data-testid="member-priority-badge"
      data-tier={tier}
      className={`inline-flex shrink-0 items-center rounded-full border px-2 py-0.5 text-xs font-semibold ${TIER_CLASSES[tier]}`}
    >
      {tier}
    </span>
  );
}

function Field({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div>
      <div className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
        {label}
      </div>
      <div className="mt-1 text-sm text-foreground">{children}</div>
    </div>
  );
}

const TIER_CLASSES: Record<PriorityTier, string> = {
  CRITICAL: "border-rose-500 bg-rose-100 text-rose-900",
  HIGH: "border-orange-400 bg-orange-100 text-orange-900",
  MEDIUM: "border-amber-300 bg-amber-50 text-amber-900",
  LOW: "border-slate-300 bg-slate-50 text-slate-700",
};

function PriorityBadge({ tier }: { tier: PriorityTier }) {
  return (
    <span
      data-testid="priority-tier-badge"
      data-tier={tier}
      className={`inline-flex items-center rounded-full border px-2 py-0.5 text-xs font-semibold ${TIER_CLASSES[tier]}`}
    >
      {tier}
    </span>
  );
}

function CollapsibleFactors({
  collapsed,
  summaryLabel,
  factors,
  ariaLabel,
  testId,
}: {
  collapsed: boolean;
  summaryLabel: string;
  factors: readonly string[];
  ariaLabel: string;
  testId: string;
}) {
  if (factors.length === 0) return null;
  if (!collapsed) {
    return (
      <FactorChipRow factors={factors} ariaLabel={ariaLabel} testId={testId} />
    );
  }
  return (
    <details data-testid={`${testId}-details`} className="mt-2">
      <summary className="cursor-pointer text-xs text-muted-foreground">
        {summaryLabel}
      </summary>
      <FactorChipRow factors={factors} ariaLabel={ariaLabel} testId={testId} />
    </details>
  );
}

function FactorChipRow({
  factors,
  ariaLabel,
  testId,
}: {
  factors: readonly string[];
  ariaLabel: string;
  testId: string;
}) {
  if (factors.length === 0) return null;
  return (
    <ul
      aria-label={ariaLabel}
      data-testid={testId}
      className="mt-2 flex flex-wrap gap-1"
    >
      {factors.map((item) => (
        <li
          key={item}
          title={item}
          className="inline-flex items-center rounded-full border border-border bg-muted px-2 py-0.5 text-xs text-foreground"
        >
          {item}
        </li>
      ))}
    </ul>
  );
}

function TtpChipRow({
  tags,
  ariaLabel,
}: {
  tags: ReadonlyArray<{ id: string; name: string | null }>;
  ariaLabel: string;
}) {
  if (tags.length === 0) return null;
  return (
    <ul
      aria-label={ariaLabel}
      data-testid="ttp-tags"
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
