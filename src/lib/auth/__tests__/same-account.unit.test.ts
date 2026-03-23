import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { signJwt } from "../jwt";
import { clearKeyPairCache } from "../jwt-keys";

let tmpDir: string;

beforeAll(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "same-account-test-"));
  vi.stubEnv("DATA_DIR", tmpDir);
  vi.stubEnv("JWT_EXPIRATION_MINUTES", "10");
  vi.stubEnv("CSRF_SECRET", "test-secret");
  clearKeyPairCache();
});

afterAll(() => {
  vi.unstubAllEnvs();
  clearKeyPairCache();
  rmSync(tmpDir, { recursive: true, force: true });
});

describe("same-account enforcement logic", () => {
  it("same account (sub matches) → no revocation needed", async () => {
    const { token: generalToken } = await signJwt(
      { sub: "account-A", sid: "sid-1", ctx: "general", tv: 0 },
      "general",
    );
    const { token: adminToken } = await signJwt(
      { sub: "account-A", sid: "sid-2", ctx: "admin", tv: 0 },
      "admin",
    );

    // Both tokens have the same sub — same account
    // Parse and compare sub claims
    const { verifyJwtForLogout } = await import("../jwt");
    const generalClaims = await verifyJwtForLogout(generalToken, "general");
    const adminClaims = await verifyJwtForLogout(adminToken, "admin");

    expect(generalClaims?.sub).toBe("account-A");
    expect(adminClaims?.sub).toBe("account-A");
    expect(generalClaims?.sub).toBe(adminClaims?.sub);
  });

  it("different account (sub differs) → revocation needed", async () => {
    const { token: tokenA } = await signJwt(
      { sub: "account-A", sid: "sid-1", ctx: "general", tv: 0 },
      "general",
    );
    const { token: tokenB } = await signJwt(
      { sub: "account-B", sid: "sid-2", ctx: "admin", tv: 0 },
      "admin",
    );

    const { verifyJwtForLogout } = await import("../jwt");
    const claimsA = await verifyJwtForLogout(tokenA, "general");
    const claimsB = await verifyJwtForLogout(tokenB, "admin");

    expect(claimsA?.sub).toBe("account-A");
    expect(claimsB?.sub).toBe("account-B");
    expect(claimsA?.sub).not.toBe(claimsB?.sub);
  });

  it("invalid other token → treat as no session (no revocation)", async () => {
    const { verifyJwtForLogout } = await import("../jwt");
    const result = await verifyJwtForLogout("invalid.token.here");
    expect(result).toBeNull();
  });
});
