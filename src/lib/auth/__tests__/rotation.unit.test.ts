import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { signJwt } from "../jwt";
import { clearKeyPairCache } from "../jwt-keys";
import { maybeRotateSession } from "../rotation";

let tmpDir: string;

beforeAll(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "rotation-test-"));
  vi.stubEnv("DATA_DIR", tmpDir);
  vi.stubEnv("JWT_EXPIRATION_MINUTES", "10");
  vi.stubEnv("CSRF_SECRET", "test-csrf-secret");
  clearKeyPairCache();
});

afterAll(() => {
  vi.unstubAllEnvs();
  clearKeyPairCache();
  rmSync(tmpDir, { recursive: true, force: true });
});

describe("session rotation", () => {
  it("does not rotate when remaining > 1/3", async () => {
    const { iat, exp } = await signJwt({
      sub: "acct-1",
      sid: "sid-1",
      ctx: "general",
      tv: 0,
    });
    // Token was just created, remaining == total
    const result = await maybeRotateSession({
      claims: { sub: "acct-1", sid: "sid-1", ctx: "general", tv: 0, iat, exp },
      ctx: "general",
    });
    expect(result.rotated).toBe(false);
  });

  it("rotates when remaining <= 1/3", async () => {
    const totalSeconds = 10 * 60; // 10 minutes
    const now = Math.floor(Date.now() / 1000);
    // Simulate a token issued 8 minutes ago (remaining = 2 min, which is <= 1/3 of 10 min)
    const fakeClaims = {
      sub: "acct-1",
      sid: "sid-1",
      ctx: "general",
      tv: 0,
      iat: now - totalSeconds + 120, // 2 min remaining
      exp: now + 120,
    };

    const result = await maybeRotateSession({
      claims: fakeClaims,
      ctx: "general",
    });
    expect(result.rotated).toBe(true);
    expect(result.jwt).toBeTruthy();
    expect(result.csrfToken).toBeTruthy();
    expect(result.expiresAt).toBeGreaterThan(now);
  });

  it("generates a new CSRF token on rotation", async () => {
    const now = Math.floor(Date.now() / 1000);
    const totalSeconds = 10 * 60;
    const fakeClaims = {
      sub: "acct-1",
      sid: "sid-1",
      ctx: "general",
      tv: 0,
      iat: now - totalSeconds + 60,
      exp: now + 60,
    };

    const result = await maybeRotateSession({
      claims: fakeClaims,
      ctx: "general",
    });
    expect(result.rotated).toBe(true);
    expect(result.csrfToken).toMatch(/^[0-9a-f]{64}$/);
  });
});
