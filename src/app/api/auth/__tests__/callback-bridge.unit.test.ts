import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

const clearConnectionIdCookie = vi.fn();
const clearAuthCookies = vi.fn();
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
  clearConnectionIdCookie,
  clearAuthCookies,
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

vi.mock("@/lib/auth/invitations", () => ({
  acceptInvitation: vi.fn(async () => ({ deny: null })),
}));

vi.mock("@/lib/audit", () => ({
  auditLog: vi.fn(async () => {}),
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

const mockProcessBridgeCallback = vi.fn();

vi.mock("@/lib/auth/bridge", () => ({
  processBridgeCallback: (...args: unknown[]) =>
    mockProcessBridgeCallback(...args),
}));

const mockQuery = vi.fn(async () => [{ sid: "session-001" }]);

vi.mock("@/lib/db/client", () => ({
  getAuthPool: vi.fn(() => ({})),
  query: (...args: Parameters<typeof mockQuery>) => mockQuery(...args),
  // biome-ignore lint/complexity/noBannedTypes: test mock needs generic callable
  withTransaction: vi.fn(async (_pool: unknown, fn: Function) => fn({})),
}));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeCallbackRequest(withConnectionId = true): NextRequest {
  const url =
    "http://localhost:3000/api/auth/callback?code=abc&state=test-state";
  const req = new NextRequest(url);
  if (withConnectionId) {
    req.cookies.set("connection_id", "conn-id-1");
  }
  return req;
}

async function callGET(req: NextRequest) {
  const { GET } = await import("../callback/route");
  return GET(req);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("callback route — bridge flow (#33)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.OIDC_GENERAL_CLIENT_SECRET = "test-secret";
    mockProcessBridgeCallback.mockResolvedValue({
      sessionId: "bridge-session-001",
      bridgeAiceId: "aice-1",
      bridgeCustomerIds: ["cust-uuid-1", "cust-uuid-2"],
    });
  });

  it("creates bridge session when connection_id cookie is present", async () => {
    const res = await callGET(makeCallbackRequest());

    expect(res.status).toBe(307);
    expect(res.headers.get("location")).toContain("localhost:3000");
    expect(mockProcessBridgeCallback).toHaveBeenCalledWith(
      expect.anything(),
      "conn-id-1",
      "account-001",
      expect.objectContaining({ ipAddress: expect.any(String) }),
    );
    expect(clearConnectionIdCookie).toHaveBeenCalled();
    expect(setAuthCookies).toHaveBeenCalled();
  });

  it("passes session params to processBridgeCallback", async () => {
    await callGET(makeCallbackRequest());

    // Session creation now happens inside processBridgeCallback's transaction
    expect(mockProcessBridgeCallback).toHaveBeenCalledWith(
      expect.anything(),
      "conn-id-1",
      "account-001",
      expect.objectContaining({
        ipAddress: expect.any(String),
        userAgent: expect.any(String),
      }),
    );
  });

  it("uses sessionId from processBridgeCallback for JWT", async () => {
    const res = await callGET(makeCallbackRequest());

    // Session + event linking happen inside processBridgeCallback's transaction.
    // Callback only signs JWT with the returned sessionId.
    expect(res.status).toBe(307);
    expect(setAuthCookies).toHaveBeenCalled();
  });

  it("redirects to deny page on bridge_expired", async () => {
    mockProcessBridgeCallback.mockResolvedValue({
      deny: "bridge_expired",
    });

    const res = await callGET(makeCallbackRequest());
    expect(res.status).toBe(307);
    expect(res.headers.get("location")).toContain("bridge_expired");
    expect(clearAuthCookies).toHaveBeenCalledWith("general");
  });

  it("redirects to deny page on bridge_customer_mismatch", async () => {
    mockProcessBridgeCallback.mockResolvedValue({
      deny: "bridge_customer_mismatch",
    });

    const res = await callGET(makeCallbackRequest());
    expect(res.status).toBe(307);
    expect(res.headers.get("location")).toContain("bridge_customer_mismatch");
    expect(clearAuthCookies).toHaveBeenCalledWith("general");
  });

  it("redirects to deny page on bridge_no_access", async () => {
    mockProcessBridgeCallback.mockResolvedValue({
      deny: "bridge_no_access",
    });

    const res = await callGET(makeCallbackRequest());
    expect(res.status).toBe(307);
    expect(res.headers.get("location")).toContain("bridge_no_access");
  });

  it("redirects to deny page on bridge_customer_inactive", async () => {
    mockProcessBridgeCallback.mockResolvedValue({
      deny: "bridge_customer_inactive",
    });

    const res = await callGET(makeCallbackRequest());
    expect(res.status).toBe(307);
    expect(res.headers.get("location")).toContain("bridge_customer_inactive");
  });

  it("redirects to deny page on bridge_environment_inactive", async () => {
    mockProcessBridgeCallback.mockResolvedValue({
      deny: "bridge_environment_inactive",
    });

    const res = await callGET(makeCallbackRequest());
    expect(res.status).toBe(307);
    expect(res.headers.get("location")).toContain(
      "bridge_environment_inactive",
    );
  });

  it("clears connection_id cookie even on deny", async () => {
    mockProcessBridgeCallback.mockResolvedValue({
      deny: "bridge_expired",
    });

    await callGET(makeCallbackRequest());
    expect(clearConnectionIdCookie).toHaveBeenCalled();
  });

  it("does not set auth cookies on deny", async () => {
    mockProcessBridgeCallback.mockResolvedValue({
      deny: "bridge_expired",
    });

    await callGET(makeCallbackRequest());
    expect(setAuthCookies).not.toHaveBeenCalled();
  });

  it("proceeds with standard flow when no connection_id cookie", async () => {
    const res = await callGET(makeCallbackRequest(false));

    expect(res.status).toBe(307);
    expect(res.headers.get("location")).toContain("localhost:3000");
    expect(mockProcessBridgeCallback).not.toHaveBeenCalled();
    // Standard session created (no bridge fields)
    expect(mockQuery).toHaveBeenCalledWith(
      expect.anything(),
      expect.not.stringContaining("bridge_aice_id"),
      expect.any(Array),
    );
  });
});
