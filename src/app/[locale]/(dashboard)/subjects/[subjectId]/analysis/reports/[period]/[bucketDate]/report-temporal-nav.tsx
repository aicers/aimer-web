import Link from "next/link";
import type { NeighborBucket } from "@/lib/analysis/report-calendar-loader";
import { subjectPages } from "@/lib/navigation/routes";

interface Props {
  locale: string;
  subjectId: string;
  /** The active period (DAILY/WEEKLY/MONTHLY — never LIVE here). */
  period: string;
  /** Nearest older has-report bucket within retention, or null. */
  prev: NeighborBucket | null;
  /** Nearest newer has-report bucket, or null (at the newest report). */
  next: NeighborBucket | null;
  /** Calendar entry for this period. */
  calendarHref: string;
  labels: {
    navLabel: string;
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
 * RFC 0004 (#505) — within-period prev/next for the report detail page.
 * Moves to the nearest has-report bucket in the SAME period (yesterday's
 * DAILY, last week's WEEKLY, …), complementing the period tabs (which switch
 * period, not time). Both stop conditions are explicit states, never dead
 * links: the older direction shows "no older reports retained" at the
 * retention boundary, and the newer direction simply has no affordance at the
 * most recent report. N/A for LIVE — the caller does not render this for the
 * rolling bucket.
 */
export function ReportTemporalNav({
  locale,
  subjectId,
  period,
  prev,
  next,
  calendarHref,
  labels,
}: Props) {
  const linkClass =
    "inline-flex items-center rounded border border-border px-3 py-1.5 text-sm font-medium text-foreground transition-colors hover:border-foreground";
  return (
    <nav
      aria-label={labels.navLabel}
      data-testid="report-temporal-nav"
      className="flex items-center justify-between gap-3"
    >
      <div className="flex items-center gap-2">
        {prev ? (
          <Link
            href={neighborHref(locale, subjectId, period, prev)}
            data-testid="temporal-prev"
            data-bucket-date={prev.bucketDate}
            className={linkClass}
          >
            ◀ {labels.prev}
          </Link>
        ) : (
          // Explicit retention-boundary / oldest stop — disabled, not a 404.
          <span
            data-testid="temporal-prev-stop"
            aria-disabled="true"
            className="inline-flex items-center rounded border border-dashed border-border px-3 py-1.5 text-sm text-muted-foreground"
          >
            {labels.noOlderRetained}
          </span>
        )}
        {next ? (
          <Link
            href={neighborHref(locale, subjectId, period, next)}
            data-testid="temporal-next"
            data-bucket-date={next.bucketDate}
            className={linkClass}
          >
            {labels.next} ▶
          </Link>
        ) : null}
      </div>
      <Link
        href={calendarHref}
        data-testid="temporal-calendar-link"
        className="text-sm text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
      >
        {labels.openCalendar}
      </Link>
    </nav>
  );
}
