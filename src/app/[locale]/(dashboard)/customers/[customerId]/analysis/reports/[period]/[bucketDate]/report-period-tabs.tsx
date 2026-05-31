import Link from "next/link";
import {
  type PeriodKind,
  periodBucketDate,
} from "@/lib/analysis/report-bucket-date";

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
   * Active report variant — forwarded on each tab link so a non-default
   * report (pinned tz / lang / model) stays on that variant across tabs.
   */
  variant?: {
    tz?: string;
    lang?: string;
    model_name?: string;
    model?: string;
  };
}

const TABS: ReadonlyArray<{ period: PeriodKind; label: string }> = [
  { period: "LIVE", label: "Live" },
  { period: "DAILY", label: "Daily" },
  { period: "WEEKLY", label: "Weekly" },
  { period: "MONTHLY", label: "Monthly" },
];

function variantQuery(variant: Props["variant"]): string {
  const q = new URLSearchParams();
  if (variant?.tz) q.set("tz", variant.tz);
  if (variant?.lang) q.set("lang", variant.lang);
  if (variant?.model_name) q.set("model_name", variant.model_name);
  if (variant?.model) q.set("model", variant.model);
  const s = q.toString();
  return s ? `?${s}` : "";
}

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
  variant,
}: Props) {
  const query = variantQuery(variant);
  const base = `/${locale}/customers/${customerId}/analysis/reports`;
  return (
    <nav aria-label="report-period-tabs" data-testid="report-period-tabs">
      <ul className="flex flex-wrap gap-1 border-b border-border">
        {TABS.map(({ period, label }) => {
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
