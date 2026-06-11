import { describe, expect, it } from "vitest";

import {
  formatDateTime,
  formatDateTimeCompact,
  formatDateTimePremount,
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

// The instant carries non-zero seconds so the "seconds present / absent"
// distinction between the general and compact formats is observable.
const instant = new Date("2026-06-03T05:05:30Z");

describe("formatDateTime (general)", () => {
  // The general format follows the *browser* locale (`undefined`), so the
  // exact separators are environment-dependent. Assert parity by
  // construction against aice-web-next's exact `toLocaleString` call, then
  // pin the locale-independent essentials.
  const reference = (tz: string): string =>
    instant.toLocaleString(undefined, {
      timeZone: tz,
      year: "numeric",
      month: "numeric",
      day: "numeric",
      hour: "numeric",
      minute: "numeric",
      second: "numeric",
    });

  it("matches aice-web-next's formatDateTime construction byte-for-byte", () => {
    for (const tz of ["Asia/Seoul", "UTC", "America/New_York"]) {
      expect(formatDateTime(instant, tz)).toBe(reference(tz));
    }
  });

  it("includes the year and the seconds", () => {
    const out = formatDateTime(instant, "UTC");
    expect(out).toContain("2026");
    expect(out).toContain("30"); // the seconds component
  });

  it("carries no timezone label", () => {
    const out = formatDateTime(instant, "Asia/Seoul");
    expect(out).not.toMatch(/GMT|UTC|KST/);
  });

  it("honours the timezone (Seoul is UTC+9, ahead of UTC)", () => {
    // 05:05 UTC is 14:05 in Asia/Seoul — the rendered hour must differ.
    expect(formatDateTime(instant, "Asia/Seoul")).not.toBe(
      formatDateTime(instant, "UTC"),
    );
  });

  it("accepts an RFC 3339 string equivalently to a Date", () => {
    expect(formatDateTime("2026-06-03T05:05:30Z", "UTC")).toBe(
      formatDateTime(instant, "UTC"),
    );
  });
});

describe("formatDateTimeCompact (compact)", () => {
  it("follows the explicit locale and drops year + seconds", () => {
    // Explicit locale ⇒ stable, environment-independent strings.
    // 05:05:30 UTC is 14:05 in Asia/Seoul.
    expect(formatDateTimeCompact(instant, "Asia/Seoul", "en")).toBe(
      "6/3, 2:05 PM",
    );
    expect(formatDateTimeCompact(instant, "Asia/Seoul", "ko")).toBe(
      "6. 3. 오후 2:05",
    );
  });

  it("omits the year and the seconds", () => {
    const out = formatDateTimeCompact(instant, "UTC", "en");
    expect(out).not.toContain("2026");
    expect(out).not.toContain("30"); // no seconds
  });

  it("honours the locale (en differs from ko)", () => {
    expect(formatDateTimeCompact(instant, "Asia/Seoul", "en")).not.toBe(
      formatDateTimeCompact(instant, "Asia/Seoul", "ko"),
    );
  });

  it("honours the timezone", () => {
    expect(formatDateTimeCompact(instant, "Asia/Seoul", "en")).not.toBe(
      formatDateTimeCompact(instant, "UTC", "en"),
    );
  });
});

describe("formatDateTimePremount (deterministic first paint)", () => {
  it("renders a fixed en-US/UTC general value regardless of host locale", () => {
    expect(formatDateTimePremount(instant)).toBe("6/3/2026, 5:05:30 AM");
    expect(formatDateTimePremount("2026-06-03T05:05:30Z")).toBe(
      "6/3/2026, 5:05:30 AM",
    );
  });

  it("renders a fixed en-US/UTC compact value when compact", () => {
    expect(formatDateTimePremount(instant, true)).toBe("6/3, 5:05 AM");
  });
});
