import Link from "next/link";
import type { useTranslations } from "next-intl";
import { addCalendarDays } from "@/lib/analysis/report-bucket-date";
import type {
  CalendarCell,
  CalendarCellState,
  ReportCalendarData,
} from "@/lib/analysis/report-calendar-loader";
import { subjectPages } from "@/lib/navigation/routes";

type AnalysisTranslations = ReturnType<typeof useTranslations<"analysis">>;

interface Props {
  data: ReportCalendarData;
  locale: string;
  subjectId: string;
  t: AnalysisTranslations;
}

// Per-state cell styling. Only `has-report` is interactive; the rest are
// greyed, non-navigable spans (out-of-retention / future / none).
const STATE_CLASSES: Record<CalendarCellState, string> = {
  "has-report":
    "border-emerald-300 bg-emerald-50 text-emerald-900 hover:border-foreground",
  none: "border-border/60 bg-card text-muted-foreground",
  "out-of-retention": "border-border/40 bg-muted/40 text-muted-foreground/60",
  future: "border-border/40 bg-muted/40 text-muted-foreground/60",
};

// The aria/title message key per state.
const CELL_LABEL_KEY: Record<CalendarCellState, string> = {
  "has-report": "reportCalendar.cellHasReport",
  none: "reportCalendar.cellNone",
  "out-of-retention": "reportCalendar.cellOutOfRetention",
  future: "reportCalendar.cellFuture",
};

/**
 * RFC 0004 (#505) — per-period calendar. The granularity matches the period:
 * DAILY → a month/day grid, WEEKLY → a list of weeks, MONTHLY → a year/month
 * grid. Each cell is one of has-report / none / out-of-retention / future;
 * only has-report cells link into the detail page (tz pinned). The component
 * is subject-generic — it renders whatever `data` the loader classified.
 */
export function ReportCalendar({ data, locale, subjectId, t }: Props) {
  return (
    <div data-testid="report-calendar" data-period={data.period}>
      {data.period === "DAILY" ? (
        <MonthGrid data={data} locale={locale} subjectId={subjectId} t={t} />
      ) : data.period === "WEEKLY" ? (
        <WeekList data={data} locale={locale} subjectId={subjectId} t={t} />
      ) : (
        <MonthList data={data} locale={locale} subjectId={subjectId} t={t} />
      )}
      <Legend t={t} />
    </div>
  );
}

function cellHref(
  locale: string,
  subjectId: string,
  period: string,
  cell: CalendarCell,
): string {
  // Pin `?tz` (same as the index links): the detail loader re-resolves an
  // unpinned tz to the customer's current timezone, which would 404 an
  // old-tz bucket after a tz change.
  return `${subjectPages.report(locale, subjectId, period, cell.bucketDate)}?tz=${encodeURIComponent(
    cell.tz ?? "",
  )}`;
}

function CellBox({
  cell,
  label,
  locale,
  subjectId,
  period,
  t,
}: {
  cell: CalendarCell;
  label: string;
  locale: string;
  subjectId: string;
  period: string;
  t: AnalysisTranslations;
}) {
  // Full accessible description (`{label} — {state}`); the visible label is
  // just the date, so the state is carried in `title` (hover) and an sr-only
  // span (screen readers), since color alone is not accessible.
  const aria = t(CELL_LABEL_KEY[cell.state] as "reportCalendar.cellHasReport", {
    label,
  });
  const base = `flex min-h-[2.75rem] items-center justify-center rounded border px-2 py-1.5 text-center text-sm transition-colors ${STATE_CLASSES[cell.state]}`;
  if (cell.state === "has-report") {
    return (
      <Link
        href={cellHref(locale, subjectId, period, cell)}
        data-testid={`calendar-cell-${cell.bucketDate}`}
        data-state={cell.state}
        data-tz={cell.tz ?? undefined}
        aria-label={aria}
        title={aria}
        className={`${base} font-medium`}
      >
        {label}
      </Link>
    );
  }
  return (
    <span
      data-testid={`calendar-cell-${cell.bucketDate}`}
      data-state={cell.state}
      title={aria}
      className={base}
    >
      {label}
      <span className="sr-only">{aria}</span>
    </span>
  );
}

// --- DAILY: month/day grid -------------------------------------------------

