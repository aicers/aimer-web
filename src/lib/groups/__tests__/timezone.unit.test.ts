import { describe, expect, it } from "vitest";
import {
  isValidTimeZone,
  recommendMostCommonTz,
  resolveGroupTimezone,
} from "../timezone";

describe("isValidTimeZone", () => {
  // The validator must work in the project's test runtime regardless of
  // whether `Intl.supportedValuesOf` is available (it falls back to a
  // `new Intl.DateTimeFormat` probe).
  it("accepts valid IANA names", () => {
    expect(isValidTimeZone("UTC")).toBe(true);
    expect(isValidTimeZone("Asia/Seoul")).toBe(true);
    expect(isValidTimeZone("America/New_York")).toBe(true);
  });

  it("rejects invalid / empty names", () => {
    expect(isValidTimeZone("Not/AZone")).toBe(false);
    expect(isValidTimeZone("")).toBe(false);
    expect(isValidTimeZone("Mars/Phobos")).toBe(false);
  });
});

describe("recommendMostCommonTz", () => {
  it("returns the single most-common timezone", () => {
    expect(
      recommendMostCommonTz(["Asia/Seoul", "Asia/Seoul", "America/New_York"]),
    ).toBe("Asia/Seoul");
  });

  it("breaks ties by lexicographically smallest IANA name", () => {
    // Asia/Seoul vs America/New_York both appear twice → smaller name wins.
    expect(
      recommendMostCommonTz([
        "Asia/Seoul",
        "Asia/Seoul",
        "America/New_York",
        "America/New_York",
      ]),
    ).toBe("America/New_York");
  });

  it("is deterministic regardless of input order", () => {
    const a = recommendMostCommonTz(["UTC", "Asia/Seoul", "Asia/Seoul", "UTC"]);
    const b = recommendMostCommonTz(["Asia/Seoul", "UTC", "UTC", "Asia/Seoul"]);
    expect(a).toBe(b);
    expect(a).toBe("Asia/Seoul"); // tie → "Asia/Seoul" < "UTC"
  });

  it("throws on an empty list", () => {
    expect(() => recommendMostCommonTz([])).toThrow();
  });
});

describe("resolveGroupTimezone", () => {
  it("adopts the creator-chosen tz when provided", () => {
    const r = resolveGroupTimezone(["Asia/Seoul", "UTC"], "Europe/Paris");
    expect(r).toEqual({ ok: true, tz: "Europe/Paris" });
  });

  it("auto-adopts the shared tz when all members agree", () => {
    const r = resolveGroupTimezone(["Asia/Seoul", "Asia/Seoul"]);
    expect(r).toEqual({ ok: true, tz: "Asia/Seoul" });
  });

  it("requires a choice when members differ, recommending the most-common", () => {
    const r = resolveGroupTimezone(["Asia/Seoul", "Asia/Seoul", "UTC"]);
    expect(r).toEqual({ ok: false, recommendedTz: "Asia/Seoul" });
  });

  it("recommends the lexicographically smallest tz on a tie", () => {
    const r = resolveGroupTimezone(["UTC", "Asia/Seoul"]);
    expect(r).toEqual({ ok: false, recommendedTz: "Asia/Seoul" });
  });
});
