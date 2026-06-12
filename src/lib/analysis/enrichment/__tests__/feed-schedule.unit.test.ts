// RFC 0003 self-fetch scheduler (3b, #570) — schedule config pure helpers.

import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import {
  coerceSchedule,
  effectiveCadenceMs,
  parseScheduleInput,
} from "../feed-schedule";

describe("coerceSchedule (defensive read)", () => {
  it("coerces a non-object to disabled", () => {
    expect(coerceSchedule(null)).toEqual({ enabled: false });
    expect(coerceSchedule("nope")).toEqual({ enabled: false });
    expect(coerceSchedule(42)).toEqual({ enabled: false });
    expect(coerceSchedule([])).toEqual({ enabled: false });
  });

  it("coerces a missing/invalid enabled to disabled", () => {
    expect(coerceSchedule({})).toEqual({ enabled: false });
    expect(coerceSchedule({ enabled: "yes" })).toEqual({ enabled: false });
  });

  it("keeps a valid enabled value", () => {
    expect(coerceSchedule({ enabled: true })).toEqual({ enabled: true });
    expect(coerceSchedule({ enabled: false })).toEqual({ enabled: false });
  });

  it("keeps a positive intervalMs and floors it", () => {
    expect(coerceSchedule({ enabled: true, intervalMs: 60000 })).toEqual({
      enabled: true,
      intervalMs: 60000,
    });
    expect(coerceSchedule({ enabled: true, intervalMs: 1000.7 })).toEqual({
      enabled: true,
      intervalMs: 1000,
    });
  });

  it("drops a malformed intervalMs but keeps enabled", () => {
    expect(coerceSchedule({ enabled: true, intervalMs: -5 })).toEqual({
      enabled: true,
    });
    expect(coerceSchedule({ enabled: true, intervalMs: "x" })).toEqual({
      enabled: true,
    });
    expect(coerceSchedule({ enabled: true, intervalMs: 0 })).toEqual({
      enabled: true,
    });
  });
});

describe("parseScheduleInput (strict write)", () => {
  it("rejects a non-object body", () => {
    expect(() => parseScheduleInput(null)).toThrow();
    expect(() => parseScheduleInput([])).toThrow();
  });

  it("requires a boolean enabled", () => {
    expect(() => parseScheduleInput({})).toThrow();
    expect(() => parseScheduleInput({ enabled: "true" })).toThrow();
  });

  it("accepts enabled without intervalMs", () => {
    expect(parseScheduleInput({ enabled: true })).toEqual({ enabled: true });
    expect(parseScheduleInput({ enabled: false })).toEqual({ enabled: false });
  });

  it("accepts a positive intervalMs", () => {
    expect(parseScheduleInput({ enabled: true, intervalMs: 60000 })).toEqual({
      enabled: true,
      intervalMs: 60000,
    });
  });

  it("treats null intervalMs as unset", () => {
    expect(parseScheduleInput({ enabled: true, intervalMs: null })).toEqual({
      enabled: true,
    });
  });

  it("rejects a non-positive or non-numeric intervalMs", () => {
    expect(() =>
      parseScheduleInput({ enabled: true, intervalMs: 0 }),
    ).toThrow();
    expect(() =>
      parseScheduleInput({ enabled: true, intervalMs: -1 }),
    ).toThrow();
    expect(() =>
      parseScheduleInput({ enabled: true, intervalMs: "x" }),
    ).toThrow();
  });
});

describe("effectiveCadenceMs", () => {
  const FLOOR = 5 * 60 * 1000;

  it("uses the floor when intervalMs is unset", () => {
    expect(effectiveCadenceMs(undefined, FLOOR)).toBe(FLOOR);
  });

  it("clamps a sub-floor interval up to the floor", () => {
    expect(effectiveCadenceMs(60_000, FLOOR)).toBe(FLOOR);
  });

  it("keeps an interval wider than the floor", () => {
    expect(effectiveCadenceMs(30 * 60 * 1000, FLOOR)).toBe(30 * 60 * 1000);
  });
});
