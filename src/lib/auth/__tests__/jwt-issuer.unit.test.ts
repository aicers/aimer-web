import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { issuerForContext, signJwt, verifyJwtForLogout } from "../jwt";
import { clearKeyPairCache } from "../jwt-keys";
import { verifyJwtStateless } from "../jwt-verify-stateless";

let tmpDir: string;

beforeAll(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "jwt-issuer-test-"));
  vi.stubEnv("DATA_DIR", tmpDir);
  vi.stubEnv("JWT_EXPIRATION_MINUTES", "1");
  clearKeyPairCache();
});

afterAll(() => {
  vi.unstubAllEnvs();
  clearKeyPairCache();
  rmSync(tmpDir, { recursive: true, force: true });
});

describe("JWT issuer per context", () => {
  it("maps general to aimer-web", () => {
    expect(issuerForContext("general")).toBe("aimer-web");
  });

  it("maps admin to aimer-web-admin", () => {
    expect(issuerForContext("admin")).toBe("aimer-web-admin");
  });

  it("signs general JWT with aimer-web issuer", async () => {
    const { token } = await signJwt(
      { sub: "a", sid: "s", ctx: "general", tv: 0 },
      "general",
    );
    const claims = await verifyJwtStateless(token, "general");
    expect(claims.ctx).toBe("general");
  });

  it("signs admin JWT with aimer-web-admin issuer", async () => {
    const { token } = await signJwt(
      { sub: "a", sid: "s", ctx: "admin", tv: 0 },
      "admin",
    );
    const claims = await verifyJwtStateless(token, "admin");
    expect(claims.ctx).toBe("admin");
  });

  it("admin JWT rejected when verified as general", async () => {
    const { token } = await signJwt(
      { sub: "a", sid: "s", ctx: "admin", tv: 0 },
      "admin",
    );
    await expect(verifyJwtStateless(token, "general")).rejects.toThrow();
  });

  it("general JWT rejected when verified as admin", async () => {
    const { token } = await signJwt(
      { sub: "a", sid: "s", ctx: "general", tv: 0 },
      "general",
    );
    await expect(verifyJwtStateless(token, "admin")).rejects.toThrow();
  });

  it("verifyJwtStateless without context tries both issuers", async () => {
    const { token: generalToken } = await signJwt(
      { sub: "a", sid: "s", ctx: "general", tv: 0 },
      "general",
    );
    const { token: adminToken } = await signJwt(
      { sub: "a", sid: "s", ctx: "admin", tv: 0 },
      "admin",
    );

    const g = await verifyJwtStateless(generalToken);
    expect(g.ctx).toBe("general");

    const a = await verifyJwtStateless(adminToken);
    expect(a.ctx).toBe("admin");
  });

  it("verifyJwtForLogout works for both contexts", async () => {
    const { token: generalToken } = await signJwt(
      { sub: "a", sid: "s1", ctx: "general", tv: 0 },
      "general",
    );
    const { token: adminToken } = await signJwt(
      { sub: "a", sid: "s2", ctx: "admin", tv: 0 },
      "admin",
    );

    const g = await verifyJwtForLogout(generalToken);
    expect(g?.sid).toBe("s1");

    const a = await verifyJwtForLogout(adminToken);
    expect(a?.sid).toBe("s2");
  });
});
