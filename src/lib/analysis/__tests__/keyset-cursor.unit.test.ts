// WS3 (#392) — opaque keyset cursor codec.

import { describe, expect, it } from "vitest";
import { decodeCursor, encodeCursor } from "../keyset-cursor";

interface Sample {
  pr: number;
  rt: string;
}

function isSample(value: unknown): value is Sample {
  if (typeof value !== "object" || value === null) return false;
  const c = value as Record<string, unknown>;
  return typeof c.pr === "number" && typeof c.rt === "string";
}

describe("keyset cursor codec", () => {
  it("round-trips a payload through encode/decode", () => {
    const payload: Sample = { pr: 4, rt: "2026-05-27T12:00:00.123456+00:00" };
    const decoded = decodeCursor(encodeCursor(payload), isSample);
    expect(decoded).toEqual(payload);
  });

  it("preserves full double precision for float ordering keys", () => {
    const payload = { pr: 0.123456789012345, rt: "x" };
    const decoded = decodeCursor(encodeCursor(payload), isSample);
    expect(decoded?.pr).toBe(0.123456789012345);
  });

  it("returns null for a missing cursor", () => {
    expect(decodeCursor(null, isSample)).toBeNull();
    expect(decodeCursor(undefined, isSample)).toBeNull();
    expect(decodeCursor("", isSample)).toBeNull();
  });

  it("returns null for a malformed (non-base64/non-JSON) token", () => {
    expect(decodeCursor("!!!not-base64!!!", isSample)).toBeNull();
    expect(decodeCursor(encodeCursor("not-an-object"), isSample)).toBeNull();
  });

  it("returns null when the decoded shape fails validation", () => {
    expect(decodeCursor(encodeCursor({ pr: "nope" }), isSample)).toBeNull();
    expect(decodeCursor(encodeCursor({ rt: "x" }), isSample)).toBeNull();
  });

  it("produces a URL-safe token (base64url, no +/=)", () => {
    const token = encodeCursor({ pr: 1, rt: "a/b+c=" });
    expect(token).toMatch(/^[A-Za-z0-9_-]+$/);
  });
});
