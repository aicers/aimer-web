import { NextRequest } from "next/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SessionExpiredError, SessionRevokedError } from "../session-validator";

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

const mockAuditLog = vi.fn();
vi.mock("@/lib/audit", () => ({
  auditLog: (...args: unknown[]) => mockAuditLog(...args),
}));

const mockGetAuthCookie = vi.fn();
vi.mock("../cookies", () => ({
  getAuthCookie: (...args: unknown[]) => mockGetAuthCookie(...args),
  setAuthCookies: vi.fn(),
}));

const mockVerifyJwtFull = vi.fn();
vi.mock("../jwt", () => ({
  verifyJwtFull: (...args: unknown[]) => mockVerifyJwtFull(...args),
  verifyJwtForLogout: vi.fn(),
}));

const mockValidateSession = vi.fn();
const mockUpdateSessionMeta = vi.fn();
vi.mock("../session-validator", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../session-validator")>();
  return {
    ...actual,
    validateSession: (...args: unknown[]) => mockValidateSession(...args),
    updateSessionMeta: (...args: unknown[]) => mockUpdateSessionMeta(...args),
  };
});

vi.mock("../session-policy", () => ({
  getSessionPolicy: vi.fn().mockResolvedValue({
    general: { idle_timeout_minutes: 30, absolute_timeout_minutes: 480 },
    admin: { idle_timeout_minutes: 15, absolute_timeout_minutes: 240 },
  }),
}));

vi.mock("../rotation", () => ({
  maybeRotateSession: vi.fn().mockResolvedValue({ rotated: false }),
}));

vi.mock("../../db/client", () => ({
  getAuthPool: vi.fn().mockReturnValue({}),
}));

const { withAuth } = await import("../guards");

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const CLAIMS = {
  sub: "account-1",
  sid: "sid-1",
  ctx: "general",
  tv: 0,
  iat: 1700000000,
  exp: 1700000600,
};

