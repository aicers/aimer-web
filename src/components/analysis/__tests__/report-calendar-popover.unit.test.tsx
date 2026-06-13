// @vitest-environment jsdom
//
// #576 — in-context calendar popover. Verifies:
//   - the trigger is a real link to the standalone calendar page (no-JS
//     fallback), and the popover is collapsed by default
//   - opening fetches the anchor viewport and renders the shared grid; a
//     has-report cell links to its detail page (tz pinned)
//   - viewport prev/next refetches a new viewport WITHOUT navigating
//   - the error state offers Retry, which refetches

import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CalendarPopoverLabels } from "@/lib/analysis/report-calendar-labels";
import type { ReportCalendarData } from "@/lib/analysis/report-calendar-loader";

vi.mock("next/link", () => ({
  default: ({
    href,
    children,
    ...props
  }: {
    href: string;
    children: React.ReactNode;
  }) => (
    <a href={href} {...props}>
      {children}
    </a>
  ),
}));

import { ReportCalendarPopover } from "../report-calendar-popover";

const SUBJECT_ID = "c0000000-0000-0000-0000-000000000001";

const LABELS: CalendarPopoverLabels = {
  grid: {
    gridLabel: "Report calendar",
    cell: {
      "has-report": "{label} — open report",
      none: "{label} — no report",
      "out-of-retention": "{label} — out of retention",
      future: "{label} — future",
    },
    legend: {
      "has-report": "Has report",
      none: "No report",
      "out-of-retention": "Out of retention",
      future: "Future",
    },
    weekOf: "Week of {start} – {end}",
  },
  popoverLabel: "Report calendar",
  loading: "Loading…",
  error: "Couldn't load the calendar.",
  retry: "Retry",
  close: "Close",
  prevMonth: "Previous month",
  nextMonth: "Next month",
  prevYear: "Previous year",
  nextYear: "Next year",
  yearHeading: "{year}",
};

// A DAILY month-viewport payload with a single has-report day, parameterized by
// the year-month so each fetched viewport returns a distinguishable cell.
function dailyData(year: number, month: number): ReportCalendarData {
  const mm = String(month).padStart(2, "0");
  return {
    period: "DAILY",
    viewport: { kind: "month", year, month },
    oldestNavigableDate: `${year}-${mm}-01`,
    today: `${year}-12-31`,
    cells: [
      { bucketDate: `${year}-${mm}-12`, state: "has-report", tz: "Asia/Seoul" },
      { bucketDate: `${year}-${mm}-13`, state: "none", tz: null },
    ],
  };
}

let fetchMock: ReturnType<typeof vi.fn>;

function renderPopover() {
  render(
    <ReportCalendarPopover
      locale="en"
      subjectId={SUBJECT_ID}
      period="DAILY"
      anchorBucketDate="2026-05-12"
      buttonLabel="Open calendar"
      buttonTestId="report-calendar-button"
      labels={LABELS}
    />,
  );
}

beforeEach(() => {
  fetchMock = vi.fn(async (url: string) => {
    const month = url.includes("month=2026-06") ? 6 : 5;
    return {
      ok: true,
      json: async () => ({ data: dailyData(2026, month) }),
    } as Response;
  });
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("ReportCalendarPopover", () => {
  it("renders a fallback link and stays collapsed by default", () => {
    renderPopover();
    const button = screen.getByTestId("report-calendar-button");
    expect(button.getAttribute("href")).toBe(
      `/en/subjects/${SUBJECT_ID}/analysis/reports/DAILY/calendar?month=2026-05`,
    );
    // Collapsed: no popover dialog, and no fetch fired yet.
    expect(screen.queryByTestId("calendar-popover")).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("opens to the anchor viewport and links a has-report cell to its detail page", async () => {
    renderPopover();
    fireEvent.click(screen.getByTestId("report-calendar-button"));

    expect(screen.getByTestId("calendar-popover")).toBeTruthy();
    await screen.findByTestId("report-calendar");

    // Fetched the anchor's month viewport.
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][0]).toBe(
      `/api/subjects/${SUBJECT_ID}/analysis/report/DAILY/calendar?month=2026-05`,
    );

    // The has-report cell links into the detail page with tz pinned.
    const cell = screen.getByTestId("calendar-cell-2026-05-12");
    expect(cell.tagName).toBe("A");
    expect(cell.getAttribute("href")).toBe(
      `/en/subjects/${SUBJECT_ID}/analysis/reports/DAILY/2026-05-12?tz=Asia%2FSeoul`,
    );
  });

  it("navigates the viewport without a full page load", async () => {
    renderPopover();
    fireEvent.click(screen.getByTestId("report-calendar-button"));
    await screen.findByTestId("calendar-cell-2026-05-12");
    expect(
      screen.getByTestId("calendar-popover-heading").textContent,
    ).toContain("May");

    fireEvent.click(screen.getByTestId("calendar-popover-next"));

    await screen.findByTestId("calendar-cell-2026-06-12");
    expect(fetchMock).toHaveBeenLastCalledWith(
      `/api/subjects/${SUBJECT_ID}/analysis/report/DAILY/calendar?month=2026-06`,
      expect.anything(),
    );
    expect(
      screen.getByTestId("calendar-popover-heading").textContent,
    ).toContain("June");
  });

  it("shows an error with Retry, which refetches", async () => {
    fetchMock.mockResolvedValueOnce({ ok: false } as Response);
    renderPopover();
    fireEvent.click(screen.getByTestId("report-calendar-button"));

    await screen.findByTestId("calendar-popover-error");
    expect(screen.queryByTestId("report-calendar")).toBeNull();

    fireEvent.click(screen.getByTestId("calendar-popover-retry"));
    await screen.findByTestId("report-calendar");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("closes on the close button", async () => {
    renderPopover();
    fireEvent.click(screen.getByTestId("report-calendar-button"));
    await screen.findByTestId("report-calendar");

    fireEvent.click(screen.getByTestId("calendar-popover-close"));
    await waitFor(() =>
      expect(screen.queryByTestId("calendar-popover")).toBeNull(),
    );
  });
});
