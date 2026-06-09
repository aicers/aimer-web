import Link from "next/link";
import {
  type PeriodKind,
  periodBucketDate,
} from "@/lib/analysis/report-bucket-date";
import { mergeQuery } from "@/lib/navigation/query";
import { subjectPages } from "@/lib/navigation/routes";

interface Props {
  locale: string;
  customerId: string;
  /** The period the page is currently showing (the active tab). */
  activePeriod: string;
  /**
   * The calendar day the current view sits in (`YYYY-MM-DD`). Each
   * non-active tab links to the bucket of its period that overlaps this
   * day, so switching DAILY → WEEKLY lands on the week containing the
   * day the operator was just looking at.
   */
  referenceDate: string;
  /**
   * The page's current query string — forwarded on each tab link so a
   * non-default report (pinned tz / lang / model) stays on that variant
   * across tabs. Carried via the shared {@link mergeQuery} helper so tabs
   * and the language switcher preserve params identically (#388).
   */
  currentQuery?: string;
  /**
   * Translated tab labels (`reportPeriod`), keyed by period and injected by
   * the (server-component) caller so this stays a synchronous component.
   */
  periodLabels: Record<PeriodKind, string>;
  /** Localized accessible name for the tab-bar navigation landmark. */
  navLabel: string;
}

const TAB_PERIODS: readonly PeriodKind[] = [
  "LIVE",
  "DAILY",
  "WEEKLY",
  "MONTHLY",
];

/**
 * RFC 0002 Phase 3 (#298) — period tab bar for the report detail view.
 * Renders Live / Daily / Weekly / Monthly; the active period is a plain
 * highlighted label, the others are links to the equivalent bucket for
 * the day currently in view (`periodBucketDate`). The WEEKLY / MONTHLY
 * tabs are the navigation the Phase 3 scope calls for — they expose the
 * longer-window reports that Phase 2 produced no surface for.
 */
export function ReportPeriodTabs({
  locale,
  customerId,
  activePeriod,
  referenceDate,
  currentQuery,
  periodLabels,
  navLabel,
}: Props) {
  // Preserve (and normalize) the current variant params on every tab link.
  const qs = mergeQuery(currentQuery, {});
  const query = qs ? `?${qs}` : "";
  const base = subjectPages.reportsIndex(locale, customerId);
  return (
    <nav aria-label={navLabel} data-testid="report-period-tabs">
      <ul className="flex flex-wrap gap-1 border-b border-border">
        {TAB_PERIODS.map((period) => {
          const label = periodLabels[period];
          const active = period === activePeriod;
          const bucket = periodBucketDate(period, referenceDate);
          const className = `inline-flex items-center rounded-t border-b-2 px-3 py-2 text-sm font-medium ${
            active
              ? "border-foreground text-foreground"
              : "border-transparent text-muted-foreground hover:text-foreground"
          }`;
          if (active || bucket === null) {
            return (
              <li key={period}>
                <span
                  aria-current={active ? "page" : undefined}
                  data-active={active}
                  data-testid={`report-tab-${period}`}
                  className={className}
                >
                  {label}
                </span>
              </li>
            );
          }
          return (
            <li key={period}>
              <Link
                href={`${base}/${period}/${bucket}${query}`}
                data-active={false}
                data-testid={`report-tab-${period}`}
                className={className}
              >
                {label}
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
