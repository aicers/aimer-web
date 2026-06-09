import Link from "next/link";
import { forbidden, notFound } from "next/navigation";
import { getTranslations } from "next-intl/server";
import {
  type CalendarPeriod,
  type CalendarViewport,
  loadReportCalendarPage,
} from "@/lib/analysis/report-calendar-loader";
import { getCurrentTimestamp } from "@/lib/instrumentation/time";
import { subjectPages } from "@/lib/navigation/routes";
import { ReportCalendar } from "./report-calendar";

interface PageProps {
  params: Promise<{
    locale: string;
    subjectId: string;
    period: string;
  }>;
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
}

// Calendar periods only — LIVE is the rolling "now" bucket and has no
// calendar (uppercase case-lock, matching the detail route).
const CALENDAR_PERIODS = new Set<CalendarPeriod>([
  "DAILY",
  "WEEKLY",
  "MONTHLY",
]);

const MONTH_RE = /^(\d{4})-(\d{2})$/;
const YEAR_RE = /^(\d{4})$/;

function firstParam(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

// Resolve the viewport from the granularity-matched search param. A missing
// param defaults to the current month/year; a present-but-malformed param is
// a 404 (mirroring the detail route's strict validation). DAILY → ?month,
// WEEKLY/MONTHLY → ?year.
function resolveViewport(
  period: CalendarPeriod,
  sp: Record<string, string | string[] | undefined>,
  now: Date,
): CalendarViewport | null {
  if (period === "DAILY") {
    const raw = firstParam(sp.month);
    if (raw === undefined) {
      return {
        kind: "month",
        year: now.getUTCFullYear(),
        month: now.getUTCMonth() + 1,
      };
    }
    const m = MONTH_RE.exec(raw);
    if (!m) return null;
    const month = Number(m[2]);
    if (month < 1 || month > 12) return null;
    return { kind: "month", year: Number(m[1]), month };
  }
  const raw = firstParam(sp.year);
  if (raw === undefined) return { kind: "year", year: now.getUTCFullYear() };
  const y = YEAR_RE.exec(raw);
  if (!y) return null;
  return { kind: "year", year: Number(y[1]) };
}

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

// Build the calendar URL for an adjacent viewport (prev/next month or year).
function viewportUrl(
  locale: string,
  subjectId: string,
  period: CalendarPeriod,
  viewport: CalendarViewport,
): string {
  const base = subjectPages.reportCalendar(locale, subjectId, period);
  if (viewport.kind === "month") {
    return `${base}?month=${viewport.year}-${pad2(viewport.month)}`;
  }
  return `${base}?year=${viewport.year}`;
}

function shiftMonth(
  year: number,
  month: number,
  delta: number,
): { year: number; month: number } {
  const idx = year * 12 + (month - 1) + delta;
  return { year: Math.floor(idx / 12), month: (idx % 12) + 1 };
}

export default async function ReportCalendarPage({
  params,
  searchParams,
}: PageProps) {
  const { locale, subjectId, period } = await params;
  const sp = (await searchParams) ?? {};

  if (!CALENDAR_PERIODS.has(period as CalendarPeriod)) notFound();
  const calendarPeriod = period as CalendarPeriod;

  const viewport = resolveViewport(calendarPeriod, sp, getCurrentTimestamp());
  if (viewport === null) notFound();

  const outcome = await loadReportCalendarPage({
    subjectId,
    period: calendarPeriod,
    viewport,
  });

  // Same status mapping as the detail/index pages.
  if (outcome.kind === "unauthorized") notFound();
  if (outcome.kind === "forbidden") forbidden();

  const { data } = outcome;
  const tA = await getTranslations("analysis");
  const tPeriod = await getTranslations("reportPeriod");

  // Prev/next viewport links + heading.
  let prev: CalendarViewport;
  let next: CalendarViewport;
  let heading: string;
  let prevLabel: string;
  let nextLabel: string;
  if (viewport.kind === "month") {
    const p = shiftMonth(viewport.year, viewport.month, -1);
    const n = shiftMonth(viewport.year, viewport.month, 1);
    prev = { kind: "month", year: p.year, month: p.month };
    next = { kind: "month", year: n.year, month: n.month };
    heading = new Intl.DateTimeFormat(locale, {
      year: "numeric",
      month: "long",
    }).format(new Date(Date.UTC(viewport.year, viewport.month - 1, 1)));
    prevLabel = tA("reportCalendar.prevMonth");
    nextLabel = tA("reportCalendar.nextMonth");
  } else {
    prev = { kind: "year", year: viewport.year - 1 };
    next = { kind: "year", year: viewport.year + 1 };
    heading = tA("reportCalendar.yearHeading", { year: viewport.year });
    prevLabel = tA("reportCalendar.prevYear");
    nextLabel = tA("reportCalendar.nextYear");
  }

  return (
    <div className="mx-auto max-w-4xl px-4 py-8 sm:px-6">
      <header className="mb-6">
        <h1 className="text-2xl font-bold text-foreground">
          {tA("reportCalendar.title")}
        </h1>
        <p className="mt-1 text-sm text-muted-foreground">
          {tPeriod(calendarPeriod)} • {tA("reportCalendar.subtitle")}
        </p>
      </header>

      <nav
        aria-label={tA("reportCalendar.navLabel")}
        data-testid="calendar-viewport-nav"
        className="mb-4 flex items-center justify-between gap-3"
      >
        <Link
          href={viewportUrl(locale, subjectId, calendarPeriod, prev)}
          data-testid="calendar-prev"
          className="inline-flex items-center rounded border border-border px-3 py-1.5 text-sm font-medium text-foreground transition-colors hover:border-foreground"
        >
          ◀ {prevLabel}
        </Link>
        <span
          className="text-sm font-semibold text-foreground"
          data-testid="calendar-heading"
        >
          {heading}
        </span>
        <Link
          href={viewportUrl(locale, subjectId, calendarPeriod, next)}
          data-testid="calendar-next"
          className="inline-flex items-center rounded border border-border px-3 py-1.5 text-sm font-medium text-foreground transition-colors hover:border-foreground"
        >
          {nextLabel} ▶
        </Link>
      </nav>

      <ReportCalendar
        data={data}
        locale={locale}
        subjectId={subjectId}
        t={tA}
      />

      <div className="mt-6">
        <Link
          href={subjectPages.reportsIndex(locale, subjectId)}
          data-testid="calendar-back"
          className="text-sm text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
        >
          ← {tA("reportCalendar.backToReports")}
        </Link>
      </div>
    </div>
  );
}
