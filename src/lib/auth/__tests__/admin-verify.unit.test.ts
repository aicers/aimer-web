import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { verifyAdminClaims } from "../admin-verify";
import type { IdTokenClaims } from "../oidc-validate";

beforeAll(() => {
  vi.stubEnv(
    "ADMIN_ACCEPTED_ACR_VALUES",
    "urn:keycloak:acr:mfa,urn:keycloak:acr:2fa",
  );
  vi.stubEnv("ADMIN_MAX_AUTH_AGE_SECONDS", "300");
});

afterAll(() => {
  vi.unstubAllEnvs();
});

function makeClaims(overrides?: Partial<IdTokenClaims>): IdTokenClaims {
  const now = Math.floor(Date.now() / 1000);
  return {
    sub: "user-001",
    preferred_username: "admin",
    name: "Admin User",
    iss: "http://localhost:8080/realms/aimer",
    aud: "aimer-web-admin",
    iat: now,
    exp: now + 300,
    acr: "urn:keycloak:acr:mfa",
    auth_time: now - 10,
    realm_access: { roles: ["aimer_admin", "user"] },
    ...overrides,
  };
}

describe("verifyAdminClaims", () => {
  it("returns null for valid admin claims", () => {
    expect(verifyAdminClaims(makeClaims(), true)).toBeNull();
  });

  it("rejects missing acr", () => {
    expect(verifyAdminClaims(makeClaims({ acr: undefined }), true)).toBe(
      "admin_mfa_required",
    );
  });

  it("rejects insufficient acr", () => {
    expect(
      verifyAdminClaims(makeClaims({ acr: "urn:keycloak:acr:0" }), true),
    ).toBe("admin_mfa_required");
  });

  it("rejects missing auth_time", () => {
    expect(verifyAdminClaims(makeClaims({ auth_time: undefined }), true)).toBe(
      "admin_auth_too_old",
    );
  });

  it("rejects auth_time older than MAX_AUTH_AGE_SECONDS", () => {
    const now = Math.floor(Date.now() / 1000);
    expect(verifyAdminClaims(makeClaims({ auth_time: now - 301 }), true)).toBe(
      "admin_auth_too_old",
    );
  });

  it("accepts auth_time within MAX_AUTH_AGE_SECONDS", () => {
    const now = Math.floor(Date.now() / 1000);
    expect(
      verifyAdminClaims(makeClaims({ auth_time: now - 299 }), true),
    ).toBeNull();
  });

  it("rejects missing aimer_admin role", () => {
    expect(
      verifyAdminClaims(
        makeClaims({ realm_access: { roles: ["user"] } }),
        true,
      ),
    ).toBe("admin_role_missing");
  });

  it("rejects missing realm_access", () => {
    expect(
      verifyAdminClaims(makeClaims({ realm_access: undefined }), true),
    ).toBe("admin_role_missing");
  });

  it("rejects admin_eligible=false", () => {
    expect(verifyAdminClaims(makeClaims(), false)).toBe("admin_not_eligible");
  });

  it("checks in order: acr → auth_time → role → eligible", () => {
    const now = Math.floor(Date.now() / 1000);
    // All fail — first failure (acr) should be returned
    expect(
      verifyAdminClaims(
        makeClaims({
          acr: undefined,
          auth_time: now - 999,
          realm_access: { roles: [] },
        }),
        false,
      ),
    ).toBe("admin_mfa_required");
  });
});
