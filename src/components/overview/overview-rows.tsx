// Presentational rows for the cross-customer overview surfaces (WS2, #391).
//
// Server components (no client hooks): each row builds the deep link into the
// single-customer detail page from the row's own columns. Trust guardrails
// (#386): report rows expose the priority TIER only — the numeric aggregate
// score that drives ordering is never displayed; story/event leaf rows MAY
// show their severity/likelihood scores.

import Link from "next/link";
import type {
  EventOverviewRow,
  FailedCustomer,
  ReportOverviewRow,
  StoryOverviewRow,
} from "@/lib/analysis/cross-customer-overview";
import type { PriorityTier } from "@/lib/analysis/priority-tier";

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

const PERIOD_LABELS: Record<string, string> = {
  LIVE: "Live",
  DAILY: "Daily",
  WEEKLY: "Weekly",
  MONTHLY: "Monthly",
};

export function ReportRow({
  row,
  locale,
}: {
  row: ReportOverviewRow;
  locale: string;
}) {
  // Pin `?tz=<row.tz>` on every report link. The detail loader resolves tz as
  // "pinned ?tz → customer current-timezone snapshot → UTC"; without the pin
  // an old-tz bucket re-resolves to the customer's current tz and 404s after
  // a timezone change (same reason the single-customer index pins it).
  const href = `/${locale}/customers/${row.customerId}/analysis/reports/${row.period}/${row.bucketDate}?tz=${encodeURIComponent(row.tz)}`;
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
          {PERIOD_LABELS[row.period] ?? row.period} •{" "}
          {row.period === "LIVE" ? "now" : row.bucketDate}
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
}: {
  row: StoryOverviewRow;
  locale: string;
}) {
  // Story detail takes no variant params (it defaults from env).
  const href = `/${locale}/customers/${row.customerId}/analysis/story/${row.storyId}`;
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
          Story {row.storyId}
        </div>
        <CustomerLabel name={row.customerName} />
      </div>
      <div className="flex shrink-0 items-center gap-2">
        <ScorePair
          severity={row.severityScore}
          likelihood={row.likelihoodScore}
        />
        <PriorityBadge tier={row.priorityTier} />
      </div>
    </Link>
  );
}

export function EventRow({
  row,
  locale,
}: {
  row: EventOverviewRow;
  locale: string;
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
  const href = `/${locale}/customers/${row.customerId}/aice/${aiceId}/events/${eventKey}/analysis?${params.toString()}`;
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
          Event {row.eventKey}
        </div>
        <div className="truncate text-xs text-muted-foreground">
          {row.aiceId} • {row.customerName}
        </div>
      </div>
      <div className="flex shrink-0 items-center gap-2">
        <ScorePair
          severity={row.severityScore}
          likelihood={row.likelihoodScore}
        />
        <PriorityBadge tier={row.priorityTier} />
      </div>
    </Link>
  );
}

function ScorePair({
  severity,
  likelihood,
}: {
  severity: number;
  likelihood: number;
}) {
  return (
    <span className="hidden text-xs text-muted-foreground sm:inline">
      S {severity.toFixed(2)} · L {likelihood.toFixed(2)}
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
      aria-label="empty-banner"
      data-testid={testid}
      className="rounded border border-border bg-card px-4 py-3 text-sm text-muted-foreground"
    >
      {label}
    </div>
  );
}

// Partial fan-out failure (#391): one unreachable customer DB must not zero
// the counts nor blank the page — surface which customer degraded instead.
export function PartialFailureNotice({ failed }: { failed: FailedCustomer[] }) {
  if (failed.length === 0) return null;
  return (
    <div
      role="alert"
      aria-label="partial-failure-banner"
      data-testid="overview-partial-failure"
      className="mb-4 rounded border border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-900"
    >
      Some customers could not be reached and are excluded from the counts and
      list below:{" "}
      <span className="font-medium">
        {failed.map((f) => f.name).join(", ")}
      </span>
      . Try again shortly.
    </div>
  );
}

// Route-level loading skeleton (#391). The overview surfaces fan out across
// potentially many customer DBs per request, so each route ships a
// `loading.tsx` that renders this while the server component awaits the
// aggregator — Next.js wraps the page in a Suspense boundary automatically.
export function OverviewSkeleton({ rows = 5 }: { rows?: number }) {
  return (
    <div
      className="mx-auto max-w-4xl px-4 py-8 sm:px-6"
      role="status"
      aria-label="loading"
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
