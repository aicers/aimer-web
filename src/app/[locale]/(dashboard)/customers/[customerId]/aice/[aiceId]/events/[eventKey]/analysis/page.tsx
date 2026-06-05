import Link from "next/link";
import { notFound } from "next/navigation";
import type { useTranslations } from "next-intl";
import { getTranslations } from "next-intl/server";
import { CitedByTrail } from "@/components/analysis/cited-by-trail";
import { AnalysisBody } from "@/components/analysis-body";
import { BreadcrumbLabelRegistrar } from "@/components/breadcrumb-label-store";
import { Timestamp } from "@/components/timestamp";
import { loadCitedByReports } from "@/lib/analysis/cited-by-loader";
import type { PriorityTier } from "@/lib/analysis/priority-tier";
import {
  type AnalysisResultPageData,
  loadAnalysisResultPage,
} from "@/lib/analysis/result-page-loader";
import { entityCrumbLabel } from "@/lib/navigation/breadcrumb-labels";

type AnalysisTranslations = ReturnType<typeof useTranslations<"analysis">>;

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
  const { locale, customerId, aiceId, eventKey } = await params;
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
  const tA = await getTranslations("analysis");
  if (outcome.kind === "pin_unavailable") {
    return (
      <div className="mx-auto max-w-4xl px-4 py-8 sm:px-6">
        <header className="mb-6">
          <h1 className="text-2xl font-bold text-foreground">
            {tA("eventAnalysis.title")}
          </h1>
          <p className="mt-1 text-sm text-muted-foreground">
            {tA("eventAnalysis.subtitlePinned", {
              eventKey,
              aiceId,
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

  const data = outcome.data;
  const t = await getTranslations("nav");
  const tPeriod = await getTranslations("reportPeriod");
  const periodLabels: Record<string, string> = {
    LIVE: tPeriod("LIVE"),
    DAILY: tPeriod("DAILY"),
    WEEKLY: tPeriod("WEEKLY"),
    MONTHLY: tPeriod("MONTHLY"),
  };

  // Reverse trail: the report(s) that cite this event (T2 #396).
  // Permission-gated inside the loader; an empty trail renders nothing.
  const citedBy = await loadCitedByReports({
    customerId,
    leaf: {
      kind: "event",
      aiceId: data.aiceId,
      eventKey: data.eventKey,
      generation: data.generation,
    },
  });

  return (
    <div className="mx-auto max-w-4xl px-4 py-8 sm:px-6">
      {/* Feed the breadcrumb its leaf label from already-loaded data
          (no client refetch); `<Breadcrumbs />` falls back to the same
          terminology + short-key format if this never registers (#393). */}
      <BreadcrumbLabelRegistrar
        label={entityCrumbLabel(t("event"), data.eventKey)}
      />
      <header className="mb-6">
        <h1 className="text-2xl font-bold text-foreground">
          {tA("eventAnalysis.title")}
        </h1>
        <p className="mt-1 text-sm text-muted-foreground">
          {tA("eventAnalysis.subtitle", {
            eventKey: data.eventKey,
            aiceId: data.aiceId,
          })}
        </p>
      </header>

      {!data.sourceEventPresent ? (
        <div
          role="status"
          data-testid="retention-banner"
          className="mb-6 rounded border border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-900"
        >
          {tA("eventAnalysis.retentionBanner")}
        </div>
      ) : null}

      {/* Upward backlink: the threat story / stories this event is part of
          (T2 #396). Nothing renders when the event is not a story member. */}
      <ParentStoryBacklink
        locale={locale}
        customerId={customerId}
        parentStories={data.parentStories}
        t={tA}
      />

      <section className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <Field label={tA("fields.priorityTier")}>
          <div className="flex flex-wrap items-center gap-2">
            <PriorityBadge tier={data.priorityTier} />
            <TtpChipRow tags={data.ttpTags} />
          </div>
        </Field>
        <Field label={tA("fields.severityScore")}>
          <div>{data.severityScore.toFixed(3)}</div>
          <FactorChipRow
            factors={data.severityFactors}
            ariaLabel="severity-factors"
          />
        </Field>
        <Field label={tA("fields.likelihoodScore")}>
          <div>{data.likelihoodScore.toFixed(3)}</div>
          <FactorChipRow
            factors={data.likelihoodFactors}
            ariaLabel="likelihood-factors"
          />
        </Field>
        <Field label={tA("fields.language")}>{data.lang}</Field>
        <Field label={tA("fields.provider")}>{data.modelName}</Field>
        <Field label={tA("fields.model")}>{data.model}</Field>
        {data.modelActualVersion ? (
          <Field label={tA("fields.modelSnapshot")}>
            {data.modelActualVersion}
          </Field>
        ) : null}
        {data.promptVersion ? (
          <Field label={tA("fields.promptVersion")}>{data.promptVersion}</Field>
        ) : null}
        <Field label={tA("fields.requestedBy")}>{data.requestedBy}</Field>
        <Field label={tA("fields.requestedAt")}>
          <Timestamp at={data.requestedAt} />
        </Field>
      </section>

      <section className="mt-8">
        <h2 className="mb-2 text-sm font-semibold uppercase tracking-wide text-muted-foreground">
          {tA("common.sectionAnalysis")}
        </h2>
        <AnalysisBody text={data.analysisText} testid="analysis-body" />
      </section>

      {/* Reverse "Cited by" trail back up to the citing report(s). */}
      <CitedByTrail
        locale={locale}
        customerId={customerId}
        reports={citedBy}
        t={tA}
        periodLabels={periodLabels}
      />

      {/* Bottom of the trust chain: the raw source event. aimer-web does
          not store raw event payloads, so the final hop links out to the
          aice-web-next source event — but ONLY when the source is still
          present. When retention has swept it (`sourceEventPresent`
          false) the chain ends gracefully at the preserved analysis (the
          retention banner above) instead of a dead link (parent #386). */}
      {data.sourceEventPresent ? (
        <section className="mt-8 flex flex-wrap gap-2">
          <RawEventHop
            aiceId={data.aiceId}
            eventKey={data.eventKey}
            label={tA("eventAnalysis.viewSourceEvent")}
          />
          <ForceRerunButton
            aiceId={data.aiceId}
            eventKey={data.eventKey}
            label={tA("eventAnalysis.forceRerun")}
          />
        </section>
      ) : null}
    </div>
  );
}

function ParentStoryBacklink({
  locale,
  customerId,
  parentStories,
  t,
}: {
  locale: string;
  customerId: string;
  parentStories: AnalysisResultPageData["parentStories"];
  t: AnalysisTranslations;
}) {
  if (parentStories.length === 0) return null;
  return (
    <section className="mb-6" data-testid="parent-stories">
      <h2 className="mb-2 text-sm font-semibold uppercase tracking-wide text-muted-foreground">
        {t("eventAnalysis.partOfThreat", { count: parentStories.length })}
      </h2>
      <ul className="flex flex-wrap gap-2">
        {parentStories.map((s) => (
          <li key={s.storyId}>
            <Link
              // Pin the generation whose membership actually contains this
              // event (T2 #396): the story page resolves the default
              // variant at this generation, so its member list lists the
              // event — not whatever the latest generation regrouped to.
              href={`/${locale}/customers/${customerId}/analysis/story/${encodeURIComponent(
                s.storyId,
              )}?generation=${s.generation}`}
              data-testid={`parent-story-${s.storyId}`}
              className="inline-flex items-center gap-2 rounded border border-border bg-card px-3 py-2 text-sm font-medium text-foreground transition-colors hover:border-foreground"
            >
              <span>
                {t("eventAnalysis.storyLabel", { storyId: s.storyId })}
              </span>
              <span
                data-tier={s.priorityTier}
                className={`inline-flex shrink-0 items-center rounded-full border px-2 py-0.5 text-xs font-semibold ${TIER_CLASSES[s.priorityTier]}`}
              >
                {s.priorityTier}
              </span>
            </Link>
          </li>
        ))}
      </ul>
    </section>
  );
}

// Drill-down to the raw source event. Mirrors the force-rerun button's
// origin handling: the aice-web-next origin is deploy-time config, so a
// missing origin renders the link disabled rather than broken. Unlike
// force-rerun this is a plain "view" hop — no `aimerForce` signal — so
// aice-web-next opens the source event read-only.
function RawEventHop({
  aiceId,
  eventKey,
  label,
}: {
  aiceId: string;
  eventKey: string;
  label: string;
}) {
  const origin = process.env.AICE_WEB_NEXT_ORIGIN ?? "";
  let target = "";
  if (origin !== "") {
    const params = new URLSearchParams({ aice_id: aiceId });
    target = `${origin.replace(/\/$/, "")}/events/${encodeURIComponent(
      eventKey,
    )}?${params.toString()}`;
  }
  return (
    <a
      data-testid="raw-event-link"
      href={target || "#"}
      target="_blank"
      rel="noopener noreferrer"
      className="inline-flex items-center rounded border border-border bg-card px-3 py-2 text-sm font-medium text-foreground hover:bg-muted"
      aria-disabled={target === "" ? "true" : undefined}
    >
      {label}
    </a>
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
  label,
}: {
  aiceId: string;
  eventKey: string;
  label: string;
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
      {label}
    </a>
  );
}
