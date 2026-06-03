import { notFound } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { AnalysisBody } from "@/components/analysis-body";
import { BreadcrumbLabelRegistrar } from "@/components/breadcrumb-label-store";
import { Timestamp } from "@/components/timestamp";
import type { PriorityTier } from "@/lib/analysis/priority-tier";
import { loadStoryResultPage } from "@/lib/analysis/story-result-page-loader";
import { entityCrumbLabel } from "@/lib/navigation/breadcrumb-labels";
import { StoryRegenerateButton } from "./regenerate-button";

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
  const { customerId, storyId } = await params;
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

  const outcome = await loadStoryResultPage({ customerId, storyId, pin });

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
          <h1 className="text-2xl font-bold text-foreground">Story Analysis</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Story {storyId} • generation {outcome.generation}
          </p>
        </header>
        <div
          role="status"
          aria-label="pin-unavailable-banner"
          className="rounded border border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-900"
        >
          This evidence version is no longer available. The cited generation has
          been superseded or removed.
        </div>
      </div>
    );
  }
  if (outcome.kind === "pending") {
    return (
      <div className="mx-auto max-w-4xl px-4 py-8 sm:px-6">
        <header className="mb-6">
          <h1 className="text-2xl font-bold text-foreground">Story Analysis</h1>
          <p className="mt-1 text-sm text-muted-foreground">Story {storyId}</p>
        </header>
        <div
          role="status"
          aria-label="pending-banner"
          className="rounded border border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-900"
        >
          Analysis is in progress (state: {outcome.stateStatus}). The page
          refreshes automatically once the result is ready.
        </div>
      </div>
    );
  }

  const data = outcome.data;
  const collapseFactors = data.priorityTier === "LOW";
  const t = await getTranslations("nav");

  return (
    <div className="mx-auto max-w-4xl px-4 py-8 sm:px-6">
      {/* Feed the breadcrumb its leaf label from already-loaded data
          (no client refetch); `<Breadcrumbs />` falls back to the same
          terminology + short-id format if this never registers (#393). */}
      <BreadcrumbLabelRegistrar
        label={entityCrumbLabel(t("threatStory"), data.storyId)}
      />
      <header className="mb-6">
        <h1 className="text-2xl font-bold text-foreground">Story Analysis</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Story {data.storyId} • generation {data.generation}
        </p>
      </header>

      <section className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <Field label="Priority tier">
          <div className="flex flex-wrap items-center gap-2">
            <PriorityBadge tier={data.priorityTier} />
            <TtpChipRow tags={data.ttpTags} />
          </div>
        </Field>
        <Field label="Severity score (if real, how bad)">
          <div>{data.severityScore.toFixed(3)}</div>
          <CollapsibleFactors
            collapsed={collapseFactors}
            summaryLabel="Show severity factors"
            factors={data.severityFactors}
            ariaLabel="severity-factors"
          />
        </Field>
        <Field label="Likelihood score (is it real)">
          <div>{data.likelihoodScore.toFixed(3)}</div>
          <CollapsibleFactors
            collapsed={collapseFactors}
            summaryLabel="Show likelihood factors"
            factors={data.likelihoodFactors}
            ariaLabel="likelihood-factors"
          />
        </Field>
        <Field label="Language">{data.lang}</Field>
        <Field label="Provider">{data.modelName}</Field>
        <Field label="Model">{data.model}</Field>
        <Field label="Model snapshot">{data.modelActualVersion}</Field>
        <Field label="Prompt version">{data.promptVersion}</Field>
        <Field label="Requested by">{data.requestedBy ?? "system"}</Field>
        <Field label="Requested at">
          <Timestamp at={data.requestedAt} />
        </Field>
      </section>

      <section className="mt-8">
        <h2 className="mb-2 text-sm font-semibold uppercase tracking-wide text-muted-foreground">
          Analysis
        </h2>
        <AnalysisBody text={data.analysisText} testid="analysis-body" />
      </section>

      <section className="mt-8">
        <StoryRegenerateButton
          customerId={data.customerId}
          storyId={data.storyId}
        />
      </section>
    </div>
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
}: {
  collapsed: boolean;
  summaryLabel: string;
  factors: readonly string[];
  ariaLabel: string;
}) {
  if (factors.length === 0) return null;
  if (!collapsed) {
    return <FactorChipRow factors={factors} ariaLabel={ariaLabel} />;
  }
  return (
    <details data-testid={`${ariaLabel}-details`} className="mt-2">
      <summary className="cursor-pointer text-xs text-muted-foreground">
        {summaryLabel}
      </summary>
      <FactorChipRow factors={factors} ariaLabel={ariaLabel} />
    </details>
  );
}

function FactorChipRow({
  factors,
  ariaLabel,
}: {
  factors: readonly string[];
  ariaLabel: string;
}) {
  if (factors.length === 0) return null;
  return (
    <ul
      aria-label={ariaLabel}
      data-testid={ariaLabel}
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
}: {
  tags: ReadonlyArray<{ id: string; name: string | null }>;
}) {
  if (tags.length === 0) return null;
  return (
    <ul
      aria-label="ttp-tags"
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
