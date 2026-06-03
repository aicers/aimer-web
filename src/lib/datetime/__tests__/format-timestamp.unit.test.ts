import { describe, expect, it } from "vitest";

import {
  formatTimestamp,
  isValidTimeZone,
  resolveDisplayTimeZone,
} from "../format-timestamp";

describe("isValidTimeZone", () => {
  it("accepts known IANA zones", () => {
    expect(isValidTimeZone("Asia/Seoul")).toBe(true);
    expect(isValidTimeZone("UTC")).toBe(true);
    expect(isValidTimeZone("America/New_York")).toBe(true);
  });

  it("rejects empty and bogus values", () => {
    expect(isValidTimeZone("")).toBe(false);
    expect(isValidTimeZone("Not/AZone")).toBe(false);
    expect(isValidTimeZone("Mars/Olympus")).toBe(false);
  });
});

describe("resolveDisplayTimeZone", () => {
  it("prefers a valid account timezone over the browser zone", () => {
    expect(resolveDisplayTimeZone("Asia/Seoul", "America/New_York")).toBe(
      "Asia/Seoul",
    );
  });

  it("falls back to the browser zone when no account timezone is set", () => {
    expect(resolveDisplayTimeZone(null, "America/New_York")).toBe(
      "America/New_York",
    );
    expect(resolveDisplayTimeZone(undefined, "Europe/Paris")).toBe(
      "Europe/Paris",
    );
  });

  it("skips an invalid account timezone and uses the browser zone", () => {
    expect(resolveDisplayTimeZone("Not/AZone", "Asia/Seoul")).toBe(
      "Asia/Seoul",
    );
  });

  it("falls back to UTC when neither candidate is valid", () => {
    // An explicit invalid browser zone stands in for "no readable zone"
    // (passing `undefined` would re-trigger the runtime auto-detect).
    expect(resolveDisplayTimeZone(null, "no-zone")).toBe("UTC");
    expect(resolveDisplayTimeZone("bogus", "also-bogus")).toBe("UTC");
  });
});

describe("formatTimestamp", () => {
  const instant = new Date("2026-06-03T05:05:00Z");

  it("formats in the given zone with a tz label", () => {
    // 05:05 UTC is 14:05 in Asia/Seoul (UTC+9).
    expect(formatTimestamp(instant, "Asia/Seoul")).toBe(
      "2026-06-03 14:05 GMT+9",
    );
  });

  it("formats in UTC", () => {
    expect(formatTimestamp(instant, "UTC")).toBe("2026-06-03 05:05 UTC");
  });

  it("shifts the calendar day across the date boundary", () => {
    // 05:05 UTC is the previous evening in America/New_York (EDT, UTC-4).
    expect(formatTimestamp(instant, "America/New_York")).toBe(
      "2026-06-03 01:05 EDT",
    );
  });

  it("accepts an RFC 3339 string", () => {
    expect(formatTimestamp("2026-06-03T05:05:00Z", "UTC")).toBe(
      "2026-06-03 05:05 UTC",
    );
  });

  it("pads midnight as 00:00 (24-hour clock)", () => {
    expect(formatTimestamp("2026-06-03T00:00:00Z", "UTC")).toBe(
      "2026-06-03 00:00 UTC",
    );
  });

  it("falls back to UTC for a malformed timezone instead of throwing", () => {
    expect(formatTimestamp(instant, "Not/AZone")).toBe("2026-06-03 05:05 UTC");
  });

  it("returns an empty string for an invalid date", () => {
    expect(formatTimestamp("not-a-date", "UTC")).toBe("");
  });
});
