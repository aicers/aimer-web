import Link from "next/link";
import { forbidden, notFound } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { ReportCalendarGrid } from "@/components/analysis/report-calendar-grid";
import { buildCalendarGridLabels } from "@/lib/analysis/report-calendar-labels";
import {
  type CalendarPeriod,
  type CalendarViewport,
  loadReportCalendarPage,
} from "@/lib/analysis/report-calendar-loader";
import {
  buildViewportNav,
  resolveViewport,
  viewportToQuery,
} from "@/lib/analysis/report-calendar-viewport";
import { getAuthPool } from "@/lib/db/client";
import { getSubjectKind } from "@/lib/db/subject-runtime-pool";
import { getCurrentTimestamp } from "@/lib/instrumentation/time";
import { subjectPages } from "@/lib/navigation/routes";

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

function firstParam(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

// Build the calendar URL for a viewport (prev/next month or year).
function viewportUrl(
  locale: string,
  subjectId: string,
  period: CalendarPeriod,
  viewport: CalendarViewport,
): string {
  return `${subjectPages.reportCalendar(locale, subjectId, period)}${viewportToQuery(viewport)}`;
}

export default async function ReportCalendarPage({
  params,
  searchParams,
}: PageProps) {
  const { locale, subjectId, period } = await params;
  const sp = (await searchParams) ?? {};

  if (!CALENDAR_PERIODS.has(period as CalendarPeriod)) notFound();
  const calendarPeriod = period as CalendarPeriod;

  const viewport = resolveViewport(
    calendarPeriod,
    (name) => firstParam(sp[name]),
    getCurrentTimestamp(),
  );
  if (viewport === null) notFound();

  // Resolve the subject kind so a group's calendar uses group auth, the group
  // result DB, and the group retention boundary (#513); an unknown subject 404s.
  const kind = await getSubjectKind(getAuthPool(), subjectId);
  if (kind === null) notFound();

  const outcome = await loadReportCalendarPage({
    subjectId,
    period: calendarPeriod,
    viewport,
    subjectKind: kind,
  });

  // Same status mapping as the detail/index pages.
  if (outcome.kind === "unauthorized") notFound();
  if (outcome.kind === "forbidden") forbidden();

  const { data } = outcome;
  const tA = await getTranslations("analysis");
  const tPeriod = await getTranslations("reportPeriod");

  // Prev/next viewport links + heading (shared with the popover so both step
  // to the same neighbors and render the same heading).
  const nav = buildViewportNav(viewport, locale, tA);

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
          href={viewportUrl(locale, subjectId, calendarPeriod, nav.prev)}
          data-testid="calendar-prev"
          className="inline-flex items-center rounded border border-border px-3 py-1.5 text-sm font-medium text-foreground transition-colors hover:border-foreground"
        >
          ◀ {nav.prevLabel}
        </Link>
        <span
          className="text-sm font-semibold text-foreground"
          data-testid="calendar-heading"
        >
          {nav.heading}
        </span>
        <Link
          href={viewportUrl(locale, subjectId, calendarPeriod, nav.next)}
          data-testid="calendar-next"
          className="inline-flex items-center rounded border border-border px-3 py-1.5 text-sm font-medium text-foreground transition-colors hover:border-foreground"
        >
          {nav.nextLabel} ▶
        </Link>
      </nav>

      <ReportCalendarGrid
        data={data}
        locale={locale}
        subjectId={subjectId}
        labels={buildCalendarGridLabels(tA)}
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
