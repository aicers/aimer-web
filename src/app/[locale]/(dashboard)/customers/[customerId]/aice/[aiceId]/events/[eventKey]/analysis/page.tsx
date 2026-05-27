import { notFound } from "next/navigation";
import type { PriorityTier } from "@/lib/analysis/priority-tier";
import { loadAnalysisResultPage } from "@/lib/analysis/result-page-loader";

interface PageProps {
  params: Promise<{
    locale: string;
    customerId: string;
    aiceId: string;
    eventKey: string;
  }>;
  searchParams: Promise<{
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

  const outcome = await loadAnalysisResultPage({
    customerId,
    aiceId,
    eventKey,
    lang,
    modelName,
    model,
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

  const data = outcome.data;
  const requestedAt = data.requestedAt.toISOString();

  return (
    <div className="mx-auto max-w-4xl px-4 py-8 sm:px-6">
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
          <PriorityBadge tier={data.priorityTier} />
        </Field>
        <Field label="Severity score (if real, how bad)">
          {data.severityScore.toFixed(3)}
        </Field>
        <Field label="Likelihood score (is it real)">
          {data.likelihoodScore.toFixed(3)}
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
        <Field label="Requested at">{requestedAt}</Field>
      </section>

      <section className="mt-8">
        <h2 className="mb-2 text-sm font-semibold uppercase tracking-wide text-muted-foreground">
          Analysis
        </h2>
        <AnalysisBody text={data.analysisText} />
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

const UNVERIFIED_RE = /(<<UNVERIFIED_(?:IP|EMAIL|MAC)_\d+>>)/g;

function AnalysisBody({ text }: { text: string }) {
  // Split on `<<UNVERIFIED_*>>` markers so we can render them with a
  // separate visual treatment (RFC 0001 §"UI — analysis result page").
  // Original `<<REDACTED_*>>` tokens have already been substituted
  // back to their entity values by the loader; nothing else needs
  // special handling here.
  const parts = text.split(UNVERIFIED_RE);
  return (
    <div
      data-testid="analysis-body"
      className="whitespace-pre-wrap rounded border border-border bg-card px-4 py-3 text-sm text-foreground"
    >
      {parts.map((part, idx) =>
        UNVERIFIED_RE.test(part) ? (
          <span
            // biome-ignore lint/suspicious/noArrayIndexKey: stable split-order index
            key={`u-${idx}`}
            data-testid="unverified-marker"
            title="Entity emitted by the LLM but not present in the original event"
            className="inline-flex items-center rounded-full border border-rose-400 bg-rose-50 px-2 py-0.5 text-xs font-medium text-rose-700"
          >
            {part}
          </span>
        ) : (
          // biome-ignore lint/suspicious/noArrayIndexKey: stable split-order index
          <span key={`t-${idx}`}>{part}</span>
        ),
      )}
    </div>
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
