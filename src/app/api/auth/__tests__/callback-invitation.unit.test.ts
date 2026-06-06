import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type {
  AcceptAnalystInvitationResult,
  DiagnosticResult,
  InvitationType,
} from "@/lib/auth/analyst-invitations";
import type { AcceptInvitationResult } from "@/lib/auth/invitations";

// ---------------------------------------------------------------------------
// Mocks — stub every external dependency so we can isolate cookie-clearing
// ---------------------------------------------------------------------------

const clearInvitationTokenCookie = vi.fn();
const clearOidcTempCookies = vi.fn();
const setAuthCookies = vi.fn();

vi.mock("@/lib/auth/cookies", () => ({
  getOidcTempCookies: vi.fn(async () => ({
    state: "test-state",
    nonce: "test-nonce",
    codeVerifier: "test-verifier",
  })),
  clearOidcTempCookies,
  clearInvitationTokenCookie,
  clearConnectionIdCookie: vi.fn(),
  clearAuthCookies: vi.fn(),
  setAuthCookies,
}));

vi.mock("@/lib/auth/oidc-discovery", () => ({
  getOidcDiscovery: vi.fn(async () => ({
    token_endpoint: "https://idp.test/token",
    jwks_uri: "https://idp.test/jwks",
    issuer: "https://idp.test",
  })),
}));

vi.mock("@/lib/auth/oidc", () => ({
  getIssuerUrl: vi.fn(() => "https://idp.test"),
  exchangeCodeForTokens: vi.fn(async () => ({
    id_token: "fake-id-token",
    access_token: "fake-access-token",
  })),
}));

vi.mock("@/lib/auth/oidc-validate", () => ({
  validateIdToken: vi.fn(async () => ({
    iss: "https://idp.test",
    sub: "user-sub-001",
    preferred_username: "testuser",
    name: "Test User",
    email: "test@example.com",
    email_verified: true,
  })),
}));

vi.mock("@/lib/auth/account", () => ({
  upsertAccount: vi.fn(async () => ({
    id: "account-001",
    status: "active",
    token_version: 1,
    admin_eligible: false,
    locale: null,
  })),
  countAccessibleCustomers: vi.fn(async () => 1),
}));

const acceptInvitationMock = vi.fn<() => Promise<AcceptInvitationResult>>();

vi.mock("@/lib/auth/invitations", () => ({
  acceptInvitation: () => acceptInvitationMock(),
}));

const resolveInvitationTypeMock = vi.fn<() => Promise<InvitationType>>();
const acceptAnalystInvitationMock =
  vi.fn<() => Promise<AcceptAnalystInvitationResult>>();
const diagnoseTerminalInvitationMock = vi.fn<() => Promise<DiagnosticResult>>();

vi.mock("@/lib/auth/analyst-invitations", () => ({
  resolveInvitationType: () => resolveInvitationTypeMock(),
  acceptAnalystInvitation: () => acceptAnalystInvitationMock(),
  diagnoseTerminalInvitation: () => diagnoseTerminalInvitationMock(),
  // Re-implement the pure mapper so deny-redirect assertions stay faithful.
  analystReasonToDenyKey: (reason: string): string => {
    switch (reason) {
      case "email_mismatch":
        return "invitation_email_mismatch";
      case "email_verified_false":
        return "invitation_email_not_verified";
      default:
        return "invitation_expired";
    }
  },
}));

const auditLogMock =
  vi.fn<(params: Record<string, unknown>) => Promise<void>>();

vi.mock("@/lib/audit", () => ({
  auditLog: (params: Record<string, unknown>) => auditLogMock(params),
}));

vi.mock("@/lib/detection", () => ({
  emitSevereAlert: vi.fn(async () => {}),
}));

vi.mock("@/lib/auth/jwt", () => ({
  signJwt: vi.fn(async () => ({
    token: "jwt-token",
    iat: 1000,
    exp: 2000,
  })),
}));

vi.mock("@/lib/auth/csrf", () => ({
  generateCsrf: vi.fn(() => "csrf-token"),
}));

vi.mock("@/lib/auth/same-account", () => ({
  enforceSameAccount: vi.fn(async () => {}),
}));

