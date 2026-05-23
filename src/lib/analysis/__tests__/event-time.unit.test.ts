import { describe, expect, it } from "vitest";
import { parseEventTime } from "../event-time";

describe("parseEventTime — accept", () => {
  it("returns the original string for a well-formed UTC `Z` value", () => {
    const input = "2026-05-23T05:14:22Z";
    expect(parseEventTime(input)).toBe(input);
  });

  it("returns the original string for a positive `+HH:MM` offset", () => {
    const input = "2026-05-23T14:14:22+09:00";
    expect(parseEventTime(input)).toBe(input);
  });

  it("returns the original string for a negative `-HH:MM` offset", () => {
    const input = "2026-05-22T22:14:22-07:00";
    expect(parseEventTime(input)).toBe(input);
  });

  it("preserves fractional seconds verbatim up to nanosecond precision", () => {
    // Upstream `jiff::Timestamp` accepts up to 9 fractional digits;
    // passing the input through untouched within that ceiling lets
    // aimer's formatter render whatever resolution the source supplied.
    const input = "2026-05-23T05:14:22.123456789Z";
    expect(parseEventTime(input)).toBe(input);
  });

  it.each([
    ["1 fractional digit", "2026-05-23T05:14:22.1Z"],
    ["3 fractional digits (milliseconds)", "2026-05-23T05:14:22.123Z"],
    ["6 fractional digits (microseconds)", "2026-05-23T05:14:22.123456Z"],
  ])("accepts %s", (_label, input) => {
    expect(parseEventTime(input)).toBe(input);
  });

  it("accepts year boundaries that are valid leap years (Feb 29 on a leap year)", () => {
    const input = "2024-02-29T00:00:00Z";
    expect(parseEventTime(input)).toBe(input);
  });
});

describe("parseEventTime — reject (input shape)", () => {
  it.each([
    ["missing (undefined)", undefined],
    ["missing (null)", null],
    ["empty string", ""],
    ["a number", 1779789600],
    ["a bigint", BigInt("1779789600")],
    ["an object", { iso: "2026-05-23T05:14:22Z" }],
  ])("rejects %s", (_label, raw) => {
    expect(parseEventTime(raw)).toBeNull();
  });

  it.each([
    ["space separator instead of T", "2026-05-23 05:14:22Z"],
    ["no offset (naive local time)", "2026-05-23T05:14:22"],
    ["lowercase t separator", "2026-05-23t05:14:22Z"],
    ["lowercase z offset", "2026-05-23T05:14:22z"],
    ["date only", "2026-05-23"],
    ["time only", "05:14:22Z"],
    ["+HHMM offset without colon", "2026-05-23T14:14:22+0900"],
    ["partial offset", "2026-05-23T14:14:22+09"],
    ["trailing garbage", "2026-05-23T05:14:22Zoops"],
    // Over-precision: upstream `jiff::Timestamp` is nanosecond
    // precision (9 fractional digits) and rejects anything finer.
    // Catching it here keeps the bad value out of the ingest path so
    // it cannot get stored in `redacted_event.event_time` and win
    // over corrected request values on later retries.
    ["10 fractional digits", "2026-05-23T05:14:22.1234567890Z"],
    ["12 fractional digits", "2026-05-23T05:14:22.123456789123Z"],
    ["trailing dot, no digits", "2026-05-23T05:14:22.Z"],
  ])("rejects shape-malformed: %s", (_label, raw) => {
    expect(parseEventTime(raw)).toBeNull();
  });
});

describe("parseEventTime — reject (calendar)", () => {
  it.each([
    ["month 13", "2026-13-01T00:00:00Z"],
    ["month 00", "2026-00-15T00:00:00Z"],
    ["Feb 30 (non-existent)", "2026-02-30T00:00:00Z"],
    ["Feb 29 on a non-leap year", "2026-02-29T00:00:00Z"],
    ["Apr 31 (30-day month)", "2026-04-31T00:00:00Z"],
    ["day 32", "2026-05-32T00:00:00Z"],
    ["hour 24", "2026-05-23T24:00:00Z"],
    ["minute 60", "2026-05-23T00:60:00Z"],
    ["second 60 (no leap-second support)", "2026-05-23T00:00:60Z"],
  ])("rejects calendar-invalid: %s", (_label, raw) => {
    expect(parseEventTime(raw)).toBeNull();
  });

  it("rejects out-of-range numeric offset hour", () => {
    expect(parseEventTime("2026-05-23T05:14:22+24:00")).toBeNull();
  });

  it("rejects out-of-range numeric offset minute", () => {
    expect(parseEventTime("2026-05-23T05:14:22+09:60")).toBeNull();
  });
});
