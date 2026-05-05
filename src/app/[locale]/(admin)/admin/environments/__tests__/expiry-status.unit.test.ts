import { describe, expect, it } from "vitest";

import { classifyExpiry } from "../expiry-status";

const NOW = Date.parse("2026-05-05T00:00:00Z");
const DAY_MS = 24 * 60 * 60 * 1000;

function isoFromNow(deltaDays: number): string {
  return new Date(NOW + deltaDays * DAY_MS).toISOString();
}

describe("classifyExpiry", () => {
  it("returns 'none' for null input", () => {
    expect(classifyExpiry(null, NOW)).toEqual({
      status: "none",
      days: null,
      date: null,
    });
  });

  it("returns 'none' for an unparseable string", () => {
    expect(classifyExpiry("not-a-date", NOW)).toEqual({
      status: "none",
      days: null,
      date: null,
    });
  });

  it("returns 'expired' (gray) for past timestamps", () => {
    const result = classifyExpiry(isoFromNow(-1), NOW);
    expect(result.status).toBe("expired");
  });

  it("returns 'expired' for the exact boundary (now)", () => {
    const result = classifyExpiry(new Date(NOW).toISOString(), NOW);
    expect(result.status).toBe("expired");
  });

  it("returns 'red' within 7 days of expiry", () => {
    expect(classifyExpiry(isoFromNow(1), NOW).status).toBe("red");
    expect(classifyExpiry(isoFromNow(7), NOW).status).toBe("red");
  });

  it("returns 'yellow' between 8 and 30 days", () => {
    expect(classifyExpiry(isoFromNow(8), NOW).status).toBe("yellow");
    expect(classifyExpiry(isoFromNow(30), NOW).status).toBe("yellow");
  });

  it("returns 'ok' beyond 30 days", () => {
    expect(classifyExpiry(isoFromNow(31), NOW).status).toBe("ok");
    expect(classifyExpiry(isoFromNow(365), NOW).status).toBe("ok");
  });

  it("reports days remaining (rounded up) for non-expired keys", () => {
    expect(classifyExpiry(isoFromNow(1), NOW).days).toBe(1);
    expect(classifyExpiry(isoFromNow(30), NOW).days).toBe(30);
    expect(classifyExpiry(isoFromNow(31), NOW).days).toBe(31);
  });

  it("rounds up partial days so a key 30d 1h out is still classified by the next bucket", () => {
    const justOver30 = new Date(
      NOW + 30 * DAY_MS + 60 * 60 * 1000,
    ).toISOString();
    const result = classifyExpiry(justOver30, NOW);
    expect(result.status).toBe("ok");
    expect(result.days).toBe(31);
  });
});
