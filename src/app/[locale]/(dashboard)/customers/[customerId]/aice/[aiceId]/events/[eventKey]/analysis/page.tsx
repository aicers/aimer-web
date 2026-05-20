import { notFound } from "next/navigation";
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
        <Field label="Threat score">{data.threatScore.toFixed(3)}</Field>
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
          <ForceRerunButton />
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

function ForceRerunButton() {
  // Force re-run requires `event_data`, which only aice-web-next holds
  // (RFC 0001 §"Force re-run button gating"). Open aice-web-next back
  // at the original event detail so the user can click
  // Send-to-aimer with `force=true` from there.
  //
  // The aice-web-next origin is configured at deploy time; missing
  // config renders the button as disabled so the page stays useful.
  const target = process.env.AICE_WEB_NEXT_ORIGIN ?? "";
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
