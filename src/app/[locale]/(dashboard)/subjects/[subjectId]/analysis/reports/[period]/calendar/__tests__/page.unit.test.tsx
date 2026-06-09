// @vitest-environment jsdom
//
// #505 — report calendar page. Verifies:
//   - has-report cells link into the detail page with `?tz` pinned; other
//     states render as non-navigable cells
//   - the viewport nav builds the correct prev/next month/year URLs
//   - LIVE and malformed viewport params → notFound (404)
//   - unauthorized → notFound (404); forbidden → forbidden (403)

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CalendarPageOutcome } from "@/lib/analysis/report-calendar-loader";

const mockLoad = vi.fn<() => Promise<CalendarPageOutcome>>();

// The page imports `getCurrentTimestamp` (a `server-only` module) for the
// default-viewport clock; neutralize the guard so it imports under jsdom.
vi.mock("server-only", () => ({}));

vi.mock("@/lib/analysis/report-calendar-loader", () => ({
  loadReportCalendarPage: () => mockLoad(),
}));

vi.mock("next/navigation", () => ({
  notFound: () => {
    throw new Error("NEXT_NOT_FOUND");
  },
  forbidden: () => {
    throw new Error("NEXT_FORBIDDEN");
  },
}));

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

vi.mock("next-intl/server", async () => {
  const { createTranslator } = await import("next-intl");
  const messages = (await import("@/i18n/messages/en.json")).default;
  return {
    getTranslations: async (namespace?: string) =>
      createTranslator({
        locale: "en",
        messages,
        namespace: namespace as never,
      }),
  };
});

import ReportCalendarPage from "../page";

const SUBJECT_ID = "c0000000-0000-0000-0000-000000000001";

function okFixture(): CalendarPageOutcome {
  return {
    kind: "ok",
    data: {
      period: "DAILY",
      viewport: { kind: "month", year: 2026, month: 5 },
      oldestNavigableDate: "2026-05-10",
      today: "2026-05-21",
      cells: [
        { bucketDate: "2026-05-09", state: "out-of-retention", tz: null },
        { bucketDate: "2026-05-12", state: "has-report", tz: "Asia/Seoul" },
        { bucketDate: "2026-05-13", state: "none", tz: null },
        { bucketDate: "2026-05-25", state: "future", tz: null },
      ],
    },
  };
}

function monthlyFixture(): CalendarPageOutcome {
  return {
    kind: "ok",
    data: {
      period: "MONTHLY",
      viewport: { kind: "year", year: 2026 },
      oldestNavigableDate: null,
      today: "2026-06-09",
      cells: [
        { bucketDate: "2026-05-01", state: "has-report", tz: "Asia/Seoul" },
        { bucketDate: "2026-06-01", state: "has-report", tz: "Asia/Seoul" },
        { bucketDate: "2026-07-01", state: "future", tz: null },
      ],
    },
  };
}

async function renderPage(period: string, search: Record<string, string>) {
  const ui = await ReportCalendarPage({
    params: Promise.resolve({ locale: "en", subjectId: SUBJECT_ID, period }),
    searchParams: Promise.resolve(search),
  });
  render(ui);
}

beforeEach(() => {
  mockLoad.mockReset();
});

afterEach(() => {
  cleanup();
});

describe("report calendar page", () => {
  it("links only has-report cells, with tz pinned", async () => {
    mockLoad.mockResolvedValue(okFixture());
    await renderPage("DAILY", { month: "2026-05" });

    const hasReport = screen.getByTestId("calendar-cell-2026-05-12");
    expect(hasReport.tagName).toBe("A");
    expect(hasReport.getAttribute("href")).toBe(
      `/en/subjects/${SUBJECT_ID}/analysis/reports/DAILY/2026-05-12?tz=Asia%2FSeoul`,
    );

    // Non-navigable states are spans, not links.
    expect(screen.getByTestId("calendar-cell-2026-05-13").tagName).toBe("SPAN");
    expect(screen.getByTestId("calendar-cell-2026-05-09").tagName).toBe("SPAN");
    expect(screen.getByTestId("calendar-cell-2026-05-25").tagName).toBe("SPAN");
  });

  it("builds prev/next month viewport links", async () => {
    mockLoad.mockResolvedValue(okFixture());
    await renderPage("DAILY", { month: "2026-05" });

    expect(screen.getByTestId("calendar-prev").getAttribute("href")).toBe(
      `/en/subjects/${SUBJECT_ID}/analysis/reports/DAILY/calendar?month=2026-04`,
    );
    expect(screen.getByTestId("calendar-next").getAttribute("href")).toBe(
      `/en/subjects/${SUBJECT_ID}/analysis/reports/DAILY/calendar?month=2026-06`,
    );
  });

  it("builds prev/next year viewport links for a year viewport", async () => {
    mockLoad.mockResolvedValue(monthlyFixture());
    await renderPage("MONTHLY", { year: "2026" });

    expect(screen.getByTestId("calendar-prev").getAttribute("href")).toBe(
      `/en/subjects/${SUBJECT_ID}/analysis/reports/MONTHLY/calendar?year=2025`,
    );
    expect(screen.getByTestId("calendar-next").getAttribute("href")).toBe(
      `/en/subjects/${SUBJECT_ID}/analysis/reports/MONTHLY/calendar?year=2027`,
    );
    // The heading is the plain year for a year viewport.
    expect(screen.getByTestId("calendar-heading").textContent).toContain(
      "2026",
    );
    // has-report month cells link with tz pinned; future months are spans.
    const may = screen.getByTestId("calendar-cell-2026-05-01");
    expect(may.tagName).toBe("A");
    expect(may.getAttribute("href")).toBe(
      `/en/subjects/${SUBJECT_ID}/analysis/reports/MONTHLY/2026-05-01?tz=Asia%2FSeoul`,
    );
    expect(screen.getByTestId("calendar-cell-2026-07-01").tagName).toBe("SPAN");
  });

  it("404s for the LIVE period (no calendar)", async () => {
    await expect(renderPage("LIVE", {})).rejects.toThrow("NEXT_NOT_FOUND");
    expect(mockLoad).not.toHaveBeenCalled();
  });

  it("404s for a malformed viewport param", async () => {
    await expect(renderPage("DAILY", { month: "2026-13" })).rejects.toThrow(
      "NEXT_NOT_FOUND",
    );
    expect(mockLoad).not.toHaveBeenCalled();
  });

  it("maps unauthorized → 404 and forbidden → 403", async () => {
    mockLoad.mockResolvedValue({ kind: "unauthorized" });
    await expect(renderPage("DAILY", { month: "2026-05" })).rejects.toThrow(
      "NEXT_NOT_FOUND",
    );

    mockLoad.mockResolvedValue({ kind: "forbidden" });
    await expect(renderPage("DAILY", { month: "2026-05" })).rejects.toThrow(
      "NEXT_FORBIDDEN",
    );
  });
});