function MonthGrid({ data, locale, subjectId, t }: Props) {
  // Weekday headers (Mon…Sun) and the leading blank count come from the
  // first cell's weekday; names are localized via Intl so no extra strings.
  // Each header is keyed by its ISO anchor day (2024-01-01 is a Monday), and
  // each leading blank by the calendar day it would occupy — both stable keys
  // that never reorder.
  const weekdayFmt = new Intl.DateTimeFormat(locale, { weekday: "short" });
  const weekdays = Array.from({ length: 7 }, (_, i) => {
    const anchor = new Date(Date.UTC(2024, 0, 1 + i));
    return { key: `wd-${i}`, name: weekdayFmt.format(anchor) };
  });
  const first = data.cells[0];
  const firstDow = isoDow(first.bucketDate); // 0=Mon … 6=Sun
  const blanks = Array.from({ length: firstDow }, (_, i) =>
    addCalendarDays(first.bucketDate, i - firstDow),
  );

  return (
    <section
      aria-label={t("reportCalendar.gridLabel")}
      className="grid grid-cols-7 gap-1.5"
    >
      {weekdays.map((wd) => (
        <div
          key={wd.key}
          className="pb-1 text-center text-xs font-medium uppercase tracking-wide text-muted-foreground"
        >
          {wd.name}
        </div>
      ))}
      {blanks.map((day) => (
        <div key={`blank-${day}`} aria-hidden="true" />
      ))}
      {data.cells.map((cell) => (
        <CellBox
          key={cell.bucketDate}
          cell={cell}
          label={String(Number(cell.bucketDate.slice(8, 10)))}
          locale={locale}
          subjectId={subjectId}
          period="DAILY"
          t={t}
        />
      ))}
    </section>
  );
}

// ISO day-of-week: 0=Mon … 6=Sun, for a `YYYY-MM-DD` day.
function isoDow(date: string): number {
  const [y, m, d] = date.split("-").map(Number);
  const dow = new Date(Date.UTC(y, m - 1, d)).getUTCDay(); // 0=Sun…6=Sat
  return dow === 0 ? 6 : dow - 1;
}

// --- WEEKLY: list of weeks -------------------------------------------------

function WeekList({ data, locale, subjectId, t }: Props) {
  return (
    <ul className="space-y-1.5" aria-label={t("reportCalendar.gridLabel")}>
      {data.cells.map((cell) => (
        <li key={cell.bucketDate}>
          <CellBox
            cell={cell}
            label={t("reportIndex.weekOf", {
              start: cell.bucketDate,
              end: addCalendarDays(cell.bucketDate, 6),
            })}
            locale={locale}
            subjectId={subjectId}
            period="WEEKLY"
            t={t}
          />
        </li>
      ))}
    </ul>
  );
}

// --- MONTHLY: year/month grid ----------------------------------------------

function MonthList({ data, locale, subjectId, t }: Props) {
  const monthFmt = new Intl.DateTimeFormat(locale, { month: "long" });
  return (
    <section
      aria-label={t("reportCalendar.gridLabel")}
      className="grid grid-cols-2 gap-1.5 sm:grid-cols-3 md:grid-cols-4"
    >
      {data.cells.map((cell) => {
        const [y, m] = cell.bucketDate.split("-").map(Number);
        const name = monthFmt.format(new Date(Date.UTC(y, m - 1, 1)));
        return (
          <CellBox
            key={cell.bucketDate}
            cell={cell}
            label={name}
            locale={locale}
            subjectId={subjectId}
            period="MONTHLY"
            t={t}
          />
        );
      })}
    </section>
  );
}

// --- Legend ----------------------------------------------------------------

function Legend({ t }: { t: AnalysisTranslations }) {
  const items: Array<{ state: CalendarCellState; label: string }> = [
    { state: "has-report", label: t("reportCalendar.legendHasReport") },
    { state: "none", label: t("reportCalendar.legendNone") },
    {
      state: "out-of-retention",
      label: t("reportCalendar.legendOutOfRetention"),
    },
    { state: "future", label: t("reportCalendar.legendFuture") },
  ];
  return (
    <ul
      data-testid="calendar-legend"
      className="mt-4 flex flex-wrap gap-3 text-xs text-muted-foreground"
    >
      {items.map((it) => (
        <li key={it.state} className="flex items-center gap-1.5">
          <span
            aria-hidden="true"
            className={`inline-block h-3 w-3 rounded-sm border ${STATE_CLASSES[it.state]}`}
          />
          {it.label}
        </li>
      ))}
    </ul>
  );
}
