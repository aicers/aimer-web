import { createHash } from "node:crypto";
import { CompactSign, exportJWK, generateKeyPair } from "jose";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { ContextTokenClaims } from "../context-token";
import type { EventsEnvelopeClaims } from "../events-envelope";

vi.mock("server-only", () => ({}));

const mockLookup = vi.fn();
vi.mock("../trust-registry", () => ({
  lookupTrustRegistryKey: (...args: unknown[]) => mockLookup(...args),
}));

import { verifyAnalyzeParamsToken } from "../analyze-params-token";

const fakePool = {} as Parameters<typeof verifyAnalyzeParamsToken>[0];

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

const eventsPayloadBytes = new TextEncoder().encode(
  JSON.stringify({ event_key: "42" }),
);
const eventsPayloadHash = createHash("sha256")
  .update(eventsPayloadBytes)
  .digest("base64url");

// Pretend the envelope JWS body is just a fixed string — the unit test
// does not parse it, only hashes its bytes for the envelope_hash check.
const FAKE_ENVELOPE_JWS = "envelope-jws-bytes.example.signature";
const expectedEnvelopeHash = createHash("sha256")
  .update(FAKE_ENVELOPE_JWS)
  .digest("base64url");

const baseContext: ContextTokenClaims = {
  iss: "https://aice.test",
  aud: "aimer-web",
  sub: "user-001",
  aiceId: "aice-1",
  customerIds: ["cust-ext-1"],
  iat: Math.floor(Date.now() / 1000),
  exp: Math.floor(Date.now() / 1000) + 120,
  jti: "context-jti-1",
};

const baseEnvelope: EventsEnvelopeClaims = {
  iss: "https://aice.test",
  aiceId: "aice-1",
  customerIds: ["cust-ext-1"],
  contextJti: "context-jti-1",
  payloadHash: eventsPayloadHash,
  eventCount: 1,
  schemaVersion: "1.0",
};

function setupTrustRegistry(): void {
  mockLookup.mockResolvedValue({
    entry: {
      aiceId: "aice-1",
      issuer: "https://aice.test",
      kid: "key-1",
      publicKey: publicJwk,
      expiresAtMs: null,
    },
    rejection: null,
  });
}

async function signParamsToken(
  overrides: Record<string, unknown> = {},
  signWith: CryptoKey = privateKey,
): Promise<string> {
  const claims = {
    context_jti: "context-jti-1",
    payload_hash: eventsPayloadHash,
    envelope_hash: expectedEnvelopeHash,
    event_key: "42",
    lang: "KOREAN",
    model_name: "model-name",
    model: "model",
    force: false,
    external_key: "cust-ext-1",
    ...overrides,
  };
  const payload = new TextEncoder().encode(JSON.stringify(claims));
  return new CompactSign(payload)
    .setProtectedHeader({ alg: "ES256", kid: "key-1" })
    .sign(signWith);
}

describe("analyze_params_token cross-binding", () => {
  it("verifies a valid token (all-correct positive case)", async () => {
    setupTrustRegistry();
    const token = await signParamsToken();
    const result = await verifyAnalyzeParamsToken(
      fakePool,
      token,
      FAKE_ENVELOPE_JWS,
      baseContext,
      baseEnvelope,
    );
    expect(result.contextJti).toBe("context-jti-1");
    expect(result.payloadHash).toBe(eventsPayloadHash);
    expect(result.envelopeHash).toBe(expectedEnvelopeHash);
    expect(result.eventKey).toBe("42");
    expect(result.lang).toBe("KOREAN");
    expect(result.externalKey).toBe("cust-ext-1");
    expect(result.force).toBe(false);
  });

  it("rejects tampered context_jti", async () => {
    setupTrustRegistry();
    const token = await signParamsToken({ context_jti: "wrong-jti" });
    await expect(
      verifyAnalyzeParamsToken(
        fakePool,
        token,
        FAKE_ENVELOPE_JWS,
        baseContext,
        baseEnvelope,
      ),
    ).rejects.toThrow("context_jti does not match");
  });

  it("rejects tampered payload_hash", async () => {
    setupTrustRegistry();
    const token = await signParamsToken({ payload_hash: "tampered-hash" });
    await expect(
      verifyAnalyzeParamsToken(
        fakePool,
        token,
        FAKE_ENVELOPE_JWS,
        baseContext,
        baseEnvelope,
      ),
    ).rejects.toThrow("payload_hash does not match");
  });

  it("rejects tampered envelope_hash", async () => {
    setupTrustRegistry();
    const token = await signParamsToken({ envelope_hash: "tampered" });
    await expect(
      verifyAnalyzeParamsToken(
        fakePool,
        token,
        FAKE_ENVELOPE_JWS,
        baseContext,
        baseEnvelope,
      ),
    ).rejects.toThrow("envelope_hash does not match");
  });

  it("rejects tampered signature", async () => {
    setupTrustRegistry();
    const token = await signParamsToken();
    const parts = token.split(".");
    parts[2] = `${parts[2]}tampered`;
    await expect(
      verifyAnalyzeParamsToken(
        fakePool,
        parts.join("."),
        FAKE_ENVELOPE_JWS,
        baseContext,
        baseEnvelope,
      ),
    ).rejects.toThrow();
  });

  it("rejects a replayed token paired with a freshly-minted envelope", async () => {
    setupTrustRegistry();
    // The token's envelope_hash was computed against the original
    // envelope. A new envelope arrives with new bytes — the
    // recomputed envelope_hash no longer matches.
    const token = await signParamsToken();
    const replayedEnvelopeJws = "different-envelope.jws.bytes";
    await expect(
      verifyAnalyzeParamsToken(
        fakePool,
        token,
        replayedEnvelopeJws,
        baseContext,
        baseEnvelope,
      ),
    ).rejects.toThrow("envelope_hash does not match");
  });

  it("rejects token signed by an unrelated key", async () => {
    setupTrustRegistry();
    const otherKp = await generateKeyPair("ES256");
    const token = await signParamsToken({}, otherKp.privateKey);
    await expect(
      verifyAnalyzeParamsToken(
        fakePool,
        token,
        FAKE_ENVELOPE_JWS,
        baseContext,
        baseEnvelope,
      ),
    ).rejects.toThrow();
  });
});
