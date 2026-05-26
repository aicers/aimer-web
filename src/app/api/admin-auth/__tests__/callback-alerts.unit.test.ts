import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

const mockEmitSevereAlert = vi.fn();

vi.mock("@/lib/auth/cookies", () => ({
  getOidcTempCookies: vi.fn(async () => ({
    state: "test-state",
    nonce: "test-nonce",
    codeVerifier: "test-verifier",
  })),
  clearOidcTempCookies: vi.fn(),
  clearAuthCookies: vi.fn(),
  setAuthCookies: vi.fn(),
}));

// Simulate the documented prod profile from #307: getIssuerUrl()
// returns the BFF-internal back-channel form, while the validated
// id_token.iss carries Keycloak's canonical public hostname.
const INTERNAL_ISSUER_URL = "http://keycloak-internal:8080/realms/aimer";
const CANONICAL_ISSUER = "https://idp.example.com/auth/realms/aimer";

vi.mock("@/lib/auth/oidc-discovery", () => ({
  getOidcDiscovery: vi.fn(async () => ({
    token_endpoint: "https://idp.example.com/auth/token",
    jwks_uri: "https://idp.example.com/auth/jwks",
    issuer: "https://idp.example.com/auth/realms/aimer",
  })),
}));

vi.mock("@/lib/auth/oidc", () => ({
  getIssuerUrl: vi.fn(() => "http://keycloak-internal:8080/realms/aimer"),
  exchangeCodeForTokens: vi.fn(async () => ({
    id_token: "fake-id-token",
    access_token: "fake-access-token",
  })),
}));

vi.mock("@/lib/auth/oidc-validate", () => ({
  validateIdToken: vi.fn(async () => ({
    iss: "https://idp.example.com/auth/realms/aimer",
    sub: "user-sub-001",
    preferred_username: "admin",
    name: "Admin User",
    email: "admin@example.com",
    email_verified: true,
    acr: "urn:keycloak:acr:mfa",
    auth_time: Math.floor(Date.now() / 1000),
  })),
}));

const mockUpsertAccount = vi.fn();

vi.mock("@/lib/auth/account", () => ({
  upsertAccount: (...args: unknown[]) => mockUpsertAccount(...args),
}));

const mockVerifyAdminClaims = vi.fn();

vi.mock("@/lib/auth/admin-verify", () => ({
  verifyAdminClaims: (...args: unknown[]) => mockVerifyAdminClaims(...args),
}));

vi.mock("@/lib/audit", () => ({
  auditLog: vi.fn(async () => {}),
}));

vi.mock("@/lib/detection", () => ({
  emitSevereAlert: (arg: unknown) => mockEmitSevereAlert(arg),
}));

vi.mock("@/lib/auth/jwt", () => ({
  signJwt: vi.fn(async () => ({ token: "jwt-token", iat: 1000, exp: 2000 })),
}));

vi.mock("@/lib/auth/csrf", () => ({
  generateCsrf: vi.fn(() => "csrf-token"),
}));

vi.mock("@/lib/auth/same-account", () => ({
  enforceSameAccount: vi.fn(async () => {}),
}));

vi.mock("@/lib/db/client", () => ({
  getAuthPool: vi.fn(() => ({})),
  query: vi.fn(async () => [{ sid: "session-001" }]),
  // biome-ignore lint/complexity/noBannedTypes: test mock needs generic callable
  withTransaction: vi.fn(async (_pool: unknown, fn: Function) => fn({})),
}));

// ---------------------------------------------------------------------------

function makeCallbackRequest(): NextRequest {
  const url =
    "http://localhost:3000/api/admin-auth/callback?code=abc&state=test-state";
  return new NextRequest(url);
}

