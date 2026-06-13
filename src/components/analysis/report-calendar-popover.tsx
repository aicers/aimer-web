"use client";

import { useCallback, useEffect, useId, useRef, useState } from "react";
import { calendarViewportQuery } from "@/lib/analysis/report-bucket-date";
import type { CalendarPopoverLabels } from "@/lib/analysis/report-calendar-labels";
import type {
  CalendarPeriod,
  CalendarViewport,
  ReportCalendarData,
} from "@/lib/analysis/report-calendar-loader";
import {
  shiftViewport,
  viewportFromBucketDate,
  viewportHeading,
  viewportToQuery,
} from "@/lib/analysis/report-calendar-viewport";
import { subjectApi, subjectPages } from "@/lib/navigation/routes";
import { ReportCalendarGrid } from "./report-calendar-grid";

interface Props {
  locale: string;
  subjectId: string;
  /** Calendar period — never LIVE (LIVE has no calendar affordance). */
  period: CalendarPeriod;
  /**
   * The bucket the calendar opens centered on: the current report bucket on the
   * detail page, or a period section's latest bucket on the index. Its viewport
   * is the popover's initial view, matching the standalone link's behavior.
   */
  anchorBucketDate: string;
  /** Localized calendar-button text (index vs detail use different copy). */
  buttonLabel: string;
  /** Stable test id for the trigger button (disambiguates index sections). */
  buttonTestId: string;
  /** Pre-resolved, serializable labels (no `next-intl` fn across the boundary). */
  labels: CalendarPopoverLabels;
}

type Status = "loading" | "ok" | "error";

/**
 * RFC 0004 (#576) — the in-context calendar button + anchored popover, shared
 * across the report index (one per non-LIVE section) and the report detail
 * toolbar. The button is a real link to the standalone calendar page (no-JS /
 * progressive-enhancement fallback); with JS it opens an anchored popover that
 * fetches one viewport at a time from the thin calendar handler, navigates the
 * viewport (prev/next month or year) WITHOUT a full page load, and links a
 * has-report bucket to its detail page via the shared {@link ReportCalendarGrid}.
 */
