import { describe, expect, it } from "vitest";
import {
  addCalendarDays,
  enumerateMonthDays,
  enumerateYearMonths,
  enumerateYearWeeks,
  formatDayInTz,
  isValidBucketDate,
  LIVE_BUCKET_DATE,
  periodBucketDate,
} from "../report-bucket-date";

describe("periodBucketDate (RFC 0002 Phase 3 / #298)", () => {
  it("LIVE always resolves to the synthetic epoch bucket", () => {
    expect(periodBucketDate("LIVE", "2026-05-26")).toBe(LIVE_BUCKET_DATE);
    // …regardless of an unparseable reference.
    expect(periodBucketDate("LIVE", "not-a-date")).toBe(LIVE_BUCKET_DATE);
  });

  it("DAILY returns the reference day unchanged", () => {
    expect(periodBucketDate("DAILY", "2026-05-26")).toBe("2026-05-26");
  });

  it("MONTHLY returns the first of the reference month", () => {
    expect(periodBucketDate("MONTHLY", "2026-05-26")).toBe("2026-05-01");
    expect(periodBucketDate("MONTHLY", "2026-01-01")).toBe("2026-01-01");
    expect(periodBucketDate("MONTHLY", "2026-12-31")).toBe("2026-12-01");
  });

  it("WEEKLY snaps back to the ISO Monday of the reference week", () => {
    // 2026-05-25 is a Monday → unchanged.
    expect(periodBucketDate("WEEKLY", "2026-05-25")).toBe("2026-05-25");
    // 2026-05-26 (Tue) … 2026-05-31 (Sun) all map to Monday 2026-05-25.
    expect(periodBucketDate("WEEKLY", "2026-05-26")).toBe("2026-05-25");
    expect(periodBucketDate("WEEKLY", "2026-05-31")).toBe("2026-05-25");
    // Crossing a month boundary backwards.
    expect(periodBucketDate("WEEKLY", "2026-06-01")).toBe("2026-06-01"); // Mon
    expect(periodBucketDate("WEEKLY", "2026-03-01")).toBe("2026-02-23"); // Sun
  });

  it("handles the leap-day reference (2024-02-29)", () => {
    // 2024 is a leap year, so 2024-02-29 is a real day (a Thursday).
    expect(periodBucketDate("DAILY", "2024-02-29")).toBe("2024-02-29");
    expect(periodBucketDate("MONTHLY", "2024-02-29")).toBe("2024-02-01");
    // ISO Monday of that week is 2024-02-26.
    expect(periodBucketDate("WEEKLY", "2024-02-29")).toBe("2024-02-26");
    // The same date in a non-leap year is impossible → null.
    expect(periodBucketDate("DAILY", "2023-02-29")).toBeNull();
  });

  it("returns null for an invalid (non-LIVE) reference date", () => {
    expect(periodBucketDate("DAILY", "2026-02-31")).toBeNull();
    expect(periodBucketDate("WEEKLY", "garbage")).toBeNull();
  });

  it("isValidBucketDate still gates impossible days", () => {
    expect(isValidBucketDate("2026-02-31")).toBe(false);
    expect(isValidBucketDate("2026-05-26")).toBe(true);
    // Leap-day validity is year-sensitive.
    expect(isValidBucketDate("2024-02-29")).toBe(true);
    expect(isValidBucketDate("2023-02-29")).toBe(false);
  });
});

describe("calendar-day helpers (#505)", () => {
  it("addCalendarDays crosses month and year boundaries", () => {
    expect(addCalendarDays("2026-06-09", -30)).toBe("2026-05-10");
    expect(addCalendarDays("2026-03-01", -1)).toBe("2026-02-28");
    expect(addCalendarDays("2024-03-01", -1)).toBe("2024-02-29"); // leap year
    expect(addCalendarDays("2026-05-11", 6)).toBe("2026-05-17");
    expect(addCalendarDays("2025-12-31", 1)).toBe("2026-01-01");
    // Invalid input is returned unchanged.
    expect(addCalendarDays("garbage", 1)).toBe("garbage");
  });

  it("enumerateMonthDays lists every day of the month", () => {
    expect(enumerateMonthDays(2026, 2)).toHaveLength(28);
    expect(enumerateMonthDays(2024, 2)).toHaveLength(29); // leap February
    const may = enumerateMonthDays(2026, 5);
    expect(may).toHaveLength(31);
    expect(may[0]).toBe("2026-05-01");
    expect(may[30]).toBe("2026-05-31");
  });

  it("enumerateYearMonths lists twelve month starts", () => {
    const months = enumerateYearMonths(2026);
    expect(months).toHaveLength(12);
    expect(months[0]).toBe("2026-01-01");
    expect(months[11]).toBe("2026-12-01");
  });

  it("enumerateYearWeeks lists Mondays whose own year matches", () => {
    const weeks = enumerateYearWeeks(2026);
    expect(weeks.length).toBeGreaterThanOrEqual(52);
    // Every entry is a Monday in 2026.
    for (const w of weeks) {
      const [y, m, d] = w.split("-").map(Number);
      const dt = new Date(Date.UTC(y, m - 1, d));
      expect(dt.getUTCDay()).toBe(1); // Monday
      expect(dt.getUTCFullYear()).toBe(2026);
    }
  });

  it("formatDayInTz renders the local calendar day, UTC on a bad tz", () => {
    // 2026-06-09T23:00Z is already 2026-06-10 in Asia/Seoul (UTC+9).
    const at = new Date("2026-06-09T23:00:00Z");
    expect(formatDayInTz(at, "Asia/Seoul")).toBe("2026-06-10");
    expect(formatDayInTz(at, "UTC")).toBe("2026-06-09");
    expect(formatDayInTz(at, "Not/AZone")).toBe("2026-06-09");
  });
});