async function callGET(req: NextRequest) {
  const { GET } = await import("../callback/route");
  return GET(req);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("admin-auth callback — emitSevereAlert integration", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.OIDC_ADMIN_CLIENT_SECRET = "test-secret";
  });

  it("emits suspended_account_sign_in for suspended admin account", async () => {
    mockUpsertAccount.mockResolvedValue({
      id: "admin-001",
      status: "suspended",
      token_version: 1,
      admin_eligible: true,
      locale: null,
    });

    const res = await callGET(makeCallbackRequest());
    expect(res.status).toBe(307);
    expect(res.headers.get("location")).toContain("account_inactive");

    expect(mockEmitSevereAlert).toHaveBeenCalledWith(
      expect.objectContaining({
        indicator: "suspended_account_sign_in",
        actorId: "admin-001",
        summary: expect.objectContaining({ authContext: "admin" }),
      }),
    );
  });

  it("emits admin_auth_denial_pattern for acr_invalid", async () => {
    mockUpsertAccount.mockResolvedValue({
      id: "admin-001",
      status: "active",
      token_version: 1,
      admin_eligible: true,
      locale: null,
    });
    mockVerifyAdminClaims.mockReturnValue("acr_invalid");

    const res = await callGET(makeCallbackRequest());
    expect(res.status).toBe(307);
    expect(res.headers.get("location")).toContain("acr_invalid");

    expect(mockEmitSevereAlert).toHaveBeenCalledWith(
      expect.objectContaining({
        indicator: "admin_auth_denial_pattern",
        actorId: "admin-001",
        summary: expect.objectContaining({ reason: "acr_invalid" }),
      }),
    );
  });

  it("emits admin_auth_denial_pattern for auth_time_too_old", async () => {
    mockUpsertAccount.mockResolvedValue({
      id: "admin-001",
      status: "active",
      token_version: 1,
      admin_eligible: true,
      locale: null,
    });
    mockVerifyAdminClaims.mockReturnValue("auth_time_too_old");

    const res = await callGET(makeCallbackRequest());
    expect(res.status).toBe(307);
    expect(res.headers.get("location")).toContain("auth_time_too_old");

    expect(mockEmitSevereAlert).toHaveBeenCalledWith(
      expect.objectContaining({
        indicator: "admin_auth_denial_pattern",
        actorId: "admin-001",
        summary: expect.objectContaining({ reason: "auth_time_too_old" }),
      }),
    );
  });

  it("does not emit alert for non-probing denial reasons", async () => {
    mockUpsertAccount.mockResolvedValue({
      id: "admin-001",
      status: "active",
      token_version: 1,
      admin_eligible: false,
      locale: null,
    });
    mockVerifyAdminClaims.mockReturnValue("not_admin_eligible");

    const res = await callGET(makeCallbackRequest());
    expect(res.status).toBe(307);
    expect(res.headers.get("location")).toContain("not_admin_eligible");

    // Non-probing denials should not trigger an alert
    expect(mockEmitSevereAlert).not.toHaveBeenCalled();
  });

  it("does not emit alert for successful admin login", async () => {
    mockUpsertAccount.mockResolvedValue({
      id: "admin-001",
      status: "active",
      token_version: 1,
      admin_eligible: true,
      locale: null,
    });
    mockVerifyAdminClaims.mockReturnValue(null);

    const res = await callGET(makeCallbackRequest());
    expect(res.status).toBe(307);

    expect(mockEmitSevereAlert).not.toHaveBeenCalled();
  });

  // Regression for #307: upsertAccount must key on the validated
  // id_token.iss claim, not the config-derived getIssuerUrl() string.
  // The mocks deliberately set the two to different values so a
  // regression back to upsertAccount(client, issuerUrl, idClaims)
  // would fail this assertion.
  it("keys upsertAccount on validated id_token.iss, not getIssuerUrl()", async () => {
    mockUpsertAccount.mockResolvedValue({
      id: "admin-001",
      status: "active",
      token_version: 1,
      admin_eligible: true,
      locale: null,
    });
    mockVerifyAdminClaims.mockReturnValue(null);

    await callGET(makeCallbackRequest());

    expect(mockUpsertAccount).toHaveBeenCalledTimes(1);
    const [, issuerArg] = mockUpsertAccount.mock.calls[0];
    expect(issuerArg).toBe(CANONICAL_ISSUER);
    expect(issuerArg).not.toBe(INTERNAL_ISSUER_URL);
  });
});