function makeRequest(url = "http://localhost:3000/api/test"): NextRequest {
  return new NextRequest(url, {
    headers: { "x-forwarded-for": "10.0.0.1" },
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("withAuth session audit events", () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it("emits session.idle_timeout on SessionExpiredError(idle)", async () => {
    mockGetAuthCookie.mockResolvedValue("valid-token");
    mockVerifyJwtFull.mockResolvedValue(CLAIMS);
    mockValidateSession.mockRejectedValue(new SessionExpiredError("idle"));

    const handler = vi.fn();
    const guarded = withAuth(handler);
    const res = await guarded(makeRequest());

    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({
      error: "Session expired (idle)",
    });
    expect(handler).not.toHaveBeenCalled();

    expect(mockAuditLog).toHaveBeenCalledOnce();
    expect(mockAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({
        actorId: "account-1",
        authContext: "general",
        action: "session.idle_timeout",
        targetType: "session",
        targetId: "sid-1",
        sid: "sid-1",
      }),
    );
  });

  it("emits session.absolute_timeout on SessionExpiredError(absolute)", async () => {
    mockGetAuthCookie.mockResolvedValue("valid-token");
    mockVerifyJwtFull.mockResolvedValue(CLAIMS);
    mockValidateSession.mockRejectedValue(new SessionExpiredError("absolute"));

    const handler = vi.fn();
    const guarded = withAuth(handler);
    const res = await guarded(makeRequest());

    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({
      error: "Session expired (absolute)",
    });

    expect(mockAuditLog).toHaveBeenCalledOnce();
    expect(mockAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "session.absolute_timeout",
        actorId: "account-1",
        targetId: "sid-1",
      }),
    );
  });

  it("emits session.revoked on SessionRevokedError", async () => {
    mockGetAuthCookie.mockResolvedValue("valid-token");
    mockVerifyJwtFull.mockResolvedValue(CLAIMS);
    mockValidateSession.mockRejectedValue(new SessionRevokedError());

    const handler = vi.fn();
    const guarded = withAuth(handler);
    const res = await guarded(makeRequest());

    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "Session revoked" });

    expect(mockAuditLog).toHaveBeenCalledOnce();
    expect(mockAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "session.revoked",
        actorId: "account-1",
        targetId: "sid-1",
      }),
    );
  });

  it("respects admin auth context", async () => {
    mockGetAuthCookie.mockResolvedValue("valid-token");
    mockVerifyJwtFull.mockResolvedValue({ ...CLAIMS, ctx: "admin" });
    mockValidateSession.mockRejectedValue(new SessionExpiredError("idle"));

    const handler = vi.fn();
    const guarded = withAuth(handler, { ctx: "admin" });
    await guarded(makeRequest());

    expect(mockAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({
        authContext: "admin",
        action: "session.idle_timeout",
      }),
    );
  });

  it("returns 401 without audit for unknown session errors", async () => {
    mockGetAuthCookie.mockResolvedValue("valid-token");
    mockVerifyJwtFull.mockResolvedValue(CLAIMS);
    mockValidateSession.mockRejectedValue(new Error("connection refused"));

    const handler = vi.fn();
    const guarded = withAuth(handler);
    const res = await guarded(makeRequest());

    expect(res.status).toBe(401);
    expect(mockAuditLog).not.toHaveBeenCalled();
    expect(handler).not.toHaveBeenCalled();
  });

  it("does not audit when no token is present", async () => {
    mockGetAuthCookie.mockResolvedValue(null);

    const handler = vi.fn();
    const guarded = withAuth(handler);
    const res = await guarded(makeRequest());

    expect(res.status).toBe(401);
    expect(mockAuditLog).not.toHaveBeenCalled();
  });

  it("does not audit when JWT verification fails", async () => {
    mockGetAuthCookie.mockResolvedValue("bad-token");
    mockVerifyJwtFull.mockRejectedValue(new Error("invalid signature"));

    const handler = vi.fn();
    const guarded = withAuth(handler);
    const res = await guarded(makeRequest());

    expect(res.status).toBe(401);
    expect(mockAuditLog).not.toHaveBeenCalled();
  });

  it("calls handler on successful session validation", async () => {
    mockGetAuthCookie.mockResolvedValue("valid-token");
    mockVerifyJwtFull.mockResolvedValue(CLAIMS);
    mockValidateSession.mockResolvedValue({
      createdAt: 1700000000,
      lastActiveAt: 1700000000,
      ipAddress: "10.0.0.1",
      userAgent: "unknown",
      bridgeAiceId: null,
      bridgeCustomerIds: null,
    });

    const handler = vi.fn().mockResolvedValue(Response.json({ ok: true }));
    const guarded = withAuth(handler);
    const res = await guarded(makeRequest());

    expect(res.status).toBe(200);
    expect(handler).toHaveBeenCalledOnce();
    expect(mockAuditLog).not.toHaveBeenCalled();
  });

  it("emits session.ip_mismatch and updates session meta when IP changes", async () => {
    mockGetAuthCookie.mockResolvedValue("valid-token");
    mockVerifyJwtFull.mockResolvedValue(CLAIMS);
    mockValidateSession.mockResolvedValue({
      createdAt: 1700000000,
      lastActiveAt: 1700000000,
      ipAddress: "192.168.1.1", // different from x-forwarded-for: 10.0.0.1
      userAgent: "unknown",
      bridgeAiceId: null,
      bridgeCustomerIds: null,
    });

    const handler = vi.fn().mockResolvedValue(Response.json({ ok: true }));
    const guarded = withAuth(handler);
    const res = await guarded(makeRequest());

    expect(res.status).toBe(200);
    expect(handler).toHaveBeenCalledOnce();
    expect(mockAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "session.ip_mismatch",
        actorId: "account-1",
        targetType: "session",
        targetId: "sid-1",
        details: { previous: "192.168.1.1", current: "10.0.0.1" },
      }),
    );
    expect(mockUpdateSessionMeta).toHaveBeenCalledWith(
      expect.anything(),
      "sid-1",
      "10.0.0.1",
      undefined,
    );
  });

  it("emits session.ua_mismatch and updates session meta when UA changes", async () => {
    mockGetAuthCookie.mockResolvedValue("valid-token");
    mockVerifyJwtFull.mockResolvedValue(CLAIMS);
    mockValidateSession.mockResolvedValue({
      createdAt: 1700000000,
      lastActiveAt: 1700000000,
      ipAddress: "10.0.0.1", // same IP
      userAgent: "Mozilla/5.0 Chrome/100", // different UA
      bridgeAiceId: null,
      bridgeCustomerIds: null,
    });

    const handler = vi.fn().mockResolvedValue(Response.json({ ok: true }));
    const guarded = withAuth(handler);
    const res = await guarded(makeRequest());

    expect(res.status).toBe(200);
    expect(mockAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "session.ua_mismatch",
        details: { previous: "Mozilla/5.0 Chrome/100", current: "unknown" },
      }),
    );
    expect(mockUpdateSessionMeta).toHaveBeenCalledWith(
      expect.anything(),
      "sid-1",
      undefined,
      "unknown",
    );
  });

  it("emits both mismatch events and updates both when IP and UA differ", async () => {
    mockGetAuthCookie.mockResolvedValue("valid-token");
    mockVerifyJwtFull.mockResolvedValue(CLAIMS);
    mockValidateSession.mockResolvedValue({
      createdAt: 1700000000,
      lastActiveAt: 1700000000,
      ipAddress: "192.168.1.1",
      userAgent: "Mozilla/5.0 Chrome/100",
      bridgeAiceId: null,
      bridgeCustomerIds: null,
    });

    const handler = vi.fn().mockResolvedValue(Response.json({ ok: true }));
    const guarded = withAuth(handler);
    await guarded(makeRequest());

    const actions = mockAuditLog.mock.calls.map(
      (call: unknown[]) => (call[0] as { action: string }).action,
    );
    expect(actions).toContain("session.ip_mismatch");
    expect(actions).toContain("session.ua_mismatch");
    expect(mockAuditLog).toHaveBeenCalledTimes(2);
    expect(mockUpdateSessionMeta).toHaveBeenCalledWith(
      expect.anything(),
      "sid-1",
      "10.0.0.1",
      "unknown",
    );
  });

  it("does not emit mismatch when IP and UA match", async () => {
    mockGetAuthCookie.mockResolvedValue("valid-token");
    mockVerifyJwtFull.mockResolvedValue(CLAIMS);
    mockValidateSession.mockResolvedValue({
      createdAt: 1700000000,
      lastActiveAt: 1700000000,
      ipAddress: "10.0.0.1",
      userAgent: "unknown",
      bridgeAiceId: null,
      bridgeCustomerIds: null,
    });

    const handler = vi.fn().mockResolvedValue(Response.json({ ok: true }));
    const guarded = withAuth(handler);
    await guarded(makeRequest());

    expect(mockAuditLog).not.toHaveBeenCalled();
  });
});
