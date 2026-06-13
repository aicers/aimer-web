import Link from "next/link";
import { ReportCalendarPopover } from "@/components/analysis/report-calendar-popover";
import type { PeriodKind } from "@/lib/analysis/report-bucket-date";
import type { CalendarPopoverLabels } from "@/lib/analysis/report-calendar-labels";
import type {
  CalendarPeriod,
  NeighborBucket,
} from "@/lib/analysis/report-calendar-loader";
import { subjectPages } from "@/lib/navigation/routes";
import { ReportPeriodTabs } from "./report-period-tabs";

interface Props {
  locale: string;
  subjectId: string;
  /** The active period (the highlighted tab). */
  activePeriod: string;
  /** The calendar day the period tabs anchor their cross-period links to. */
  referenceDate: string;
  /** The open report's bucket date — the popover's initial viewport anchor. */
  bucketDate: string;
  /** The page's current query string, forwarded across the period tabs. */
  currentQuery?: string;
  /** Translated period-tab labels (`reportPeriod`). */
  periodLabels: Record<PeriodKind, string>;
  /** Nearest older has-report bucket within retention, or null. */
  prev: NeighborBucket | null;
  /** Nearest newer has-report bucket, or null (at the newest report). */
  next: NeighborBucket | null;
  /** True only when `prev` is null because the retention boundary was reached. */
  olderStop: boolean;
  /** Pre-resolved, serializable labels for the embedded calendar popover. */
  popoverLabels: CalendarPopoverLabels;
  labels: {
    periodNavLabel: string;
    temporalNavLabel: string;
    prev: string;
    next: string;
    noOlderRetained: string;
    openCalendar: string;
  };
}

function neighborHref(
  locale: string,
  subjectId: string,
  period: string,
  bucket: NeighborBucket,
): string {
  // Pin `?tz` so the detail loader resolves the same variant the neighbor
  // result was found at (an unpinned tz re-resolves to the current customer
  // tz and would 404 an old-tz bucket).
  return `${subjectPages.report(locale, subjectId, period, bucket.bucketDate)}?tz=${encodeURIComponent(
    bucket.tz,
  )}`;
}

/**
 * RFC 0004 (#576) — the report detail's date toolbar, unifying the period tabs,
 * the within-period prev/next, and the calendar button + popover into one
 * control. The calendar button + popover is the SAME component the report index
 * embeds per section, so the two surfaces never diverge; the detail
 * additionally carries the period tabs and within-period prev/next because it
 * alone has a single active period and bucket date. LIVE is the rolling bucket
 * with no calendar and no temporal neighbors, so it shows only the tabs.
 */
export function ReportDateToolbar({
  locale,
  subjectId,
  activePeriod,
  referenceDate,
  bucketDate,
  currentQuery,
  periodLabels,
  prev,
  next,
  olderStop,
  popoverLabels,
  labels,
}: Props) {
  const linkClass =
    "inline-flex items-center rounded border border-border px-3 py-1.5 text-sm font-medium text-foreground transition-colors hover:border-foreground";
  return (
    <div data-testid="report-date-toolbar">
      <ReportPeriodTabs
        locale={locale}
        customerId={subjectId}
        activePeriod={activePeriod}
        referenceDate={referenceDate}
        currentQuery={currentQuery}
        periodLabels={periodLabels}
        navLabel={labels.periodNavLabel}
      />
      {activePeriod !== "LIVE" && (
        <nav
          aria-label={labels.temporalNavLabel}
          data-testid="report-temporal-nav"
          className="mt-3 flex items-center justify-between gap-3"
        >
          <div className="flex items-center gap-2">
            {prev ? (
              <Link
                href={neighborHref(locale, subjectId, activePeriod, prev)}
                data-testid="temporal-prev"
                data-bucket-date={prev.bucketDate}
                className={linkClass}
              >
                ◀ {labels.prev}
              </Link>
            ) : olderStop ? (
              // Explicit retention-boundary stop — disabled, not a 404. Shown
              // only when older reports exist but aged out, never for the first
              // report.
              <span
                data-testid="temporal-prev-stop"
                aria-disabled="true"
                className="inline-flex items-center rounded border border-dashed border-border px-3 py-1.5 text-sm text-muted-foreground"
              >
                {labels.noOlderRetained}
              </span>
            ) : null}
            {next ? (
              <Link
                href={neighborHref(locale, subjectId, activePeriod, next)}
                data-testid="temporal-next"
                data-bucket-date={next.bucketDate}
                className={linkClass}
              >
                {labels.next} ▶
              </Link>
            ) : null}
          </div>
          <ReportCalendarPopover
            locale={locale}
            subjectId={subjectId}
            period={activePeriod as CalendarPeriod}
            anchorBucketDate={bucketDate}
            buttonLabel={labels.openCalendar}
            buttonTestId="report-calendar-button"
            labels={popoverLabels}
          />
        </nav>
      )}
    </div>
  );
}
