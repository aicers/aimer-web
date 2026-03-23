import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { type JwtClaims, signJwt, verifyJwtForLogout } from "../jwt";
import { clearKeyPairCache } from "../jwt-keys";
import { verifyJwtStateless } from "../jwt-verify-stateless";

// Use a temporary directory for key storage during tests
let tmpDir: string;

beforeAll(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "jwt-test-"));
  vi.stubEnv("DATA_DIR", tmpDir);
  vi.stubEnv("JWT_EXPIRATION_MINUTES", "1");
  clearKeyPairCache();
});

afterAll(() => {
  vi.unstubAllEnvs();
  clearKeyPairCache();
  rmSync(tmpDir, { recursive: true, force: true });
});

const testClaims: JwtClaims = {
  sub: "00000000-0000-0000-0000-000000000001",
  sid: "00000000-0000-0000-0000-000000000002",
  ctx: "general",
  tv: 0,
};

describe("JWT sign and verify", () => {
  it("signs and verifies a token stateless", async () => {
    const { token, iat, exp } = await signJwt(testClaims);
    expect(token).toBeTruthy();
    expect(exp - iat).toBe(60); // 1 minute from env

    const verified = await verifyJwtStateless(token);
    expect(verified.sub).toBe(testClaims.sub);
    expect(verified.sid).toBe(testClaims.sid);
    expect(verified.ctx).toBe(testClaims.ctx);
    expect(verified.tv).toBe(testClaims.tv);
  });

  it("rejects tampered token", async () => {
    const { token } = await signJwt(testClaims);
    const parts = token.split(".");
    parts[1] = `${parts[1]}tampered`;
    const tampered = parts.join(".");

    await expect(verifyJwtStateless(tampered)).rejects.toThrow();
  });

  it("verifyJwtForLogout accepts valid token", async () => {
    const { token } = await signJwt(testClaims);
    const result = await verifyJwtForLogout(token);
    expect(result).not.toBeNull();
    expect(result?.sid).toBe(testClaims.sid);
  });

  it("verifyJwtForLogout returns null for tampered token", async () => {
    const result = await verifyJwtForLogout("invalid.token.here");
    expect(result).toBeNull();
  });

  it("auto-generates keys in non-production", async () => {
    // Keys were auto-generated in beforeAll via the first signJwt call.
    // Verify we can sign and verify without errors.
    const { token } = await signJwt(testClaims);
    const verified = await verifyJwtStateless(token);
    expect(verified.sub).toBe(testClaims.sub);
  });
});
