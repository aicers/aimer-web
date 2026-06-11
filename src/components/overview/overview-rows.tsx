// Presentational rows for the cross-customer overview surfaces (WS2, #391).
//
// Server components (no client hooks): each row builds the deep link into the
// single-customer detail page from the row's own columns. Trust guardrails
// (#386): report rows expose the priority TIER only — the numeric aggregate
// score that drives ordering is never displayed; story/event leaf rows MAY
// show their severity/likelihood scores.

import Link from "next/link";
import type { useTranslations } from "next-intl";
import { EventTitle } from "@/components/analysis/event-title";
import type {
  EventOverviewRow,
  FailedCustomer,
  ReportOverviewRow,
  StoryOverviewRow,
} from "@/lib/analysis/cross-customer-overview";
import type { PriorityTier } from "@/lib/analysis/priority-tier";
import { subjectPages } from "@/lib/navigation/routes";

type AnalysisTranslations = ReturnType<typeof useTranslations<"analysis">>;

const TIER_CLASSES: Record<PriorityTier, string> = {
  CRITICAL: "border-rose-500 bg-rose-100 text-rose-900",
  HIGH: "border-orange-400 bg-orange-100 text-orange-900",
  MEDIUM: "border-amber-300 bg-amber-50 text-amber-900",
  LOW: "border-slate-300 bg-slate-50 text-slate-700",
};

