import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ContextTokenClaims } from "../context-token";
import type { EventsEnvelopeClaims } from "../events-envelope";

// ---------------------------------------------------------------------------
// Mocks — keep the unit test hermetic by stubbing the verification primitives
// and the customer DB lookup. The helper under test is responsible for
// orchestration and Phase 2 cross-checks, not for re-testing the primitives.
// ---------------------------------------------------------------------------

const mockVerifyContextToken = vi.fn();
const mockVerifyEventsEnvelope = vi.fn();
const mockGetCustomerByExternalKey = vi.fn();

vi.mock("../context-token", () => ({
  verifyContextToken: (...args: unknown[]) => mockVerifyContextToken(...args),
}));

vi.mock("../events-envelope", () => ({
  verifyEventsEnvelope: (...args: unknown[]) =>
    mockVerifyEventsEnvelope(...args),
}));

vi.mock("../customers", () => ({
  getCustomerByExternalKey: (...args: unknown[]) =>
    mockGetCustomerByExternalKey(...args),
}));

import {
  EnvelopeVerificationError,
  enforcePhase2CustomerScope,
  verifyMultipartTokens,
  verifyPhase2Multipart,
} from "../envelope-verify";
import { PayloadTooLargeError, TrustRegistryKeyExpiredError } from "../errors";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const fakePool = {} as Parameters<typeof verifyMultipartTokens>[0];

const validContextClaims: ContextTokenClaims = {
  iss: "https://aice.test",
  aud: "aimer-web",
  sub: "user-001",
  aiceId: "aice-1",
  customerIds: ["ext-key-1"],
  iat: 1000,
  exp: 2000,
  jti: "jti-1",
};

const validEnvelopeClaims: EventsEnvelopeClaims = {
  iss: "https://aice.test",
  aiceId: "aice-1",
  customerIds: ["ext-key-1"],
  contextJti: "jti-1",
  payloadHash: "hash-1",
  eventCount: 3,
  schemaVersion: "1.0",
};

