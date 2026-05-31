import Link from "next/link";
import { forbidden, notFound } from "next/navigation";
import type { PriorityTier } from "@/lib/analysis/priority-tier";
import type { PeriodKind } from "@/lib/analysis/report-bucket-date";
import {
  loadReportIndexPage,
  type ReportBucketItem,
  type ReportPeriodGroup,
} from "@/lib/analysis/report-index-page-loader";

interface PageProps {
  params: Promise<{
    locale: string;
    customerId: string;
  }>;
}

// RFC 0002 / #369 — customer-scoped report index. Lists the available
// report buckets discovered from `periodic_report_state` (non-archived)
// and links each into the existing detail page. The bare
// `…/analysis/reports/` path 404'd before this page existed; #298 shipped
// the detail page only.
export default async function ReportIndexPage({ params }: PageProps) {
  const { locale, customerId } = await params;

  const outcome = await loadReportIndexPage({ customerId });

  // Same status mapping as the detail page: non-member / non-existent → 404
  // (existence-hiding); permission- or bridge-denied → real 403 via the
  // `forbidden.tsx` boundary.
  if (outcome.kind === "unauthorized") notFound();
  if (outcome.kind === "forbidden") forbidden();

  const { groups } = outcome;

  return (
    <div className="mx-auto max-w-4xl px-4 py-8 sm:px-6">
      <header className="mb-6">
        <h1 className="text-2xl font-bold text-foreground">Security Reports</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Available report buckets for this customer. Open a bucket to read its
          report.
        </p>
      </header>

      {groups.length === 0 ? (
        <div
          role="status"
          aria-label="empty-banner"
          data-testid="reports-empty"
          className="rounded border border-border bg-card px-4 py-3 text-sm text-muted-foreground"
        >
          No report buckets are available yet. Reports appear here once the
          analysis worker begins tracking them.
        </div>
      ) : (
        <div className="space-y-8" data-testid="report-index">
          {groups.map((group) => (
            <PeriodSection
              key={group.period}
              group={group}
              locale={locale}
              customerId={customerId}
            />
          ))}
        </div>
      )}
    </div>
  );
}

const PERIOD_LABELS: Record<PeriodKind, string> = {
  LIVE: "Live",
  DAILY: "Daily",
  WEEKLY: "Weekly",
  MONTHLY: "Monthly",
};

function PeriodSection({
  group,
  locale,
  customerId,
}: {
  group: ReportPeriodGroup;
  locale: string;
  customerId: string;
}) {
  const [latest, ...rest] = group.items;
  return (
    <section
      aria-label={`period-${group.period}`}
      data-testid={`period-section-${group.period}`}
    >
      <h2 className="mb-2 text-sm font-semibold uppercase tracking-wide text-muted-foreground">
        {PERIOD_LABELS[group.period]}
      </h2>
      <BucketCard
        item={latest}
        locale={locale}
        customerId={customerId}
        latest
      />
      {rest.length > 0 && (
        <ul className="mt-2 space-y-2">
          {rest.map((item) => (
            <li key={`${item.period}-${item.bucketDate}-${item.tz}`}>
              <BucketCard item={item} locale={locale} customerId={customerId} />
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function BucketCard({
  item,
  locale,
  customerId,
  latest = false,
}: {
  item: ReportBucketItem;
  locale: string;
  customerId: string;
  latest?: boolean;
}) {
  // Pin `?tz=<state.tz>` on every link. The detail loader resolves tz as
  // "pinned ?tz → customer current-timezone snapshot → UTC"; without the
  // pin an old-tz bucket (after a customer tz change) would re-resolve to
  // the current tz and 404. `lang`/`model` are omitted — they fall back to
  // the same env defaults the enrichment query used.
  const href = `/${locale}/customers/${customerId}/analysis/reports/${item.period}/${item.bucketDate}?tz=${encodeURIComponent(item.tz)}`;

  return (
    <Link
      href={href}
      data-testid={`report-link-${item.period}-${item.bucketDate}`}
      data-tz={item.tz}
      className={`flex items-center justify-between gap-3 rounded border px-4 py-3 transition-colors hover:border-foreground ${
        latest ? "border-border bg-card" : "border-border/60"
      }`}
    >
      <div className="min-w-0">
        <div className="truncate text-sm font-medium text-foreground">
          {bucketLabel(item)}
        </div>
        <div className="mt-0.5 text-xs text-muted-foreground">
          {item.tz}
          {item.result ? ` • generation ${item.result.generation}` : ""}
        </div>
      </div>
      <div className="flex shrink-0 items-center gap-2">
        {item.result && <PriorityBadge tier={item.result.priorityTier} />}
        <StatusBadge item={item} />
      </div>
    </Link>
  );
}

// Human-readable bucket label. LIVE is a rolling window with no calendar
// bucket; the calendar periods show their bucket range.
function bucketLabel(item: ReportBucketItem): string {
  switch (item.period) {
    case "LIVE":
      return "Live (rolling) • now";
    case "DAILY":
      return item.bucketDate;
    case "WEEKLY":
      return `Week of ${item.bucketDate} – ${addDays(item.bucketDate, 6)}`;
    case "MONTHLY":
      return monthLabel(item.bucketDate);
  }
}

// `YYYY-MM-DD` + n days, pure UTC calendar math (bucket dates are plain
// calendar days here, matching `report-bucket-date.ts`).
function addDays(bucketDate: string, days: number): string {
  const [y, m, d] = bucketDate.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + days);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${dt.getUTCFullYear()}-${pad(dt.getUTCMonth() + 1)}-${pad(dt.getUTCDate())}`;
}

function monthLabel(bucketDate: string): string {
  const [y, m] = bucketDate.split("-");
  return `${y}-${m}`;
}

// Lightweight per-bucket status (#369 open question — surface a hint, not
// just a link). A result present means the latest default variant rendered;
// `dirty` means new source data landed and a refresh is queued; no result
// (pending) means the first generation is still being produced.
function StatusBadge({ item }: { item: ReportBucketItem }) {
  let label: string;
  let className: string;
  if (item.stateStatus === "dirty") {
    label = "Updating";
    className = "border-sky-300 bg-sky-50 text-sky-900";
  } else if (item.result) {
    label = "Ready";
    className = "border-emerald-300 bg-emerald-50 text-emerald-900";
  } else {
    label = "Being generated";
    className = "border-amber-300 bg-amber-50 text-amber-900";
  }
  return (
    <span
      data-testid={`report-status-${item.period}-${item.bucketDate}`}
      data-status={label}
      className={`inline-flex items-center rounded-full border px-2 py-0.5 text-xs font-medium ${className}`}
    >
      {label}
    </span>
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
