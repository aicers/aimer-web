import { notFound } from "next/navigation";
import type { PriorityTier } from "@/lib/analysis/priority-tier";
import { loadStoryResultPage } from "@/lib/analysis/story-result-page-loader";
import { StoryRegenerateButton } from "./regenerate-button";

interface PageProps {
  params: Promise<{
    locale: string;
    customerId: string;
    storyId: string;
  }>;
}

export default async function StoryAnalysisPage({ params }: PageProps) {
  const { customerId, storyId } = await params;

  const outcome = await loadStoryResultPage({ customerId, storyId });

  if (outcome.kind === "unauthorized") {
    // Indistinguishable 404 prevents probing of registered stories.
    notFound();
  }
  if (outcome.kind === "not_found") {
    notFound();
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
  const requestedAt = data.requestedAt.toISOString();

  return (
    <div className="mx-auto max-w-4xl px-4 py-8 sm:px-6">
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
          <FactorChipRow
            factors={data.severityFactors}
            ariaLabel="severity-factors"
          />
        </Field>
        <Field label="Likelihood score (is it real)">
          <div>{data.likelihoodScore.toFixed(3)}</div>
          <FactorChipRow
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
        <Field label="Requested at">{requestedAt}</Field>
      </section>

      <section className="mt-8">
        <h2 className="mb-2 text-sm font-semibold uppercase tracking-wide text-muted-foreground">
          Analysis
        </h2>
        <div
          data-testid="analysis-body"
          className="whitespace-pre-wrap rounded border border-border bg-card px-4 py-3 text-sm text-foreground"
        >
          {data.analysisText}
        </div>
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