vi.mock("@/lib/auth/bridge", () => ({
  processBridgeCallback: vi.fn(async () => ({ deny: null })),
  denyConnection: vi.fn(async () => {}),
}));

vi.mock("@/lib/db/client", () => ({
  getAuthPool: vi.fn(() => ({})),
  query: vi.fn(async () => [{ sid: "session-001" }]),
  // biome-ignore lint/complexity/noBannedTypes: test mock needs generic callable
  withTransaction: vi.fn(async (_pool: unknown, fn: Function) => fn({})),
}));

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("callback route — invitation_token cookie clearing (#87)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.OIDC_GENERAL_CLIENT_SECRET = "test-secret";
    // Default to the member path so the existing #77 cases are unaffected.
    resolveInvitationTypeMock.mockResolvedValue("member");
  });

  function makeCallbackRequest(): NextRequest {
    const url =
      "http://localhost:3000/api/auth/callback?code=abc&state=test-state";
    const req = new NextRequest(url);
    // Simulate the invitation_token cookie
    req.cookies.set("invitation_token", "raw-token-value");
    return req;
  }

  async function callGET(req: NextRequest) {
    // Dynamic import to pick up mocks
    const { GET } = await import("../callback/route");
    return GET(req);
  }

  it("clears cookie when deny = invitation_expired", async () => {
    acceptInvitationMock.mockResolvedValue({
      deny: "invitation_expired",
    });

    const res = await callGET(makeCallbackRequest());
    expect(res.status).toBe(307);
    expect(res.headers.get("location")).toContain("invitation_expired");
    expect(clearInvitationTokenCookie).toHaveBeenCalledTimes(1);
  });

  it("clears cookie when deny = invitation_email_mismatch", async () => {
    acceptInvitationMock.mockResolvedValue({
      deny: "invitation_email_mismatch",
    });

    const res = await callGET(makeCallbackRequest());
    expect(res.status).toBe(307);
    expect(res.headers.get("location")).toContain("invitation_email_mismatch");
    expect(clearInvitationTokenCookie).toHaveBeenCalledTimes(1);
  });

  it("clears cookie when deny = invitation_email_not_verified", async () => {
    acceptInvitationMock.mockResolvedValue({
      deny: "invitation_email_not_verified",
    });

    const res = await callGET(makeCallbackRequest());
    expect(res.status).toBe(307);
    expect(res.headers.get("location")).toContain(
      "invitation_email_not_verified",
    );
    expect(clearInvitationTokenCookie).toHaveBeenCalledTimes(1);
  });

  it("clears cookie on successful acceptance too", async () => {
    acceptInvitationMock.mockResolvedValue({
      deny: null,
      invitationId: "inv-001",
      customerId: "cust-001",
    });

    const res = await callGET(makeCallbackRequest());
    expect(res.status).toBe(307);
    expect(res.headers.get("location")).toContain("localhost:3000");
    expect(clearInvitationTokenCookie).toHaveBeenCalledTimes(1);
  });
});

