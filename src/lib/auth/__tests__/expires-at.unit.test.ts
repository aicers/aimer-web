import { describe, expect, it } from "vitest";
import { parseExpiresAtInput } from "../expires-at";

describe("parseExpiresAtInput", () => {
  it("treats undefined as soft-expiry NULL", () => {
    expect(parseExpiresAtInput(undefined)).toEqual({
      ok: true,
      expiresAt: null,
    });
  });

  it("treats null as soft-expiry NULL", () => {
    expect(parseExpiresAtInput(null)).toEqual({
      ok: true,
      expiresAt: null,
    });
  });

  it("treats empty string as soft-expiry NULL", () => {
    expect(parseExpiresAtInput("")).toEqual({ ok: true, expiresAt: null });
    expect(parseExpiresAtInput("   ")).toEqual({ ok: true, expiresAt: null });
  });

  it("accepts ISO 8601 with Z suffix", () => {
    const r = parseExpiresAtInput("2026-05-05T12:00:00Z");
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.expiresAt).toBeInstanceOf(Date);
      expect(r.expiresAt?.toISOString()).toBe("2026-05-05T12:00:00.000Z");
    }
  });

  it("accepts ISO 8601 with explicit positive offset", () => {
    const r = parseExpiresAtInput("2026-05-05T21:00:00+09:00");
    expect(r.ok).toBe(true);
    if (r.ok) {
      // 21:00 in +09:00 is 12:00 UTC
      expect(r.expiresAt?.toISOString()).toBe("2026-05-05T12:00:00.000Z");
    }
  });

  it("accepts ISO 8601 with explicit negative offset", () => {
    const r = parseExpiresAtInput("2026-05-05T07:00:00-05:00");
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.expiresAt?.toISOString()).toBe("2026-05-05T12:00:00.000Z");
    }
  });

  it("accepts past timestamps (operator may burn a key)", () => {
    const r = parseExpiresAtInput("2000-01-01T00:00:00Z");
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.expiresAt?.getTime()).toBeLessThan(Date.now());
    }
  });

  it("rejects timezone-less ISO datetime", () => {
    const r = parseExpiresAtInput("2026-05-05T12:00:00");
    expect(r.ok).toBe(false);
  });

  it("rejects date-only string", () => {
    const r = parseExpiresAtInput("2026-05-05");
    expect(r.ok).toBe(false);
  });

  it("rejects out-of-range calendar date (Feb 30)", () => {
    const r = parseExpiresAtInput("2026-02-30T00:00:00Z");
    expect(r.ok).toBe(false);
  });

  it("rejects month 13", () => {
    const r = parseExpiresAtInput("2026-13-01T00:00:00Z");
    expect(r.ok).toBe(false);
  });

  it("rejects day 0", () => {
    const r = parseExpiresAtInput("2026-05-00T00:00:00Z");
    expect(r.ok).toBe(false);
  });

  it("accepts Feb 29 in a leap year", () => {
    const r = parseExpiresAtInput("2024-02-29T00:00:00Z");
    expect(r.ok).toBe(true);
  });

  it("rejects Feb 29 in a non-leap year", () => {
    const r = parseExpiresAtInput("2023-02-29T00:00:00Z");
    expect(r.ok).toBe(false);
  });

  it("rejects invalid hour", () => {
    expect(parseExpiresAtInput("2026-05-05T24:00:00Z").ok).toBe(false);
  });

  it("rejects non-string types", () => {
    expect(parseExpiresAtInput(12345 as unknown).ok).toBe(false);
    expect(parseExpiresAtInput({} as unknown).ok).toBe(false);
    expect(parseExpiresAtInput([] as unknown).ok).toBe(false);
    expect(parseExpiresAtInput(true as unknown).ok).toBe(false);
  });

  it("accepts fractional seconds", () => {
    const r = parseExpiresAtInput("2026-05-05T12:00:00.123Z");
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.expiresAt?.toISOString()).toBe("2026-05-05T12:00:00.123Z");
    }
  });
});
