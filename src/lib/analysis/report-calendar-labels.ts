// RFC 0004 (#576) — pre-resolved, SERIALIZABLE calendar labels.
//
// The shared calendar grid and the calendar popover are rendered both by
// server pages (standalone calendar page) and inside a client boundary (the
// popover, and the index/detail toolbars that embed it). A `next-intl`
// translation FUNCTION is not serializable across that boundary, so instead of
// threading `t` we resolve every label once on the server and pass plain
// strings. Cell / week labels keep their `{…}` placeholders (re-supplied as
// their own names so the catalog interpolation reconstructs the template), and
// the grid substitutes the per-cell value at render time.

import type { useTranslations } from "next-intl";
import type { CalendarCellState } from "./report-calendar-loader";

type AnalysisTranslations = ReturnType<typeof useTranslations<"analysis">>;

/** Serializable labels for {@link ReportCalendarGrid}. */
export interface CalendarGridLabels {
  gridLabel: string;
  /** Per-state aria/title template carrying a literal `{label}` placeholder. */
  cell: Record<CalendarCellState, string>;
  legend: Record<CalendarCellState, string>;
  /** WEEKLY row label template carrying `{start}` / `{end}` placeholders. */
  weekOf: string;
}

/**
 * Resolve the grid's labels. Placeholder-bearing messages are resolved with
 * their placeholder NAME as the value (`{ label: "{label}" }`), so the returned
 * string is the localized template — the grid then `.replace`s the placeholder
 * with the concrete date. Labels never contain a literal `{label}` of their
 * own, so the round-trip is unambiguous.
 */
export function buildCalendarGridLabels(
  t: AnalysisTranslations,
): CalendarGridLabels {
  return {
    gridLabel: t("reportCalendar.gridLabel"),
    cell: {
      "has-report": t("reportCalendar.cellHasReport", { label: "{label}" }),
      none: t("reportCalendar.cellNone", { label: "{label}" }),
      "out-of-retention": t("reportCalendar.cellOutOfRetention", {
        label: "{label}",
      }),
      future: t("reportCalendar.cellFuture", { label: "{label}" }),
    },
    legend: {
      "has-report": t("reportCalendar.legendHasReport"),
      none: t("reportCalendar.legendNone"),
      "out-of-retention": t("reportCalendar.legendOutOfRetention"),
      future: t("reportCalendar.legendFuture"),
    },
    weekOf: t("reportIndex.weekOf", { start: "{start}", end: "{end}" }),
  };
}

/** Serializable labels for {@link ReportCalendarPopover}. */
export interface CalendarPopoverLabels {
  grid: CalendarGridLabels;
  popoverLabel: string;
  loading: string;
  error: string;
  retry: string;
  close: string;
  prevMonth: string;
  nextMonth: string;
  prevYear: string;
  nextYear: string;
  /** Year-heading template carrying a literal `{year}` placeholder. */
  yearHeading: string;
}

/** Resolve the popover's chrome labels plus the embedded grid's labels. */
export function buildCalendarPopoverLabels(
  t: AnalysisTranslations,
): CalendarPopoverLabels {
  return {
    grid: buildCalendarGridLabels(t),
    popoverLabel: t("reportCalendar.popoverLabel"),
    loading: t("reportCalendar.loading"),
    error: t("reportCalendar.error"),
    retry: t("reportCalendar.retry"),
    close: t("reportCalendar.close"),
    prevMonth: t("reportCalendar.prevMonth"),
    nextMonth: t("reportCalendar.nextMonth"),
    prevYear: t("reportCalendar.prevYear"),
    nextYear: t("reportCalendar.nextYear"),
    yearHeading: t("reportCalendar.yearHeading", { year: "{year}" }),
  };
}
