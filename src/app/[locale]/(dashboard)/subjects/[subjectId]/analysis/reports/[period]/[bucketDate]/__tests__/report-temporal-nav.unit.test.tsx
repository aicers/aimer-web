// @vitest-environment jsdom
//
// #505 — within-period prev/next nav. Verifies:
//   - prev/next render as detail links with `?tz` pinned
//   - a missing prev renders the explicit retention-boundary stop ONLY when
//     `olderStop` is set, not a link
//   - a missing prev with `olderStop` false (the first report) renders no
//     affordance, never a false "no older retained" claim
//   - a missing next renders no "next" affordance
//   - the calendar entry link is always present

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

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

import { ReportTemporalNav } from "../report-temporal-nav";

const SUBJECT_ID = "c0000000-0000-0000-0000-000000000001";
const LABELS = {
  navLabel: "Report history",
  prev: "Previous report",
  next: "Next report",
  noOlderRetained: "No older reports retained",
  openCalendar: "Open calendar",
};

afterEach(() => cleanup());

describe("ReportTemporalNav", () => {
  it("renders prev/next links with tz pinned", () => {
    render(
      <ReportTemporalNav
        locale="en"
        subjectId={SUBJECT_ID}
        period="DAILY"
        prev={{ bucketDate: "2026-05-12", tz: "Asia/Seoul" }}
        next={{ bucketDate: "2026-05-20", tz: "Asia/Seoul" }}
        olderStop={false}
        calendarHref={`/en/subjects/${SUBJECT_ID}/analysis/reports/DAILY/calendar`}
        labels={LABELS}
      />,
    );
    expect(screen.getByTestId("temporal-prev").getAttribute("href")).toBe(
      `/en/subjects/${SUBJECT_ID}/analysis/reports/DAILY/2026-05-12?tz=Asia%2FSeoul`,
    );
    expect(screen.getByTestId("temporal-next").getAttribute("href")).toBe(
      `/en/subjects/${SUBJECT_ID}/analysis/reports/DAILY/2026-05-20?tz=Asia%2FSeoul`,
    );
    expect(screen.getByTestId("temporal-calendar-link")).toBeTruthy();
  });

  it("shows the retention-boundary stop only when olderStop is set", () => {
    render(
      <ReportTemporalNav
        locale="en"
        subjectId={SUBJECT_ID}
        period="WEEKLY"
        prev={null}
        next={{ bucketDate: "2026-05-25", tz: "UTC" }}
        olderStop={true}
        calendarHref="/cal"
        labels={LABELS}
      />,
    );
    expect(screen.queryByTestId("temporal-prev")).toBeNull();
    const stop = screen.getByTestId("temporal-prev-stop");
    expect(stop.textContent).toContain("No older reports retained");
    expect(stop.getAttribute("aria-disabled")).toBe("true");
  });

  it("renders no affordance for the first report (olderStop false)", () => {
    // prev is null but NOT because of retention — the open bucket is the
    // oldest report (or retention is unbounded). The component must not claim
    // "no older reports retained"; it shows nothing on the older side.
    render(
      <ReportTemporalNav
        locale="en"
        subjectId={SUBJECT_ID}
        period="DAILY"
        prev={null}
        next={{ bucketDate: "2026-05-25", tz: "UTC" }}
        olderStop={false}
        calendarHref="/cal"
        labels={LABELS}
      />,
    );
    expect(screen.queryByTestId("temporal-prev")).toBeNull();
    expect(screen.queryByTestId("temporal-prev-stop")).toBeNull();
    expect(screen.getByTestId("temporal-next")).toBeTruthy();
  });

  it("renders no next affordance at the newest report", () => {
    render(
      <ReportTemporalNav
        locale="en"
        subjectId={SUBJECT_ID}
        period="MONTHLY"
        prev={{ bucketDate: "2026-04-01", tz: "UTC" }}
        next={null}
        olderStop={false}
        calendarHref="/cal"
        labels={LABELS}
      />,
    );
    expect(screen.queryByTestId("temporal-next")).toBeNull();
    expect(screen.getByTestId("temporal-prev")).toBeTruthy();
  });
});
