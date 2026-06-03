import { describe, expect, it } from "vitest";
import { localeToLanguage } from "../language";

// #389 / parent #386 "Language codes": the loader/API/worker boundary maps
// app UI locales (`en` / `ko`) to the aimer `Language` enum
// (`ENGLISH` / `KOREAN`), with English as the guaranteed baseline fallback.

describe("localeToLanguage", () => {
  it("maps the known locales to their Language enum value", () => {
    expect(localeToLanguage("en")).toBe("ENGLISH");
    expect(localeToLanguage("ko")).toBe("KOREAN");
  });

  it("falls back to the English baseline for unknown / garbled locales", () => {
    expect(localeToLanguage("fr")).toBe("ENGLISH");
    expect(localeToLanguage("")).toBe("ENGLISH");
    expect(localeToLanguage("EN")).toBe("ENGLISH");
  });
});
