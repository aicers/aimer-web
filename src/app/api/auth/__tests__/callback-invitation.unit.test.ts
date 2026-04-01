import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
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

vi.mock("@/lib/audit", () => ({
  auditLog: vi.fn(async () => {}),
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