function makeRequest(form: FormData): NextRequest {
  return new NextRequest("http://localhost:3000/api/auth/bridge", {
    method: "POST",
    body: form,
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mockVerifyContextToken.mockResolvedValue(validContextClaims);
});

// ---------------------------------------------------------------------------
// verifyMultipartTokens — coverage focuses on the shared orchestration the
// helper added on top of the inline route logic. The Phase 1 route tests
// already exercise the full happy path / status mapping.
// ---------------------------------------------------------------------------

describe("verifyMultipartTokens", () => {
  it("returns claims with undefined envelope/data when both are absent", async () => {
    const form = new FormData();
    form.append("context_token", "valid-jwt");

    const result = await verifyMultipartTokens(fakePool, makeRequest(form));
    expect(result.contextClaims).toEqual(validContextClaims);
    expect(result.envelopeClaims).toBeUndefined();
    expect(result.eventsData).toBeUndefined();
    expect(mockVerifyEventsEnvelope).not.toHaveBeenCalled();
  });

  it("verifies envelope and returns bytes when both fields are supplied", async () => {
    mockVerifyEventsEnvelope.mockResolvedValue(validEnvelopeClaims);
    const form = new FormData();
    form.append("context_token", "valid-jwt");
    form.append("events_envelope", "valid-jws");
    form.append("events_data", '{"external_key":"ext-key-1"}');

    const result = await verifyMultipartTokens(fakePool, makeRequest(form));
    expect(result.envelopeClaims).toEqual(validEnvelopeClaims);
    expect(result.eventsData).toEqual(
      new TextEncoder().encode('{"external_key":"ext-key-1"}'),
    );
  });

  it("wraps invalid context token as EnvelopeVerificationError(invalid_context_token)", async () => {
    const cause = new Error("bad sig");
    mockVerifyContextToken.mockRejectedValue(cause);
    const form = new FormData();
    form.append("context_token", "bad");

    await expect(
      verifyMultipartTokens(fakePool, makeRequest(form)),
    ).rejects.toMatchObject({
      name: "EnvelopeVerificationError",
      code: "invalid_context_token",
      cause,
    });
  });

  it("surfaces oversize as a dedicated events_data_too_large code (no message sniffing)", async () => {
    const cause = new PayloadTooLargeError(11, 10);
    mockVerifyEventsEnvelope.mockRejectedValue(cause);
    const form = new FormData();
    form.append("context_token", "valid-jwt");
    form.append("events_envelope", "valid-jws");
    form.append("events_data", "x");

    let thrown: unknown;
    try {
      await verifyMultipartTokens(fakePool, makeRequest(form));
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(EnvelopeVerificationError);
    const e = thrown as EnvelopeVerificationError;
    expect(e.code).toBe("events_data_too_large");
    expect(e.cause).toBe(cause);
    expect(e.details).toEqual({ actualBytes: 11, maxBytes: 10 });
    expect(e.contextClaims).toEqual(validContextClaims);
  });

  it("translates TrustRegistryKeyExpiredError during context-token verification into a dedicated semantic code", async () => {
    const cause = new TrustRegistryKeyExpiredError("key expired", {
      aiceId: "aice-1",
      issuer: "https://aice.test",
      kid: "key-1",
      expiresAtMs: 1700000000000,
    });
    mockVerifyContextToken.mockRejectedValue(cause);
    const form = new FormData();
    form.append("context_token", "valid-jwt");

    let thrown: unknown;
    try {
      await verifyMultipartTokens(fakePool, makeRequest(form));
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(EnvelopeVerificationError);
    const e = thrown as EnvelopeVerificationError;
    expect(e.code).toBe("trust_registry_key_expired");
    expect(e.cause).toBe(cause);
    expect(e.details).toEqual({
      aiceId: "aice-1",
      issuer: "https://aice.test",
      kid: "key-1",
      expiresAtMs: 1700000000000,
    });
    // Surfaced before context-token verification succeeded — no claims yet.
    expect(e.contextClaims).toBeUndefined();
  });

  it("translates TrustRegistryKeyExpiredError during envelope verification and carries contextClaims", async () => {
    const cause = new TrustRegistryKeyExpiredError("key expired", {
      aiceId: "aice-1",
      issuer: "https://aice.test",
      kid: "envelope-key",
      expiresAtMs: 1700000000000,
    });
    mockVerifyEventsEnvelope.mockRejectedValue(cause);
    const form = new FormData();
    form.append("context_token", "valid-jwt");
    form.append("events_envelope", "valid-jws");
    form.append("events_data", "x");

    let thrown: unknown;
    try {
      await verifyMultipartTokens(fakePool, makeRequest(form));
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(EnvelopeVerificationError);
    const e = thrown as EnvelopeVerificationError;
    expect(e.code).toBe("trust_registry_key_expired");
    expect(e.cause).toBe(cause);
    expect(e.details).toEqual({
      aiceId: "aice-1",
      issuer: "https://aice.test",
      kid: "envelope-key",
      expiresAtMs: 1700000000000,
    });
    expect(e.contextClaims).toEqual(validContextClaims);
  });

  it("wraps other envelope failures as invalid_events_envelope and carries contextClaims", async () => {
    const cause = new Error("payload_hash mismatch");
    mockVerifyEventsEnvelope.mockRejectedValue(cause);
    const form = new FormData();
    form.append("context_token", "valid-jwt");
    form.append("events_envelope", "valid-jws");
    form.append("events_data", "x");

    let thrown: unknown;
    try {
      await verifyMultipartTokens(fakePool, makeRequest(form));
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(EnvelopeVerificationError);
    const e = thrown as EnvelopeVerificationError;
    expect(e.code).toBe("invalid_events_envelope");
    expect(e.contextClaims).toEqual(validContextClaims);
  });
});

// ---------------------------------------------------------------------------
// enforcePhase2CustomerScope
// ---------------------------------------------------------------------------

describe("enforcePhase2CustomerScope", () => {
  function bytes(obj: unknown): Uint8Array {
    return new TextEncoder().encode(JSON.stringify(obj));
  }

  it("resolves customerId from external_key and accepts when source_aice_id matches envelope", async () => {
    mockGetCustomerByExternalKey.mockResolvedValue({
      id: "00000000-0000-0000-0000-000000000001",
      externalKey: "ext-key-1",
      name: "Customer A",
      description: null,
      status: "active",
      databaseStatus: "active",
      wrappedDek: null,
    });

    const result = await enforcePhase2CustomerScope(
      fakePool,
      bytes({ external_key: "ext-key-1", source_aice_id: "aice-1" }),
      validContextClaims,
      validEnvelopeClaims,
    );
    expect(result).toEqual({
      customerId: "00000000-0000-0000-0000-000000000001",
      externalKey: "ext-key-1",
    });
  });

  it("accepts payload without source_aice_id (covers #219 withdraw shape)", async () => {
    mockGetCustomerByExternalKey.mockResolvedValue({
      id: "uuid-2",
      externalKey: "ext-key-1",
      name: "Customer A",
      description: null,
      status: "active",
      databaseStatus: "active",
      wrappedDek: null,
    });

    const result = await enforcePhase2CustomerScope(
      fakePool,
      bytes({ external_key: "ext-key-1", withdrawals: [] }),
      validContextClaims,
      validEnvelopeClaims,
    );
    expect(result.customerId).toBe("uuid-2");
  });

  it("rejects malformed JSON payload", async () => {
    await expect(
      enforcePhase2CustomerScope(
        fakePool,
        new TextEncoder().encode("{not json"),
        validContextClaims,
        validEnvelopeClaims,
      ),
    ).rejects.toMatchObject({ code: "malformed_payload" });
  });

  it("rejects payload missing external_key", async () => {
    await expect(
      enforcePhase2CustomerScope(
        fakePool,
        bytes({ source_aice_id: "aice-1" }),
        validContextClaims,
        validEnvelopeClaims,
      ),
    ).rejects.toMatchObject({ code: "missing_external_key" });
  });

  it("rejects external_key not in contextClaims.customerIds", async () => {
    await expect(
      enforcePhase2CustomerScope(
        fakePool,
        bytes({ external_key: "ext-key-other" }),
        validContextClaims,
        validEnvelopeClaims,
      ),
    ).rejects.toMatchObject({
      code: "payload_customer_not_authorized",
      details: { externalKey: "ext-key-other" },
    });
  });

  it("rejects source_aice_id mismatch with envelope aice_id", async () => {
    await expect(
      enforcePhase2CustomerScope(
        fakePool,
        bytes({ external_key: "ext-key-1", source_aice_id: "aice-other" }),
        validContextClaims,
        validEnvelopeClaims,
      ),
    ).rejects.toMatchObject({
      code: "envelope_payload_aice_id_mismatch",
      details: { payloadAiceId: "aice-other", envelopeAiceId: "aice-1" },
    });
  });

  it("rejects when external_key does not resolve to a customer row", async () => {
    mockGetCustomerByExternalKey.mockResolvedValue(null);
    await expect(
      enforcePhase2CustomerScope(
        fakePool,
        bytes({ external_key: "ext-key-1" }),
        validContextClaims,
        validEnvelopeClaims,
      ),
    ).rejects.toMatchObject({
      code: "customer_not_found",
      details: { externalKey: "ext-key-1" },
    });
  });
});

// ---------------------------------------------------------------------------
// verifyPhase2Multipart — convenience wrapper
// ---------------------------------------------------------------------------

describe("verifyPhase2Multipart", () => {
  it("rejects a session-only handoff (no envelope) — Phase 2 requires events_envelope", async () => {
    const form = new FormData();
    form.append("context_token", "valid-jwt");

    await expect(
      verifyPhase2Multipart(fakePool, makeRequest(form)),
    ).rejects.toMatchObject({ code: "missing_events_envelope" });
  });

  it("returns the full VerifiedPhase2Envelope on the happy path", async () => {
    mockVerifyEventsEnvelope.mockResolvedValue(validEnvelopeClaims);
    mockGetCustomerByExternalKey.mockResolvedValue({
      id: "uuid-3",
      externalKey: "ext-key-1",
      name: "Customer A",
      description: null,
      status: "active",
      databaseStatus: "active",
      wrappedDek: null,
    });

    const form = new FormData();
    form.append("context_token", "valid-jwt");
    form.append("events_envelope", "valid-jws");
    form.append(
      "events_data",
      '{"external_key":"ext-key-1","source_aice_id":"aice-1"}',
    );

    const result = await verifyPhase2Multipart(fakePool, makeRequest(form));
    expect(result.customerId).toBe("uuid-3");
    expect(result.externalKey).toBe("ext-key-1");
    expect(result.envelopeClaims).toEqual(validEnvelopeClaims);
    expect(result.contextClaims).toEqual(validContextClaims);
  });

  it("does NOT consume contextClaims.jti — caller MUST handle replay", async () => {
    // Documentation guarantee: the helper performs no jti bookkeeping. Two
    // back-to-back calls with the same jti both succeed, which is exactly
    // why Phase 2 callers must consume jti against their own replay store
    // before any side-effects.
    mockVerifyEventsEnvelope.mockResolvedValue(validEnvelopeClaims);
    mockGetCustomerByExternalKey.mockResolvedValue({
      id: "uuid-4",
      externalKey: "ext-key-1",
      name: "Customer A",
      description: null,
      status: "active",
      databaseStatus: "active",
      wrappedDek: null,
    });

    function build(): NextRequest {
      const form = new FormData();
      form.append("context_token", "valid-jwt");
      form.append("events_envelope", "valid-jws");
      form.append("events_data", '{"external_key":"ext-key-1"}');
      return makeRequest(form);
    }

    const a = await verifyPhase2Multipart(fakePool, build());
    const b = await verifyPhase2Multipart(fakePool, build());
    expect(a.contextClaims.jti).toBe(b.contextClaims.jti);
  });
});
