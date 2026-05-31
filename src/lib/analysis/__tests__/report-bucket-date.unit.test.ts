import { describe, expect, it } from "vitest";
import {
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