export function PriorityBadge({ tier }: { tier: PriorityTier }) {
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

function CustomerLabel({ name }: { name: string }) {
  return <span className="truncate text-xs text-muted-foreground">{name}</span>;
}

export function ReportRow({
  row,
  locale,
  periodLabels,
  nowLabel,
}: {
  row: ReportOverviewRow;
  locale: string;
  /** Translated period labels (`reportPeriod`), keyed by period. */
  periodLabels: Record<string, string>;
  /** Translated "now" label for the rolling LIVE bucket. */
  nowLabel: string;
}) {
  // Pin `?tz=<row.tz>` on every report link. The detail loader resolves tz as
  // "pinned ?tz → customer current-timezone snapshot → UTC"; without the pin
  // an old-tz bucket re-resolves to the customer's current tz and 404s after
  // a timezone change (same reason the single-customer index pins it).
  const href = `${subjectPages.report(
    locale,
    row.customerId,
    row.period,
    row.bucketDate,
  )}?tz=${encodeURIComponent(row.tz)}`;
  return (
    <Link
      href={href}
      data-testid="overview-report-row"
      data-customer-id={row.customerId}
      data-tz={row.tz}
      className="flex items-center justify-between gap-3 rounded border border-border bg-card px-4 py-3 transition-colors hover:border-foreground"
    >
      <div className="min-w-0">
        <div className="truncate text-sm font-medium text-foreground">
          {periodLabels[row.period] ?? row.period} •{" "}
          {row.period === "LIVE" ? nowLabel : row.bucketDate}
        </div>
        <CustomerLabel name={row.customerName} />
      </div>
      {/* Report rows: tier only — the aggregate score is not disclosed. */}
      <PriorityBadge tier={row.priorityTier} />
    </Link>
  );
}

export function StoryRow({
  row,
  locale,
  label,
  scoreLabel,
}: {
  row: StoryOverviewRow;
  locale: string;
  /** Translated row title (`Story {id}`). */
  label: string;
  /** Translated abbreviated severity/likelihood pair. */
  scoreLabel: string;
}) {
  // Story detail takes no variant params (it defaults from env).
  const href = subjectPages.story(locale, row.customerId, row.storyId);
  return (
    <Link
      href={href}
      data-testid="overview-story-row"
      data-customer-id={row.customerId}
      data-story-id={row.storyId}
      className="flex items-center justify-between gap-3 rounded border border-border bg-card px-4 py-3 transition-colors hover:border-foreground"
    >
      <div className="min-w-0">
        <div className="truncate text-sm font-medium text-foreground">
          {label}
        </div>
        <CustomerLabel name={row.customerName} />
      </div>
      <div className="flex shrink-0 items-center gap-2">
        <ScorePair label={scoreLabel} />
        <PriorityBadge tier={row.priorityTier} />
      </div>
    </Link>
  );
}

export function EventRow({
  row,
  locale,
  fallbackLabel,
  scoreLabel,
}: {
  row: EventOverviewRow;
  locale: string;
  /**
   * Static localized fallback (`Event` / `이벤트`) shown only when the row's
   * `eventTime` is absent; the title is otherwise `{time} · {kind}` (#552).
   */
  fallbackLabel: string;
  /** Translated abbreviated severity/likelihood pair. */
  scoreLabel: string;
}) {
  // The event detail page 404s without `model_name`/`model`, so carry the
  // canonical variant on the link (it only defaults `lang` to ENGLISH).
  const params = new URLSearchParams({
    lang: row.lang,
    model_name: row.modelName,
    model: row.model,
  });
  // `aice_id`/`event_key` are accepted as arbitrary non-empty strings at
  // ingest, so a `/`, `?`, or `%` would corrupt the path. Encode each dynamic
  // segment (matching `run-analyze-flow`'s URL builder).
  const aiceId = encodeURIComponent(row.aiceId);
  const eventKey = encodeURIComponent(row.eventKey);
  const href = `${subjectPages.eventAnalysis(
    locale,
    row.customerId,
    aiceId,
    eventKey,
  )}?${params.toString()}`;
  return (
    <Link
      href={href}
      data-testid="overview-event-row"
      data-customer-id={row.customerId}
      data-aice-id={row.aiceId}
      data-event-key={row.eventKey}
      className="flex items-center justify-between gap-3 rounded border border-border bg-card px-4 py-3 transition-colors hover:border-foreground"
    >
      <div className="min-w-0">
        <div className="truncate text-sm font-medium text-foreground">
          <EventTitle
            eventTime={row.eventTime}
            kind={row.kind}
            fallbackLabel={fallbackLabel}
          />
        </div>
        <div className="truncate text-xs text-muted-foreground">
          {row.aiceId} • {row.customerName}
        </div>
      </div>
      <div className="flex shrink-0 items-center gap-2">
        <ScorePair label={scoreLabel} />
        <PriorityBadge tier={row.priorityTier} />
      </div>
    </Link>
  );
}

function ScorePair({ label }: { label: string }) {
  return (
    <span className="hidden text-xs text-muted-foreground sm:inline">
      {label}
    </span>
  );
}

export function SurfaceEmptyState({
  label,
  testid,
}: {
  label: string;
  testid: string;
}) {
  return (
    <div
      role="status"
      data-testid={testid}
      className="rounded border border-border bg-card px-4 py-3 text-sm text-muted-foreground"
    >
      {label}
    </div>
  );
}

// Partial fan-out failure (#391): one unreachable customer DB must not zero
// the counts nor blank the page — surface which customer degraded instead.
// The `analysis` translator and active locale are injected by the
// (server-component) caller so this stays a synchronous presentational
// component while still owning the locale-aware customer-name list.
export function PartialFailureNotice({
  failed,
  locale,
  t,
}: {
  failed: FailedCustomer[];
  locale: string;
  t: AnalysisTranslations;
}) {
  if (failed.length === 0) return null;
  // Join the degraded customers per locale (e.g. EN "A and B", KO "A 및 B")
  // and feed the whole list into one ICU message via `{customers}` rather
  // than concatenating translated fragments around a fixed comma separator.
  const customers = new Intl.ListFormat(locale, {
    style: "long",
    type: "conjunction",
  }).format(failed.map((f) => f.name));
  return (
    <div
      role="alert"
      data-testid="overview-partial-failure"
      className="mb-4 rounded border border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-900"
    >
      {t.rich("overview.partialFailure", {
        customers,
        names: (chunks) => <span className="font-medium">{chunks}</span>,
      })}
    </div>
  );
}

// Route-level loading skeleton (#391). The overview surfaces fan out across
// potentially many customer DBs per request, so each route ships a
// `loading.tsx` that renders this while the server component awaits the
// aggregator — Next.js wraps the page in a Suspense boundary automatically.
export function OverviewSkeleton({
  rows = 5,
  loadingLabel,
}: {
  rows?: number;
  /** Localized accessible label for the busy region. */
  loadingLabel: string;
}) {
  return (
    <div
      className="mx-auto max-w-4xl px-4 py-8 sm:px-6"
      role="status"
      aria-label={loadingLabel}
      aria-busy="true"
      data-testid="overview-loading"
    >
      <div className="mb-6 h-8 w-48 animate-pulse rounded bg-muted" />
      <ul className="space-y-2">
        {Array.from({ length: rows }, (_, i) => (
          <li
            // biome-ignore lint/suspicious/noArrayIndexKey: static placeholder list
            key={i}
            className="flex items-center justify-between gap-3 rounded border border-border bg-card px-4 py-3"
          >
            <div className="min-w-0 flex-1 space-y-2">
              <div className="h-4 w-1/3 animate-pulse rounded bg-muted" />
              <div className="h-3 w-1/5 animate-pulse rounded bg-muted" />
            </div>
            <div className="h-5 w-16 animate-pulse rounded-full bg-muted" />
          </li>
        ))}
      </ul>
    </div>
  );
}

export function CountBadge({ count }: { count: number }) {
  return (
    <span
      data-testid="overview-count"
      data-count={count}
      className="inline-flex items-center rounded-full border border-border bg-muted px-2 py-0.5 text-xs font-medium text-foreground"
    >
      {count}
    </span>
  );
}
