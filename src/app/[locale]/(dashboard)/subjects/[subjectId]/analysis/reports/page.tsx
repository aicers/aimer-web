import Link from "next/link";
import { forbidden, notFound } from "next/navigation";
import type { useTranslations } from "next-intl";
import { getTranslations } from "next-intl/server";
import { ReportCalendarPopover } from "@/components/analysis/report-calendar-popover";
import type { PriorityTier } from "@/lib/analysis/priority-tier";
import type { PeriodKind } from "@/lib/analysis/report-bucket-date";
import {
  buildCalendarPopoverLabels,
  type CalendarPopoverLabels,
} from "@/lib/analysis/report-calendar-labels";
import {
  loadReportIndexPage,
  type ReportBucketItem,
  type ReportPeriodGroup,
} from "@/lib/analysis/report-index-page-loader";
import { getAuthPool } from "@/lib/db/client";
import { getSubjectKind } from "@/lib/db/subject-runtime-pool";
import { subjectPages } from "@/lib/navigation/routes";

type AnalysisTranslations = ReturnType<typeof useTranslations<"analysis">>;

interface PageProps {
  params: Promise<{
    locale: string;
    subjectId: string;
  }>;
}

// RFC 0002 / #369 — customer-scoped report index. Lists the available
// report buckets discovered from `periodic_report_state` (non-archived)
// and links each into the existing detail page. The bare
// `…/analysis/reports/` path 404'd before this page existed; #298 shipped
// the detail page only.
export default async function ReportIndexPage({ params }: PageProps) {
  const { locale, subjectId } = await params;

  // Resolve the subject kind so a group's index reads from the group result DB
  // with all-member authorization (#513); an unknown subject 404s.
  const kind = await getSubjectKind(getAuthPool(), subjectId);
  if (kind === null) notFound();

  // Pass the viewer's locale so each bucket's metadata resolves to the
  // viewer's language (viewer → English → any), never silently showing an
  // English tier where the viewer's language exists (#388).
  const outcome = await loadReportIndexPage({
    customerId: subjectId,
    subject: { kind, id: subjectId },
    locale,
  });

  // Same status mapping as the detail page: non-member / non-existent → 404
  // (existence-hiding); permission- or bridge-denied → real 403 via the
  // `forbidden.tsx` boundary.
  if (outcome.kind === "unauthorized") notFound();
  if (outcome.kind === "forbidden") forbidden();

  const { groups } = outcome;
  const tA = await getTranslations("analysis");
  const tPeriod = await getTranslations("reportPeriod");
  const periodLabels: Record<PeriodKind, string> = {
    LIVE: tPeriod("LIVE"),
    DAILY: tPeriod("DAILY"),
    WEEKLY: tPeriod("WEEKLY"),
    MONTHLY: tPeriod("MONTHLY"),
  };
  // Resolved once and shared by every per-section calendar button (#576): the
  // popover is a client component, so its labels must cross the boundary as
  // serializable strings, not a `next-intl` translation function.
  const popoverLabels = buildCalendarPopoverLabels(tA);

  return (
    <div className="mx-auto max-w-4xl px-4 py-8 sm:px-6">
      <header className="mb-6">
        <h1 className="text-2xl font-bold text-foreground">
          {tA("common.securityReports")}
        </h1>
        <p className="mt-1 text-sm text-muted-foreground">
          {tA("reportIndex.subtitle")}
        </p>
      </header>

      {groups.length === 0 ? (
        <div
          role="status"
          data-testid="reports-empty"
          className="rounded border border-border bg-card px-4 py-3 text-sm text-muted-foreground"
        >
          {tA("reportIndex.empty")}
        </div>
      ) : (
        <div className="space-y-8" data-testid="report-index">
          {groups.map((group) => (
            <PeriodSection
              key={group.period}
              group={group}
              locale={locale}
              subjectId={subjectId}
              periodLabels={periodLabels}
              popoverLabels={popoverLabels}
              t={tA}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function PeriodSection({
  group,
  locale,
  subjectId,
  periodLabels,
  popoverLabels,
  t,
}: {
  group: ReportPeriodGroup;
  locale: string;
  subjectId: string;
  periodLabels: Record<PeriodKind, string>;
  popoverLabels: CalendarPopoverLabels;
  t: AnalysisTranslations;
}) {
  const [latest, ...rest] = group.items;
  return (
    <section
      aria-labelledby={`period-heading-${group.period}`}
      data-testid={`period-section-${group.period}`}
    >
      <div className="mb-2 flex items-center justify-between gap-3">
        <h2
          id={`period-heading-${group.period}`}
          className="text-sm font-semibold uppercase tracking-wide text-muted-foreground"
        >
          {periodLabels[group.period]}
        </h2>
        {/* The hub keeps its capped "recent" preview (#369); the calendar is
            the in-context "view all / go back" affordance into history. The
            per-section button opens the period-matched popover, centered on the
            latest bucket, replacing the faint standalone-page link (#576). LIVE
            is a single rolling bucket — no calendar. */}
        {group.period !== "LIVE" && (
          <ReportCalendarPopover
            locale={locale}
            subjectId={subjectId}
            period={group.period}
            anchorBucketDate={latest.bucketDate}
            buttonLabel={t("reportIndex.viewCalendar")}
            buttonTestId={`period-calendar-button-${group.period}`}
            labels={popoverLabels}
          />
        )}
      </div>
      <BucketCard
        item={latest}
        locale={locale}
        subjectId={subjectId}
        latest
        periodLabels={periodLabels}
        t={t}
      />
      {rest.length > 0 && (
        <ul className="mt-2 space-y-2">
          {rest.map((item) => (
            <li key={`${item.period}-${item.bucketDate}-${item.tz}`}>
              <BucketCard
                item={item}
                locale={locale}
                subjectId={subjectId}
                periodLabels={periodLabels}
                t={t}
              />
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
  subjectId,
  latest = false,
  periodLabels,
  t,
}: {
  item: ReportBucketItem;
  locale: string;
  subjectId: string;
  latest?: boolean;
  periodLabels: Record<PeriodKind, string>;
  t: AnalysisTranslations;
}) {
  // Pin `?tz=<state.tz>` on every link. The detail loader resolves tz as
  // "pinned ?tz → customer current-timezone snapshot → UTC"; without the
  // pin an old-tz bucket (after a customer tz change) would re-resolve to
  // the current tz and 404. `lang`/`model` are omitted — they fall back to
  // the same env defaults the enrichment query used.
  const href = `${subjectPages.report(
    locale,
    subjectId,
    item.period,
    item.bucketDate,
  )}?tz=${encodeURIComponent(item.tz)}`;

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
          {bucketLabel(item, t, periodLabels)}
        </div>
        <div className="mt-0.5 flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
          <span>
            {item.tz}
            {item.result
              ? ` • ${t("common.generation", {
                  generation: item.result.generation,
                })}`
              : ""}
          </span>
          {item.availableLocales.length > 0 && (
            <span
              data-testid={`report-langs-${item.period}-${item.bucketDate}`}
              className="inline-flex items-center gap-1"
            >
              {item.availableLocales.map((loc) => (
                <span
                  key={loc}
                  data-locale={loc}
                  className="inline-flex items-center rounded border border-border px-1 py-0.5 text-[10px] font-medium uppercase tracking-wide"
                >
                  {loc}
                </span>
              ))}
            </span>
          )}
        </div>
      </div>
      <div className="flex shrink-0 items-center gap-2">
        {item.result && <PriorityBadge tier={item.result.priorityTier} />}
        <StatusBadge item={item} t={t} />
      </div>
    </Link>
  );
}

// Human-readable bucket label. LIVE is a rolling window with no calendar
// bucket; the calendar periods show their bucket range. DAILY/MONTHLY render
// raw calendar identifiers (not localized).
function bucketLabel(
  item: ReportBucketItem,
  t: AnalysisTranslations,
  periodLabels: Record<PeriodKind, string>,
): string {
  switch (item.period) {
    case "LIVE":
      return t("reportIndex.liveRollingNow", { period: periodLabels.LIVE });
    case "DAILY":
      return item.bucketDate;
    case "WEEKLY":
      return t("reportIndex.weekOf", {
        start: item.bucketDate,
        end: addDays(item.bucketDate, 6),
      });
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
function StatusBadge({
  item,
  t,
}: {
  item: ReportBucketItem;
  t: AnalysisTranslations;
}) {
  // `data-status` keeps a stable English value (a technical attribute);
  // only the visible label is localized.
  let label: string;
  let status: string;
  let className: string;
  if (item.stateStatus === "dirty") {
    label = t("reportIndex.statusUpdating");
    status = "Updating";
    className = "border-sky-300 bg-sky-50 text-sky-900";
  } else if (item.result) {
    label = t("reportIndex.statusReady");
    status = "Ready";
    className = "border-emerald-300 bg-emerald-50 text-emerald-900";
  } else {
    label = t("reportIndex.statusBeingGenerated");
    status = "Being generated";
    className = "border-amber-300 bg-amber-50 text-amber-900";
  }
  return (
    <span
      data-testid={`report-status-${item.period}-${item.bucketDate}`}
      data-status={status}
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
