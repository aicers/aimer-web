import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { generateCsrf, validateCsrf } from "../csrf";

beforeAll(() => {
  vi.stubEnv("CSRF_SECRET", "test-secret-for-csrf-tests");
});

afterAll(() => {
  vi.unstubAllEnvs();
});

describe("CSRF", () => {
  const params = { ctx: "general" as const, sid: "test-sid", iat: 1700000000 };

  it("generates a deterministic hex token", () => {
    const a = generateCsrf(params);
    const b = generateCsrf(params);
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
  });

  it("validates a correct token", () => {
    const token = generateCsrf(params);
    expect(validateCsrf({ token, ...params })).toBe(true);
  });

  it("rejects a wrong token", () => {
    expect(validateCsrf({ token: "wrong", ...params })).toBe(false);
  });

  it("produces different tokens for different contexts", () => {
    const general = generateCsrf(params);
    const admin = generateCsrf({ ...params, ctx: "admin" });
    expect(general).not.toBe(admin);
  });

  it("produces different tokens for different iat values", () => {
    const a = generateCsrf(params);
    const b = generateCsrf({ ...params, iat: 1700000001 });
    expect(a).not.toBe(b);
  });
});
