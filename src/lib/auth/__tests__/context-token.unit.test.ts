import { exportJWK, generateKeyPair, SignJWT } from "jose";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

// Mock server-only
vi.mock("server-only", () => ({}));

// Mock trust registry
const mockLookup = vi.fn();
vi.mock("../trust-registry", () => ({
  lookupTrustRegistryKey: (...args: unknown[]) => mockLookup(...args),
}));

import { verifyContextToken } from "../context-token";

const fakePool = {} as Parameters<typeof verifyContextToken>[0];

let privateKey: CryptoKey;
let publicJwk: JsonWebKey;

beforeAll(async () => {
  const kp = await generateKeyPair("ES256");
  privateKey = kp.privateKey;
  publicJwk = await exportJWK(kp.publicKey);
});

afterEach(() => {
  vi.clearAllMocks();
});

async function signContextToken(
  overrides: Record<string, unknown> = {},
  headerOverrides: Record<string, unknown> = {},
): Promise<string> {
  const claims = {
    aice_id: "aice-1",
    customer_ids: ["cust-ext-1", "cust-ext-2"],
    ...overrides,
  };

  const builder = new SignJWT(claims)
    .setProtectedHeader({
      alg: "ES256",
      kid: "key-1",
      ...headerOverrides,
    })
    .setIssuer("https://aice.test")
    .setAudience("aimer-web")
    .setSubject("user-001")
    .setJti("unique-jti-1")
    .setIssuedAt()
    .setExpirationTime("2m");

  // Allow overriding issuer/audience/subject/jti
  if ("iss" in overrides) {
    // Re-set issuer from override
  }

  return builder.sign(privateKey);
}

function setupTrustRegistry(): void {
  mockLookup.mockResolvedValue({
    aiceId: "aice-1",
    issuer: "https://aice.test",
    kid: "key-1",
    publicKey: publicJwk,
  });
}

describe("context token verification", () => {
  it("verifies a valid context token", async () => {
    setupTrustRegistry();
    const token = await signContextToken();
    const claims = await verifyContextToken(fakePool, token);

    expect(claims.iss).toBe("https://aice.test");
    expect(claims.aud).toBe("aimer-web");
    expect(claims.sub).toBe("user-001");
    expect(claims.aiceId).toBe("aice-1");
    expect(claims.customerIds).toEqual(["cust-ext-1", "cust-ext-2"]);
    expect(claims.jti).toBe("unique-jti-1");
    expect(typeof claims.iat).toBe("number");
    expect(typeof claims.exp).toBe("number");
  });

  it("rejects token with unknown issuer/kid", async () => {
    mockLookup.mockResolvedValue(null);
    const token = await signContextToken();

    await expect(verifyContextToken(fakePool, token)).rejects.toThrow(
      "Trust registry: unknown key",
    );
  });

  it("rejects tampered token", async () => {
    setupTrustRegistry();
    const token = await signContextToken();
    const parts = token.split(".");
    parts[1] = `${parts[1]}tampered`;
    const tampered = parts.join(".");

    await expect(verifyContextToken(fakePool, tampered)).rejects.toThrow();
  });

  it("rejects token with wrong audience", async () => {
    mockLookup.mockResolvedValue({
      aiceId: "aice-1",
      issuer: "https://aice.test",
      kid: "key-1",
      publicKey: publicJwk,
    });

    const token = await new SignJWT({
      aice_id: "aice-1",
      customer_ids: ["c1"],
    })
      .setProtectedHeader({ alg: "ES256", kid: "key-1" })
      .setIssuer("https://aice.test")
      .setAudience("wrong-audience")
      .setSubject("user-001")
      .setJti("jti-2")
      .setIssuedAt()
      .setExpirationTime("2m")
      .sign(privateKey);

    await expect(verifyContextToken(fakePool, token)).rejects.toThrow();
  });

  it("rejects expired token", async () => {
    setupTrustRegistry();

    const token = await new SignJWT({
      aice_id: "aice-1",
      customer_ids: ["c1"],
    })
      .setProtectedHeader({ alg: "ES256", kid: "key-1" })
      .setIssuer("https://aice.test")
      .setAudience("aimer-web")
      .setSubject("user-001")
      .setJti("jti-3")
      .setIssuedAt(Math.floor(Date.now() / 1000) - 600)
      .setExpirationTime(Math.floor(Date.now() / 1000) - 300)
      .sign(privateKey);

    await expect(verifyContextToken(fakePool, token)).rejects.toThrow();
  });

  it("rejects customer_ids exceeding 20", async () => {
    setupTrustRegistry();
    const tooMany = Array.from({ length: 21 }, (_, i) => `cust-${i}`);
    const token = await signContextToken({ customer_ids: tooMany });

    await expect(verifyContextToken(fakePool, token)).rejects.toThrow(
      "exceeds maximum",
    );
  });

  it("accepts exactly 20 customer_ids", async () => {
    setupTrustRegistry();
    const exact20 = Array.from({ length: 20 }, (_, i) => `cust-${i}`);
    const token = await signContextToken({ customer_ids: exact20 });

    const claims = await verifyContextToken(fakePool, token);
    expect(claims.customerIds).toHaveLength(20);
  });

  it("rejects token missing aice_id", async () => {
    setupTrustRegistry();
    // Build manually without aice_id in payload
    const token = await new SignJWT({ customer_ids: ["c1"] })
      .setProtectedHeader({ alg: "ES256", kid: "key-1" })
      .setIssuer("https://aice.test")
      .setAudience("aimer-web")
      .setSubject("user-001")
      .setJti("jti-4")
      .setIssuedAt()
      .setExpirationTime("2m")
      .sign(privateKey);

    // Trust registry lookup will fail because unverified payload has no aice_id
    await expect(verifyContextToken(fakePool, token)).rejects.toThrow(
      "missing aice_id",
    );
  });

  it("rejects token missing jti", async () => {
    setupTrustRegistry();
    const token = await new SignJWT({
      aice_id: "aice-1",
      customer_ids: ["c1"],
    })
      .setProtectedHeader({ alg: "ES256", kid: "key-1" })
      .setIssuer("https://aice.test")
      .setAudience("aimer-web")
      .setSubject("user-001")
      .setIssuedAt()
      .setExpirationTime("2m")
      .sign(privateKey);

    await expect(verifyContextToken(fakePool, token)).rejects.toThrow(
      "missing jti",
    );
  });

  it("rejects token with non-string customer_ids", async () => {
    setupTrustRegistry();
    const token = await signContextToken({ customer_ids: [1, 2, 3] });

    await expect(verifyContextToken(fakePool, token)).rejects.toThrow(
      "must be strings",
    );
  });

  it("rejects invalid token format", async () => {
    await expect(verifyContextToken(fakePool, "not.a.valid")).rejects.toThrow();
  });

  it("rejects token with missing kid in header", async () => {
    const token = await new SignJWT({
      aice_id: "aice-1",
      customer_ids: ["c1"],
    })
      .setProtectedHeader({ alg: "ES256" })
      .setIssuer("https://aice.test")
      .setAudience("aimer-web")
      .setSubject("user-001")
      .setJti("jti-5")
      .setIssuedAt()
      .setExpirationTime("2m")
      .sign(privateKey);

    await expect(verifyContextToken(fakePool, token)).rejects.toThrow(
      "missing kid",
    );
  });
});
