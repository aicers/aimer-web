import { describe, expect, it } from "vitest";

import {
  DEFAULT_TIME_FORMAT,
  footprintCh,
  formatDateTime,
  formatDateTimeCompact,
  isTimeFormatLocale,
  isValidTimeZone,
  reservedWidthCh,
  resolveDisplayTimeZone,
  resolveTimeFormat,
  TIME_FORMAT_LOCALE_APP,
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

// ---------------------------------------------------------------------------
// User-selectable display format (#556)
// ---------------------------------------------------------------------------

describe("isTimeFormatLocale", () => {
  it("accepts the 'app' sentinel and curated tags", () => {
    expect(isTimeFormatLocale(TIME_FORMAT_LOCALE_APP)).toBe(true);
    expect(isTimeFormatLocale("en-US")).toBe(true);
    expect(isTimeFormatLocale("ko-KR")).toBe(true);
    expect(isTimeFormatLocale("en-GB")).toBe(true);
  });

  it("rejects values outside the list and non-strings", () => {
    expect(isTimeFormatLocale("en")).toBe(false); // bare app-locale, not a tag
    expect(isTimeFormatLocale("xx-YY")).toBe(false);
    expect(isTimeFormatLocale(null)).toBe(false);
    expect(isTimeFormatLocale(42)).toBe(false);
  });
});

describe("resolveTimeFormat", () => {
  it("maps null/absent input to the aice-matched default", () => {
    expect(resolveTimeFormat(null, "en")).toEqual(DEFAULT_TIME_FORMAT);
    expect(resolveTimeFormat(undefined, "ko")).toEqual(DEFAULT_TIME_FORMAT);
  });

  it("resolves the locale: null = browser, 'app' = app locale, tag = tag", () => {
    expect(
      resolveTimeFormat(
        { locale: null, hourCycle: null, seconds: null, tzLabel: null },
        "ko",
      ).locale,
    ).toBeUndefined();
    expect(
      resolveTimeFormat(
        {
          locale: TIME_FORMAT_LOCALE_APP,
          hourCycle: null,
          seconds: null,
          tzLabel: null,
        },
        "ko",
      ).locale,
    ).toBe("ko");
    expect(
      resolveTimeFormat(
        { locale: "en-GB", hourCycle: null, seconds: null, tzLabel: null },
        "ko",
      ).locale,
    ).toBe("en-GB");
  });

  it("maps the boolean defaults: seconds show, tz label hide", () => {
    const r = resolveTimeFormat(
      { locale: null, hourCycle: null, seconds: null, tzLabel: null },
      "en",
    );
    expect(r.seconds).toBe(true);
    expect(r.tzLabel).toBe(false);
    expect(r.hourCycle).toBeUndefined();
  });

  it("carries explicit choices through", () => {
    const r = resolveTimeFormat(
      { locale: "en-US", hourCycle: "h23", seconds: false, tzLabel: true },
      "en",
    );
    expect(r).toEqual({
      locale: "en-US",
      hourCycle: "h23",
      seconds: false,
      tzLabel: true,
    });
  });
});

describe("formatDateTime with resolved options (#556)", () => {
  it("with the default options is byte-identical to the no-options call", () => {
    for (const tz of ["Asia/Seoul", "UTC", "America/New_York"]) {
      expect(formatDateTime(instant, tz, DEFAULT_TIME_FORMAT)).toBe(
        formatDateTime(instant, tz),
      );
    }
  });

  it("honours an explicit hour cycle (h23 has no AM/PM, h12 does)", () => {
    const h23 = formatDateTime(instant, "Asia/Seoul", {
      locale: "en-US",
      hourCycle: "h23",
      seconds: true,
      tzLabel: false,
    });
    const h12 = formatDateTime(instant, "Asia/Seoul", {
      locale: "en-US",
      hourCycle: "h12",
      seconds: true,
      tzLabel: false,
    });
    expect(h23).toContain("14:05:30");
    expect(h23).not.toMatch(/AM|PM/);
    expect(h12).toMatch(/PM/);
  });

  it("hides the seconds when seconds = false", () => {
    const withSec = formatDateTime(instant, "UTC", {
      locale: "en-US",
      hourCycle: undefined,
      seconds: true,
      tzLabel: false,
    });
    const noSec = formatDateTime(instant, "UTC", {
      locale: "en-US",
      hourCycle: undefined,
      seconds: false,
      tzLabel: false,
    });
    expect(withSec).toContain(":30");
    expect(noSec).not.toContain(":30");
  });

  it("appends the GMT-offset label when tzLabel = true", () => {
    const labelled = formatDateTime(instant, "Asia/Seoul", {
      locale: "en-US",
      hourCycle: undefined,
      seconds: true,
      tzLabel: true,
    });
    expect(labelled).toContain("GMT+9");
    // The offset form, never a locale/runtime abbreviation.
    expect(labelled).not.toMatch(/KST|PST/);
  });

  it("follows an explicit formatting locale (en-GB is day-first, 24h)", () => {
    const gb = formatDateTime(instant, "Asia/Seoul", {
      locale: "en-GB",
      hourCycle: undefined,
      seconds: true,
      tzLabel: false,
    });
    // 14:05 in Asia/Seoul on 2026-06-03 → en-GB renders day/month/year, 24h.
    expect(gb).toBe("03/06/2026, 14:05:30");
  });
});

describe("formatDateTimeCompact invariance (#556)", () => {
  // Compact honours locale + hour cycle ONLY; seconds and tz-label prefs have
  // no effect (year/seconds/tz label are always omitted in compact).
  it("ignores seconds and tz-label options entirely", () => {
    const base = formatDateTimeCompact(instant, "Asia/Seoul", "en");
    // The compact API exposes only `hourCycle`; passing it empty is the
    // default. Seconds/tz-label are not part of the compact options at all.
    expect(formatDateTimeCompact(instant, "Asia/Seoul", "en", {})).toBe(base);
    expect(base).not.toContain(":30"); // never any seconds
    expect(base).not.toMatch(/GMT/); // never a tz label
  });

  it("honours the hour cycle (h23 drops AM/PM)", () => {
    const h12 = formatDateTimeCompact(instant, "Asia/Seoul", "en", {
      hourCycle: "h12",
    });
    const h23 = formatDateTimeCompact(instant, "Asia/Seoul", "en", {
      hourCycle: "h23",
    });
    expect(h12).toMatch(/PM/);
    expect(h23).toContain("14:05");
    expect(h23).not.toMatch(/AM|PM/);
  });
});

describe("reservedWidthCh (#556)", () => {
  it("reproduces the pre-#556 default reservations (28ch / 19ch)", () => {
    expect(reservedWidthCh("general", DEFAULT_TIME_FORMAT)).toBe(28);
    expect(reservedWidthCh("compact", DEFAULT_TIME_FORMAT)).toBe(19);
  });

  it("covers the worst-case footprint for the chosen general options", () => {
    const worst = new Date("2026-12-31T14:59:59Z"); // 23:59:59 in Asia/Seoul
    for (const opts of [
      DEFAULT_TIME_FORMAT,
      {
        locale: undefined,
        hourCycle: "h23" as const,
        seconds: true,
        tzLabel: true,
      },
      {
        locale: "ko-KR",
        hourCycle: "h23" as const,
        seconds: true,
        tzLabel: true,
      },
    ]) {
      const reserved = reservedWidthCh("general", opts);
      for (const locale of opts.locale ? [opts.locale] : ["en-US", "ko"]) {
        const rendered = formatDateTime(worst, "Asia/Seoul", {
          ...opts,
          locale,
        });
        expect(footprintCh(rendered)).toBeLessThanOrEqual(reserved);
      }
    }
  });

  it("grows when a wider format is chosen (tz label + 24h spelled-out ko)", () => {
    const wide = reservedWidthCh("general", {
      locale: undefined,
      hourCycle: "h23",
      seconds: true,
      tzLabel: true,
    });
    expect(wide).toBeGreaterThan(
      reservedWidthCh("general", DEFAULT_TIME_FORMAT),
    );
  });
});
