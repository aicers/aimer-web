import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  buildAuthorizationUrl,
  generateCodeChallenge,
  generateCodeVerifier,
  generateNonce,
  generateState,
} from "../oidc";
import type { OidcDiscovery } from "../oidc-discovery";

describe("OIDC utilities", () => {
  describe("generateCodeVerifier", () => {
    it("produces a 43-character base64url string", () => {
      const verifier = generateCodeVerifier();
      expect(verifier).toMatch(/^[A-Za-z0-9_-]{43}$/);
    });

    it("produces unique values", () => {
      const a = generateCodeVerifier();
      const b = generateCodeVerifier();
      expect(a).not.toBe(b);
    });
  });

  describe("generateCodeChallenge", () => {
    it("produces correct S256 hash", () => {
      const verifier = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk";
      const expected = createHash("sha256")
        .update(verifier)
        .digest("base64url");
      expect(generateCodeChallenge(verifier)).toBe(expected);
    });

    it("produces a 43-character base64url string", () => {
      const challenge = generateCodeChallenge(generateCodeVerifier());
      expect(challenge).toMatch(/^[A-Za-z0-9_-]{43}$/);
    });
  });

  describe("generateState / generateNonce", () => {
    it("produces valid UUIDs", () => {
      const uuidRegex =
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
      expect(generateState()).toMatch(uuidRegex);
      expect(generateNonce()).toMatch(uuidRegex);
    });
  });

  describe("buildAuthorizationUrl", () => {
    const discovery: OidcDiscovery = {
      issuer: "http://localhost:8080/realms/aimer",
      authorization_endpoint:
        "http://localhost:8080/realms/aimer/protocol/openid-connect/auth",
      token_endpoint:
        "http://localhost:8080/realms/aimer/protocol/openid-connect/token",
      userinfo_endpoint:
        "http://localhost:8080/realms/aimer/protocol/openid-connect/userinfo",
      end_session_endpoint:
        "http://localhost:8080/realms/aimer/protocol/openid-connect/logout",
      jwks_uri:
        "http://localhost:8080/realms/aimer/protocol/openid-connect/certs",
    };

    it("includes all required params", () => {
      const url = buildAuthorizationUrl({
        discovery,
        clientId: "aimer-web",
        redirectUri: "https://localhost/api/auth/callback",
        state: "test-state",
        nonce: "test-nonce",
        codeChallenge: "test-challenge",
      });

      const parsed = new URL(url);
      expect(parsed.searchParams.get("response_type")).toBe("code");
      expect(parsed.searchParams.get("client_id")).toBe("aimer-web");
      expect(parsed.searchParams.get("redirect_uri")).toBe(
        "https://localhost/api/auth/callback",
      );
      expect(parsed.searchParams.get("scope")).toBe("openid profile email");
      expect(parsed.searchParams.get("state")).toBe("test-state");
      expect(parsed.searchParams.get("nonce")).toBe("test-nonce");
      expect(parsed.searchParams.get("code_challenge")).toBe("test-challenge");
      expect(parsed.searchParams.get("code_challenge_method")).toBe("S256");
    });

    it("includes optional prompt and max_age", () => {
      const url = buildAuthorizationUrl({
        discovery,
        clientId: "aimer-web-admin",
        redirectUri: "https://localhost/api/admin-auth/callback",
        state: "s",
        nonce: "n",
        codeChallenge: "c",
        prompt: "login",
        maxAge: 0,
      });

      const parsed = new URL(url);
      expect(parsed.searchParams.get("prompt")).toBe("login");
      expect(parsed.searchParams.get("max_age")).toBe("0");
    });

    it("includes ui_locales when locale is provided", () => {
      const url = buildAuthorizationUrl({
        discovery,
        clientId: "aimer-web",
        redirectUri: "https://localhost/api/auth/callback",
        state: "s",
        nonce: "n",
        codeChallenge: "c",
        locale: "ko",
      });

      const parsed = new URL(url);
      expect(parsed.searchParams.get("ui_locales")).toBe("ko");
    });
  });
});
