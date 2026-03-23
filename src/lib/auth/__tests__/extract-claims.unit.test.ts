import { describe, expect, it } from "vitest";
import { extractClaims } from "../jwt";

describe("extractClaims", () => {
  const validPayload = {
    sub: "account-id",
    sid: "session-id",
    ctx: "general",
    tv: 0,
    iat: 1700000000,
    exp: 1700000900,
  };

  it("extracts valid claims", () => {
    const result = extractClaims(validPayload);
    expect(result.sub).toBe("account-id");
    expect(result.sid).toBe("session-id");
    expect(result.ctx).toBe("general");
    expect(result.tv).toBe(0);
    expect(result.iat).toBe(1700000000);
    expect(result.exp).toBe(1700000900);
  });

  it("throws when sub is missing", () => {
    expect(() => extractClaims({ ...validPayload, sub: undefined })).toThrow(
      "JWT missing required claims",
    );
  });

  it("throws when sid is missing", () => {
    expect(() => extractClaims({ ...validPayload, sid: undefined })).toThrow(
      "JWT missing required claims",
    );
  });

  it("throws when ctx is missing", () => {
    expect(() => extractClaims({ ...validPayload, ctx: undefined })).toThrow(
      "JWT missing required claims",
    );
  });

  it("throws when tv is wrong type", () => {
    expect(() =>
      extractClaims({ ...validPayload, tv: "not-a-number" }),
    ).toThrow("JWT missing required claims");
  });

  it("throws when iat is missing", () => {
    expect(() => extractClaims({ ...validPayload, iat: undefined })).toThrow(
      "JWT missing required claims",
    );
  });

  it("throws when exp is missing", () => {
    expect(() => extractClaims({ ...validPayload, exp: undefined })).toThrow(
      "JWT missing required claims",
    );
  });
});
