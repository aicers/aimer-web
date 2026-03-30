import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NextRequest } from "next/server";
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { clearKeyPairCache } from "../jwt-keys";

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

const mockAuditLog = vi.fn();
vi.mock("@/lib/audit", () => ({
  auditLog: (...args: unknown[]) => mockAuditLog(...args),
}));

const mockQuery = vi.fn().mockResolvedValue({ rows: [] });
vi.mock("../../db/client", () => ({
  getAuthPool: vi.fn().mockReturnValue({}),
  query: (...args: unknown[]) => mockQuery(...args),
}));

const mockClearAllAuthCookies = vi.fn();
vi.mock("../cookies", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../cookies")>();
  return {
    ...actual,
    clearAllAuthCookies: () => mockClearAllAuthCookies(),
  };
});

let tmpDir: string;

beforeAll(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "same-account-audit-"));
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

const { signJwt } = await import("../jwt");
const { enforceSameAccount } = await import("../same-account");

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeRequestWithCookie(
  cookieName: string,
  cookieValue: string,
): NextRequest {
  return new NextRequest("http://localhost:3000/api/test", {
    headers: { cookie: `${cookieName}=${cookieValue}` },
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("enforceSameAccount audit logging", () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it("emits session.cross_context_mismatch when accounts differ", async () => {
    const { token: adminToken } = await signJwt(
      { sub: "account-B", sid: "sid-2", ctx: "admin", tv: 0 },
      "admin",
    );

    const req = makeRequestWithCookie("at_admin", adminToken);
    const result = await enforceSameAccount(req, "account-A", "general", {
      ipAddress: "10.0.0.1",
    });

    expect(result).toBe("account-B");

    expect(mockAuditLog).toHaveBeenCalledOnce();
    expect(mockAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({
        actorId: "account-A",
        authContext: "general",
        action: "session.cross_context_mismatch",
        targetType: "account",
        targetId: "account-B",
        details: { reason: "account_switched" },
        ipAddress: "10.0.0.1",
      }),
    );
  });

  it("does not audit when accounts match", async () => {
    const { token: adminToken } = await signJwt(
      { sub: "account-A", sid: "sid-2", ctx: "admin", tv: 0 },
      "admin",
    );

    const req = makeRequestWithCookie("at_admin", adminToken);
    const result = await enforceSameAccount(req, "account-A", "general", {
      ipAddress: "10.0.0.1",
    });

    expect(result).toBeNull();
    expect(mockAuditLog).not.toHaveBeenCalled();
  });

  it("does not audit when no other cookie exists", async () => {
    const req = new NextRequest("http://localhost:3000/api/test");
    const result = await enforceSameAccount(req, "account-A", "general", {
      ipAddress: "10.0.0.1",
    });

    expect(result).toBeNull();
    expect(mockAuditLog).not.toHaveBeenCalled();
  });

  it("does not audit when other token has invalid signature", async () => {
    const req = makeRequestWithCookie("at_admin", "invalid.token.here");
    const result = await enforceSameAccount(req, "account-A", "general", {
      ipAddress: "10.0.0.1",
    });

    expect(result).toBeNull();
    expect(mockAuditLog).not.toHaveBeenCalled();
  });

  it("revokes sessions for the previous account on mismatch", async () => {
    const { token: adminToken } = await signJwt(
      { sub: "account-B", sid: "sid-2", ctx: "admin", tv: 0 },
      "admin",
    );

    const req = makeRequestWithCookie("at_admin", adminToken);
    await enforceSameAccount(req, "account-A", "general", {
      ipAddress: "10.0.0.1",
    });

    // Session revocation query
    expect(mockQuery).toHaveBeenCalledWith(
      expect.anything(),
      expect.stringContaining("UPDATE sessions SET revoked = true"),
      ["account-B"],
    );
    // Cookies cleared
    expect(mockClearAllAuthCookies).toHaveBeenCalledOnce();
  });
});
