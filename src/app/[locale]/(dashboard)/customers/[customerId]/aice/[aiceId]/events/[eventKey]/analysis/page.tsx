import { notFound } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { AnalysisBody } from "@/components/analysis-body";
import { BreadcrumbLabelRegistrar } from "@/components/breadcrumb-label-store";
import { Timestamp } from "@/components/timestamp";
import type { PriorityTier } from "@/lib/analysis/priority-tier";
import { loadAnalysisResultPage } from "@/lib/analysis/result-page-loader";
import { entityCrumbLabel } from "@/lib/navigation/breadcrumb-labels";

interface PageProps {
  params: Promise<{
    locale: string;
    customerId: string;
    aiceId: string;
    eventKey: string;
  }>;
  searchParams: Promise<{
    generation?: string;
    lang?: string;
    model_name?: string;
    model?: string;
  }>;
}

const SUPPORTED_LANGS = new Set(["KOREAN", "ENGLISH"]);

export default async function AnalysisResultPage({
  params,
  searchParams,
}: PageProps) {
  const { customerId, aiceId, eventKey } = await params;
  const search = await searchParams;
  const lang = search.lang ?? "ENGLISH";
  const modelName = search.model_name ?? "";
  const model = search.model ?? "";

  // Required query params are part of the storage PK. A missing piece
  // makes the request unresolvable — 404 instead of guessing.
  if (!SUPPORTED_LANGS.has(lang) || !modelName || !model) {
    notFound();
  }

  // Optional generation pin (T1 Sources link). A present-but-invalid value
  // 404s rather than silently resolving the latest generation (parent #386
  // generation-pin contract).
  let generation: number | undefined;
  if (search.generation !== undefined) {
    const n = Number(search.generation);
    if (!Number.isInteger(n) || n <= 0) {
      notFound();
    }
    generation = n;
  }

  const outcome = await loadAnalysisResultPage({
    customerId,
    aiceId,
    eventKey,
    lang,
    modelName,
    model,
    generation,
  });

  if (outcome.kind === "unauthorized") {
    // Per RFC 0001's `authorization_failed` semantics, an
    // indistinguishable 404 prevents probing of registered customers
    // / events.
    notFound();
  }
  if (outcome.kind === "not_found") {
    notFound();
  }
  if (outcome.kind === "pin_unavailable") {
    return (
      <div className="mx-auto max-w-4xl px-4 py-8 sm:px-6">
        <header className="mb-6">
          <h1 className="text-2xl font-bold text-foreground">AI Analysis</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Event {eventKey} • {aiceId} • generation {outcome.generation}
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

  const data = outcome.data;
  const t = await getTranslations("nav");

  return (
    <div className="mx-auto max-w-4xl px-4 py-8 sm:px-6">
      {/* Feed the breadcrumb its leaf label from already-loaded data
          (no client refetch); `<Breadcrumbs />` falls back to the same
          terminology + short-key format if this never registers (#393). */}
      <BreadcrumbLabelRegistrar
        label={entityCrumbLabel(t("event"), data.eventKey)}
      />
      <header className="mb-6">
        <h1 className="text-2xl font-bold text-foreground">AI Analysis</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Event {data.eventKey} • {data.aiceId}
        </p>
      </header>

      {!data.sourceEventPresent ? (
        <div
          role="status"
          aria-label="retention-banner"
          className="mb-6 rounded border border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-900"
        >
          Source event removed by retention; analysis result preserved.
        </div>
      ) : null}

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
        {data.modelActualVersion ? (
          <Field label="Model snapshot">{data.modelActualVersion}</Field>
        ) : null}
        {data.promptVersion ? (
          <Field label="Prompt version">{data.promptVersion}</Field>
        ) : null}
        <Field label="Requested by">{data.requestedBy}</Field>
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

      {data.sourceEventPresent ? (
        <section className="mt-8">
          <ForceRerunButton aiceId={data.aiceId} eventKey={data.eventKey} />
        </section>
      ) : null}
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
          // `title` surfaces the MITRE technique name on hover. When the
          // ID isn't in the currently vendored bundle (`name === null`),
          // we omit the tooltip rather than rendering an empty one.
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

function ForceRerunButton({
  aiceId,
  eventKey,
}: {
  aiceId: string;
  eventKey: string;
}) {
  // Force re-run requires `event_data`, which only aice-web-next holds
  // (RFC 0001 §"Force re-run button gating"). Open aice-web-next back
  // at the original event detail so the user can click
  // Send-to-aimer with `force=true` from there.
  //
  // `aimerForce=1` is the cross-repo caller contract from
  // aicers/aice-web-next#629: aice-web-next reads this param on the
  // event-detail route and, on the next Send/Analyze click, sends
  // `force=true` once to `/api/analysis/analyze`. Without this
  // signal the click would just open the cached analysis again.
  //
  // The aice-web-next origin is configured at deploy time; missing
  // config renders the button as disabled so the page stays useful.
  const origin = process.env.AICE_WEB_NEXT_ORIGIN ?? "";
  let target = "";
  if (origin !== "") {
    const params = new URLSearchParams({
      aice_id: aiceId,
      aimerForce: "1",
    });
    target = `${origin.replace(/\/$/, "")}/events/${encodeURIComponent(
      eventKey,
    )}?${params.toString()}`;
  }
  return (
    <a
      data-testid="force-rerun-link"
      href={target || "#"}
      target="_blank"
      rel="noopener noreferrer"
      className="inline-flex items-center rounded border border-border bg-card px-3 py-2 text-sm font-medium text-foreground hover:bg-muted"
      aria-disabled={target === "" ? "true" : undefined}
    >
      Force re-run in aice-web-next
    </a>
  );
}
