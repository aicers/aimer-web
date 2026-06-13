// RFC 0004 (#576) — calendar viewport math shared by the standalone calendar
// page, the thin calendar route handler, and the in-context calendar popover.
//
// A "viewport" is the month (DAILY) or year (WEEKLY/MONTHLY) the calendar grid
// currently shows. Keeping the resolve / shift / query / heading logic in one
// place guarantees the page (server, full re-render on URL change) and the
// popover (client, fetch on viewport nav) compute the SAME prev/next targets,
// query params, and heading — they must not drift.

import type { useTranslations } from "next-intl";
import type {
  CalendarPeriod,
  CalendarViewport,
} from "./report-calendar-loader";

type AnalysisTranslations = ReturnType<typeof useTranslations<"analysis">>;

const MONTH_RE = /^(\d{4})-(\d{2})$/;
const YEAR_RE = /^(\d{4})$/;

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

/**
 * Resolve the viewport from the granularity-matched param. A missing param
 * defaults to the current month/year (`now`); a present-but-malformed param is
 * `null` (the caller 404s). DAILY → `month=YYYY-MM`, WEEKLY/MONTHLY →
 * `year=YYYY`. `getParam` abstracts the source so the page (awaited
 * searchParams record) and the route handler (URLSearchParams) share one path.
 */
export function resolveViewport(
  period: CalendarPeriod,
  getParam: (name: string) => string | undefined,
  now: Date,
): CalendarViewport | null {
  if (period === "DAILY") {
    const raw = getParam("month");
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
  const raw = getParam("year");
  if (raw === undefined) return { kind: "year", year: now.getUTCFullYear() };
  const y = YEAR_RE.exec(raw);
  if (!y) return null;
  return { kind: "year", year: Number(y[1]) };
}

/**
 * The viewport that CONTAINS `bucketDate` for `period` — the calendar's initial
 * view when opened from a report (detail) or a period section's latest bucket
 * (index), matching `calendarViewportQuery`'s granularity.
 */
export function viewportFromBucketDate(
  period: CalendarPeriod,
  bucketDate: string,
): CalendarViewport {
  if (period === "DAILY") {
    const [y, m] = bucketDate.split("-").map(Number);
    return { kind: "month", year: y, month: m };
  }
  const [y] = bucketDate.split("-").map(Number);
  return { kind: "year", year: y };
}

/** The viewport's query string (`?month=YYYY-MM` or `?year=YYYY`). */
export function viewportToQuery(viewport: CalendarViewport): string {
  if (viewport.kind === "month") {
    return `?month=${viewport.year}-${pad2(viewport.month)}`;
  }
  return `?year=${viewport.year}`;
}

function shiftMonth(
  year: number,
  month: number,
  delta: number,
): { year: number; month: number } {
  const idx = year * 12 + (month - 1) + delta;
  return { year: Math.floor(idx / 12), month: (idx % 12) + 1 };
}

/** The adjacent viewport `delta` months (month kind) or years (year kind) away. */
export function shiftViewport(
  viewport: CalendarViewport,
  delta: number,
): CalendarViewport {
  if (viewport.kind === "month") {
    const s = shiftMonth(viewport.year, viewport.month, delta);
    return { kind: "month", year: s.year, month: s.month };
  }
  return { kind: "year", year: viewport.year + delta };
}

/**
 * The localized heading for `viewport`. Month viewports use `Intl` (locale
 * only, no catalog string); year viewports substitute into the `yearHeading`
 * template (`{year}`). Pure and serializable-input, so the standalone page (via
 * `buildViewportNav`) and the client popover render the SAME heading.
 */
export function viewportHeading(
  viewport: CalendarViewport,
  locale: string,
  yearHeadingTemplate: string,
): string {
  if (viewport.kind === "month") {
    return new Intl.DateTimeFormat(locale, {
      year: "numeric",
      month: "long",
    }).format(new Date(Date.UTC(viewport.year, viewport.month - 1, 1)));
  }
  return yearHeadingTemplate.replace("{year}", String(viewport.year));
}

export interface ViewportNav {
  prev: CalendarViewport;
  next: CalendarViewport;
  heading: string;
  prevLabel: string;
  nextLabel: string;
}

/**
 * The prev/next viewports plus the localized heading and prev/next labels for
 * `viewport`. Shared by the page (which turns prev/next into `<Link>` URLs) and
 * the popover (which sets them as fetch state), so both render the same heading
 * and step to the same neighbors.
 */
export function buildViewportNav(
  viewport: CalendarViewport,
  locale: string,
  t: AnalysisTranslations,
): ViewportNav {
  const yearHeadingTemplate = t("reportCalendar.yearHeading", {
    year: "{year}",
  });
  const heading = viewportHeading(viewport, locale, yearHeadingTemplate);
  if (viewport.kind === "month") {
    return {
      prev: shiftViewport(viewport, -1),
      next: shiftViewport(viewport, 1),
      heading,
      prevLabel: t("reportCalendar.prevMonth"),
      nextLabel: t("reportCalendar.nextMonth"),
    };
  }
  return {
    prev: shiftViewport(viewport, -1),
    next: shiftViewport(viewport, 1),
    heading,
    prevLabel: t("reportCalendar.prevYear"),
    nextLabel: t("reportCalendar.nextYear"),
  };
}
