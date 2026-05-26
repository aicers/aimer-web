import { exportJWK, generateKeyPair, SignJWT } from "jose";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { validateIdToken } from "../oidc-validate";

// We need a real key pair to sign test tokens, but we mock the JWKS endpoint.
let privateKey: CryptoKey;
let publicJwk: Record<string, unknown> & { kid?: string; alg?: string };

beforeAll(async () => {
  const kp = await generateKeyPair("RS256", { extractable: true });
  privateKey = kp.privateKey as CryptoKey;
  const jwk = await exportJWK(kp.publicKey);
  publicJwk = { ...jwk, kid: "test-kid", alg: "RS256" };

  // Mock fetch to return our JWKS
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      if (typeof url === "string" && url.includes("/certs")) {
        return new Response(JSON.stringify({ keys: [publicJwk] }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      return new Response("Not Found", { status: 404 });
    }),
  );
});

afterAll(() => {
  vi.restoreAllMocks();
});

async function signTestToken(claims: Record<string, unknown>): Promise<string> {
  return new SignJWT(claims)
    .setProtectedHeader({ alg: "RS256", kid: "test-kid" })
    .setSubject(claims.sub as string)
    .setIssuer("http://localhost:8080/realms/aimer")
    .setAudience("aimer-web")
    .setIssuedAt()
    .setExpirationTime("5m")
    .sign(privateKey);
}

describe("validateIdToken", () => {
  const baseParams = {
    jwksUri: "http://localhost:8080/realms/aimer/protocol/openid-connect/certs",
    issuer: "http://localhost:8080/realms/aimer",
    clientId: "aimer-web",
    nonce: "test-nonce",
  };

  it("validates a correct token", async () => {
    const idToken = await signTestToken({
      sub: "user-123",
      preferred_username: "testuser",
      name: "Test User",
      email: "test@example.com",
      nonce: "test-nonce",
    });

    const claims = await validateIdToken({ idToken, ...baseParams });
    expect(claims.iss).toBe("http://localhost:8080/realms/aimer");
    expect(claims.sub).toBe("user-123");
    expect(claims.preferred_username).toBe("testuser");
    expect(claims.name).toBe("Test User");
    expect(claims.email).toBe("test@example.com");
  });

  it("rejects token with wrong nonce", async () => {
    const idToken = await signTestToken({
      sub: "user-123",
      preferred_username: "testuser",
      name: "Test",
      nonce: "wrong-nonce",
    });

    await expect(validateIdToken({ idToken, ...baseParams })).rejects.toThrow(
      "nonce mismatch",
    );
  });

  it("rejects token without sub", async () => {
    // Sign a token manually without sub
    const token = await new SignJWT({
      preferred_username: "testuser",
      name: "Test",
      nonce: "test-nonce",
    })
      .setProtectedHeader({ alg: "RS256", kid: "test-kid" })
      .setIssuer("http://localhost:8080/realms/aimer")
      .setAudience("aimer-web")
      .setIssuedAt()
      .setExpirationTime("5m")
      .sign(privateKey);

    await expect(
      validateIdToken({ idToken: token, ...baseParams }),
    ).rejects.toThrow("missing sub");
  });

  it("rejects token with wrong audience", async () => {
    const token = await new SignJWT({
      sub: "user-123",
      preferred_username: "testuser",
      name: "Test",
      nonce: "test-nonce",
    })
      .setProtectedHeader({ alg: "RS256", kid: "test-kid" })
      .setSubject("user-123")
      .setIssuer("http://localhost:8080/realms/aimer")
      .setAudience("wrong-audience")
      .setIssuedAt()
      .setExpirationTime("5m")
      .sign(privateKey);

    await expect(
      validateIdToken({ idToken: token, ...baseParams }),
    ).rejects.toThrow();
  });
});