export function ReportCalendarPopover({
  locale,
  subjectId,
  period,
  anchorBucketDate,
  buttonLabel,
  buttonTestId,
  labels,
}: Props) {
  const [open, setOpen] = useState(false);
  const [viewport, setViewport] = useState<CalendarViewport>(() =>
    viewportFromBucketDate(period, anchorBucketDate),
  );
  const [status, setStatus] = useState<Status>("loading");
  const [data, setData] = useState<ReportCalendarData | null>(null);
  // Bumped to force a refetch of the current viewport (Retry) without changing it.
  const [reloadKey, setReloadKey] = useState(0);

  const containerRef = useRef<HTMLDivElement>(null);
  const panelId = useId();

  // No-JS fallback: the standalone calendar page, opened to the viewport that
  // holds the anchor bucket (same target today's links use).
  const fallbackHref = `${subjectPages.reportCalendar(
    locale,
    subjectId,
    period,
  )}${calendarViewportQuery(period, anchorBucketDate)}`;

  // Fetch the active viewport whenever the popover is open (and on viewport
  // change / Retry). Aborts an in-flight request when the viewport changes or
  // the popover closes, so a slow earlier viewport never overwrites a newer one.
  // `reloadKey` is an intentional trigger: bumping it (Retry) refetches.
  // biome-ignore lint/correctness/useExhaustiveDependencies: reloadKey forces a refetch of the current viewport on Retry.
  useEffect(() => {
    if (!open) return;
    const controller = new AbortController();
    setStatus("loading");
    const url = `${subjectApi.reportCalendar(subjectId, period)}${viewportToQuery(viewport)}`;
    (async () => {
      try {
        const res = await fetch(url, {
          credentials: "same-origin",
          cache: "no-store",
          signal: controller.signal,
        });
        if (controller.signal.aborted) return;
        if (!res.ok) {
          setStatus("error");
          return;
        }
        const body = (await res.json()) as { data?: ReportCalendarData };
        if (controller.signal.aborted) return;
        if (!body.data) {
          setStatus("error");
          return;
        }
        setData(body.data);
        setStatus("ok");
      } catch {
        if (!controller.signal.aborted) setStatus("error");
      }
    })();
    return () => controller.abort();
  }, [open, viewport, reloadKey, subjectId, period]);

  // Close on Escape and on a click outside the popover.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    const onClick = (e: MouseEvent) => {
      if (!containerRef.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("keydown", onKey);
    document.addEventListener("mousedown", onClick);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("mousedown", onClick);
    };
  }, [open]);

  const onTriggerClick = useCallback(
    (e: React.MouseEvent<HTMLAnchorElement>) => {
      // Let modified / non-primary clicks fall through to the fallback href so
      // "open in new tab" still reaches the standalone page.
      if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.button !== 0) {
        return;
      }
      e.preventDefault();
      setOpen((v) => !v);
    },
    [],
  );

  const isMonth = viewport.kind === "month";
  const heading = viewportHeading(viewport, locale, labels.yearHeading);
  const prevLabel = isMonth ? labels.prevMonth : labels.prevYear;
  const nextLabel = isMonth ? labels.nextMonth : labels.nextYear;

  return (
    <div ref={containerRef} className="relative inline-block">
      <a
        href={fallbackHref}
        onClick={onTriggerClick}
        data-testid={buttonTestId}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls={open ? panelId : undefined}
        className="inline-flex items-center gap-1.5 rounded border border-border px-3 py-1.5 text-sm font-medium text-foreground transition-colors hover:border-foreground"
      >
        <span aria-hidden="true">📅</span>
        {buttonLabel}
      </a>

      {open && (
        <div
          id={panelId}
          role="dialog"
          aria-label={labels.popoverLabel}
          data-testid="calendar-popover"
          className="absolute right-0 z-20 mt-2 w-[min(22rem,90vw)] rounded-md border border-border bg-card p-4 shadow-lg"
        >
          <div className="mb-3 flex items-center justify-between gap-2">
            <button
              type="button"
              onClick={() => setViewport((v) => shiftViewport(v, -1))}
              data-testid="calendar-popover-prev"
              aria-label={prevLabel}
              className="inline-flex items-center rounded border border-border px-2 py-1 text-sm text-foreground transition-colors hover:border-foreground"
            >
              ◀
            </button>
            <span
              data-testid="calendar-popover-heading"
              className="text-sm font-semibold text-foreground"
            >
              {heading}
            </span>
            <button
              type="button"
              onClick={() => setViewport((v) => shiftViewport(v, 1))}
              data-testid="calendar-popover-next"
              aria-label={nextLabel}
              className="inline-flex items-center rounded border border-border px-2 py-1 text-sm text-foreground transition-colors hover:border-foreground"
            >
              ▶
            </button>
          </div>

          {status === "loading" && (
            <div
              role="status"
              data-testid="calendar-popover-loading"
              className="px-2 py-6 text-center text-sm text-muted-foreground"
            >
              {labels.loading}
            </div>
          )}
          {status === "error" && (
            <div
              role="alert"
              data-testid="calendar-popover-error"
              className="flex flex-col items-center gap-2 px-2 py-6 text-center text-sm text-muted-foreground"
            >
              {labels.error}
              <button
                type="button"
                onClick={() => setReloadKey((k) => k + 1)}
                data-testid="calendar-popover-retry"
                className="inline-flex items-center rounded border border-border px-3 py-1 font-medium text-foreground transition-colors hover:border-foreground"
              >
                {labels.retry}
              </button>
            </div>
          )}
          {status === "ok" && data && (
            <ReportCalendarGrid
              data={data}
              locale={locale}
              subjectId={subjectId}
              labels={labels.grid}
            />
          )}

          <div className="mt-3 flex justify-end">
            <button
              type="button"
              onClick={() => setOpen(false)}
              data-testid="calendar-popover-close"
              className="text-xs text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
            >
              {labels.close}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
