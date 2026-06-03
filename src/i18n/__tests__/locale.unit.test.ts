import { describe, expect, it } from "vitest";
import {
  appLocaleToReportLanguage,
  isSupportedLocale,
  isValidTimeZone,
  reportLanguageToAppLocale,
} from "../locale";

describe("isSupportedLocale", () => {
  it("accepts supported app locales", () => {
    expect(isSupportedLocale("en")).toBe(true);
    expect(isSupportedLocale("ko")).toBe(true);
  });

  it("rejects unsupported or malformed values", () => {
    expect(isSupportedLocale("fr")).toBe(false);
    expect(isSupportedLocale("EN")).toBe(false);
    expect(isSupportedLocale("")).toBe(false);
    expect(isSupportedLocale(null)).toBe(false);
    expect(isSupportedLocale(undefined)).toBe(false);
    expect(isSupportedLocale(1)).toBe(false);
  });
});

describe("app locale ↔ report language mapping", () => {
  it("maps app locale to report language", () => {
    expect(appLocaleToReportLanguage("en")).toBe("ENGLISH");
    expect(appLocaleToReportLanguage("ko")).toBe("KOREAN");
  });

  it("maps report language to app locale", () => {
    expect(reportLanguageToAppLocale("ENGLISH")).toBe("en");
    expect(reportLanguageToAppLocale("KOREAN")).toBe("ko");
  });

  it("round-trips both directions", () => {
    for (const locale of ["en", "ko"] as const) {
      expect(reportLanguageToAppLocale(appLocaleToReportLanguage(locale))).toBe(
        locale,
      );
    }
  });
});

describe("isValidTimeZone", () => {
  it("accepts real IANA zones", () => {
    expect(isValidTimeZone("Asia/Seoul")).toBe(true);
    expect(isValidTimeZone("America/New_York")).toBe(true);
    expect(isValidTimeZone("UTC")).toBe(true);
  });

  it("rejects unknown zones and non-strings", () => {
    expect(isValidTimeZone("Mars/Phobos")).toBe(false);
    expect(isValidTimeZone("Not A Zone")).toBe(false);
    expect(isValidTimeZone("")).toBe(false);
    expect(isValidTimeZone(null)).toBe(false);
    expect(isValidTimeZone(42)).toBe(false);
  });
});
