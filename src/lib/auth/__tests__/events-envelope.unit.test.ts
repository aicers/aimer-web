import { createHash } from "node:crypto";
import { CompactSign, exportJWK, generateKeyPair } from "jose";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { ContextTokenClaims } from "../context-token";

// Mock server-only
vi.mock("server-only", () => ({}));

// Mock trust registry
const mockLookup = vi.fn();
vi.mock("../trust-registry", () => ({
  lookupTrustRegistryKey: (...args: unknown[]) => mockLookup(...args),
}));

import { verifyEventsEnvelope } from "../events-envelope";

const fakePool = {} as Parameters<typeof verifyEventsEnvelope>[0];

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

const samplePayload = Buffer.from("detection events binary data");
const sampleHash = createHash("sha256").update(samplePayload).digest("hex");

const baseClaims: ContextTokenClaims = {
  iss: "https://aice.test",
  aud: "aimer-web",
  sub: "user-001",
  aiceId: "aice-1",
  customerIds: ["cust-ext-1"],
  iat: Math.floor(Date.now() / 1000),
  exp: Math.floor(Date.now() / 1000) + 120,
  jti: "context-jti-1",
};

function setupTrustRegistry(): void {
  mockLookup.mockResolvedValue({
    aiceId: "aice-1",
    issuer: "https://aice.test",
    kid: "key-1",
    publicKey: publicJwk,
  });
}

async function signEnvelope(
  claimsOverrides: Record<string, unknown> = {},
): Promise<string> {
  const envelopeClaims = {
    iss: "https://aice.test",
    aice_id: "aice-1",
    customer_ids: ["cust-ext-1"],
    context_jti: "context-jti-1",
    payload_hash: sampleHash,
    event_count: 42,
    schema_version: "1.0",
    ...claimsOverrides,
  };

  const payload = new TextEncoder().encode(JSON.stringify(envelopeClaims));
  return new CompactSign(payload)
    .setProtectedHeader({ alg: "ES256", kid: "key-1" })
    .sign(privateKey);
}

describe("events envelope verification", () => {
  it("verifies a valid envelope", async () => {
    setupTrustRegistry();
    const envelope = await signEnvelope();
    const result = await verifyEventsEnvelope(
      fakePool,
      envelope,
      samplePayload,
      baseClaims,
    );

    expect(result.iss).toBe("https://aice.test");
    expect(result.aiceId).toBe("aice-1");
    expect(result.customerIds).toEqual(["cust-ext-1"]);
    expect(result.contextJti).toBe("context-jti-1");
    expect(result.payloadHash).toBe(sampleHash);
    expect(result.eventCount).toBe(42);
    expect(result.schemaVersion).toBe("1.0");
  });

  it("rejects payload exceeding size cap", async () => {
    setupTrustRegistry();
    vi.stubEnv("BRIDGE_MAX_PAYLOAD_BYTES", "10");
    const envelope = await signEnvelope();
    const largePayload = new Uint8Array(11);

    await expect(
      verifyEventsEnvelope(fakePool, envelope, largePayload, baseClaims),
    ).rejects.toThrow("exceeds size cap");

    vi.unstubAllEnvs();
  });

  it("rejects payload hash mismatch", async () => {
    setupTrustRegistry();
    const envelope = await signEnvelope();
    const wrongPayload = Buffer.from("different data");

    await expect(
      verifyEventsEnvelope(fakePool, envelope, wrongPayload, baseClaims),
    ).rejects.toThrow("payload_hash mismatch");
  });

  it("rejects context_jti mismatch", async () => {
    setupTrustRegistry();
    const envelope = await signEnvelope({ context_jti: "wrong-jti" });

    await expect(
      verifyEventsEnvelope(fakePool, envelope, samplePayload, baseClaims),
    ).rejects.toThrow("context_jti does not match");
  });

  it("rejects iss mismatch", async () => {
    setupTrustRegistry();
    const envelope = await signEnvelope({ iss: "https://other.test" });

    await expect(
      verifyEventsEnvelope(fakePool, envelope, samplePayload, baseClaims),
    ).rejects.toThrow("iss does not match");
  });

  it("rejects aice_id mismatch", async () => {
    setupTrustRegistry();
    const envelope = await signEnvelope({ aice_id: "aice-wrong" });

    await expect(
      verifyEventsEnvelope(fakePool, envelope, samplePayload, baseClaims),
    ).rejects.toThrow("aice_id does not match");
  });

  it("rejects customer_ids mismatch", async () => {
    setupTrustRegistry();
    const envelope = await signEnvelope({ customer_ids: ["different-cust"] });

    await expect(
      verifyEventsEnvelope(fakePool, envelope, samplePayload, baseClaims),
    ).rejects.toThrow("customer_ids does not match");
  });

  it("rejects tampered envelope signature", async () => {
    setupTrustRegistry();
    const envelope = await signEnvelope();
    const parts = envelope.split(".");
    parts[2] = `${parts[2]}tampered`;
    const tampered = parts.join(".");

    await expect(
      verifyEventsEnvelope(fakePool, tampered, samplePayload, baseClaims),
    ).rejects.toThrow();
  });

  it("rejects unknown key in trust registry", async () => {
    mockLookup.mockResolvedValue(null);
    const envelope = await signEnvelope();

    await expect(
      verifyEventsEnvelope(fakePool, envelope, samplePayload, baseClaims),
    ).rejects.toThrow("unknown key");
  });

  it("rejects invalid envelope format", async () => {
    setupTrustRegistry();

    await expect(
      verifyEventsEnvelope(fakePool, "not-valid", samplePayload, baseClaims),
    ).rejects.toThrow();
  });

  it("rejects envelope missing required claims", async () => {
    setupTrustRegistry();
    // Missing event_count
    const partial = {
      iss: "https://aice.test",
      aice_id: "aice-1",
      customer_ids: ["cust-ext-1"],
      context_jti: "context-jti-1",
      payload_hash: sampleHash,
      schema_version: "1.0",
    };
    const payload = new TextEncoder().encode(JSON.stringify(partial));
    const envelope = await new CompactSign(payload)
      .setProtectedHeader({ alg: "ES256", kid: "key-1" })
      .sign(privateKey);

    await expect(
      verifyEventsEnvelope(fakePool, envelope, samplePayload, baseClaims),
    ).rejects.toThrow("missing event_count");
  });

  it("checks size cap before crypto (performance guard)", async () => {
    // Even without trust registry setup (no key), size cap should fail first
    vi.stubEnv("BRIDGE_MAX_PAYLOAD_BYTES", "5");
    const envelope = await signEnvelope();
    const largePayload = new Uint8Array(10);

    await expect(
      verifyEventsEnvelope(fakePool, envelope, largePayload, baseClaims),
    ).rejects.toThrow("exceeds size cap");

    // Trust registry was never called
    expect(mockLookup).not.toHaveBeenCalled();
    vi.unstubAllEnvs();
  });
});