describe("callback route — analyst invitation dispatch (#268)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.OIDC_GENERAL_CLIENT_SECRET = "test-secret";
  });

  function makeCallbackRequest(): NextRequest {
    const url =
      "http://localhost:3000/api/auth/callback?code=abc&state=test-state";
    const req = new NextRequest(url);
    req.cookies.set("invitation_token", "raw-token-value");
    return req;
  }

  async function callGET(req: NextRequest) {
    const { GET } = await import("../callback/route");
    return GET(req);
  }

  it("analyst accepted: clears cookie, audits analyst_invitation accepted, signs in", async () => {
    resolveInvitationTypeMock.mockResolvedValue("analyst");
    acceptAnalystInvitationMock.mockResolvedValue({
      outcome: "accepted",
      invitationId: "ainv-001",
      customerIds: ["cust-a", "cust-b"],
    });

    const res = await callGET(makeCallbackRequest());
    // Falls through to standard sign-in (redirect to home, not /deny).
    expect(res.status).toBe(307);
    expect(res.headers.get("location")).not.toContain("/deny");
    expect(clearInvitationTokenCookie).toHaveBeenCalledTimes(1);
    expect(acceptInvitationMock).not.toHaveBeenCalled();
    expect(auditLogMock).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "invitation.accepted",
        targetType: "analyst_invitation",
        targetId: "ainv-001",
      }),
    );
  });

  it("analyst retryable email_mismatch: clears cookie, denies to email_mismatch key, audits failed", async () => {
    resolveInvitationTypeMock.mockResolvedValue("analyst");
    acceptAnalystInvitationMock.mockResolvedValue({
      outcome: "retryable",
      reason: "email_mismatch",
      invitationId: "ainv-002",
    });

    const res = await callGET(makeCallbackRequest());
    expect(res.status).toBe(307);
    expect(res.headers.get("location")).toContain("invitation_email_mismatch");
    expect(clearInvitationTokenCookie).toHaveBeenCalledTimes(1);
    expect(auditLogMock).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "invitation.failed",
        targetType: "analyst_invitation",
        details: { reason: "email_mismatch" },
      }),
    );
  });

  it("analyst retryable email_verified_false: denies to not_verified key", async () => {
    resolveInvitationTypeMock.mockResolvedValue("analyst");
    acceptAnalystInvitationMock.mockResolvedValue({
      outcome: "retryable",
      reason: "email_verified_false",
      invitationId: "ainv-003",
    });

    const res = await callGET(makeCallbackRequest());
    expect(res.headers.get("location")).toContain(
      "invitation_email_not_verified",
    );
    expect(clearInvitationTokenCookie).toHaveBeenCalledTimes(1);
  });

  it("analyst non-retryable expired: audits invitation.failed (NOT expired) with reason=expired", async () => {
    resolveInvitationTypeMock.mockResolvedValue("analyst");
    acceptAnalystInvitationMock.mockResolvedValue({
      outcome: "non_retryable",
      reason: "expired",
      invitationId: "ainv-004",
    });

    const res = await callGET(makeCallbackRequest());
    expect(res.headers.get("location")).toContain("invitation_expired");
    expect(clearInvitationTokenCookie).toHaveBeenCalledTimes(1);
    expect(auditLogMock).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "invitation.failed",
        targetType: "analyst_invitation",
        details: { reason: "expired" },
      }),
    );
  });

  it("member-terminal carve-out: not_found + member row preserves legacy member audit/deny", async () => {
    resolveInvitationTypeMock.mockResolvedValue("not_found");
    diagnoseTerminalInvitationMock.mockResolvedValue({
      source: "invitation",
      id: "minv-001",
    });

    const res = await callGET(makeCallbackRequest());
    expect(res.headers.get("location")).toContain("invitation_expired");
    expect(clearInvitationTokenCookie).toHaveBeenCalledTimes(1);
    expect(auditLogMock).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "invitation.expired",
        targetType: "invitation",
        details: { reason: "invitation_expired" },
      }),
    );
  });

  it("not_found + analyst terminal row (already_consumed): short reason + analyst target_type", async () => {
    resolveInvitationTypeMock.mockResolvedValue("not_found");
    diagnoseTerminalInvitationMock.mockResolvedValue({
      source: "analyst_invitation",
      id: "ainv-005",
      reason: "already_consumed",
    });

    const res = await callGET(makeCallbackRequest());
    expect(res.headers.get("location")).toContain("invitation_expired");
    expect(clearInvitationTokenCookie).toHaveBeenCalledTimes(1);
    expect(auditLogMock).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "invitation.failed",
        targetType: "analyst_invitation",
        targetId: "ainv-005",
        details: { reason: "already_consumed" },
      }),
    );
  });

  it("not_found + no row: generic deny, analyst target_type, reason=not_found, no targetId", async () => {
    resolveInvitationTypeMock.mockResolvedValue("not_found");
    diagnoseTerminalInvitationMock.mockResolvedValue({ source: "none" });

    const res = await callGET(makeCallbackRequest());
    expect(res.headers.get("location")).toContain("invitation_expired");
    expect(clearInvitationTokenCookie).toHaveBeenCalledTimes(1);
    const auditCall = auditLogMock.mock.calls.find(
      (c) => c[0]?.action === "invitation.failed",
    );
    expect(auditCall?.[0]).toMatchObject({
      action: "invitation.failed",
      targetType: "analyst_invitation",
      details: { reason: "not_found" },
    });
    expect(auditCall?.[0].targetId).toBeUndefined();
  });
});
