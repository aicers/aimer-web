import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { TrustRegistryKeyExpiredError } from "@/lib/auth/errors";

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

const mockVerifyContextToken = vi.fn();
const mockVerifyEventsEnvelope = vi.fn();
const mockCreatePendingConnection = vi.fn();
const mockStageEventsPayload = vi.fn();
const setConnectionIdCookie = vi.fn();
const clearInvitationTokenCookie = vi.fn();
const mockAuditLog = vi.fn(async (..._args: unknown[]) => {});

vi.mock("@/lib/auth/context-token", () => ({
  verifyContextToken: (...args: unknown[]) => mockVerifyContextToken(...args),
}));

vi.mock("@/lib/auth/events-envelope", () => ({
  verifyEventsEnvelope: (...args: unknown[]) =>
    mockVerifyEventsEnvelope(...args),
}));

vi.mock("@/lib/auth/bridge", () => ({
  createPendingConnection: (...args: unknown[]) =>
    mockCreatePendingConnection(...args),
  stageEventsPayload: (...args: unknown[]) => mockStageEventsPayload(...args),
}));

vi.mock("@/lib/auth/cookies", () => ({
  setConnectionIdCookie,
  clearInvitationTokenCookie,
}));

vi.mock("@/lib/audit", () => ({
  auditLog: (...args: unknown[]) => mockAuditLog(...args),
  UNKNOWN_ACTOR_ID: "unknown",
}));

vi.mock("@/lib/db/client", () => ({
  getAuthPool: vi.fn(() => ({})),
}));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeFormData(fields: Record<string, string | Blob>): FormData {
  const form = new FormData();
  for (const [key, value] of Object.entries(fields)) {
    form.append(key, value);
  }
  return form;
}

function makeBridgeRequest(body: FormData): NextRequest {
  return new NextRequest("http://localhost:3000/api/auth/bridge", {
    method: "POST",
    body,
  });
}

const validContextClaims = {
  iss: "https://aice.test",
  aud: "aimer-web",
  sub: "user-001",
  aiceId: "aice-1",
  customerIds: ["cust-ext-1"],
  iat: 1000,
  exp: 2000,
  jti: "unique-jti",
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("POST /api/auth/bridge", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockVerifyContextToken.mockResolvedValue(validContextClaims);
    mockCreatePendingConnection.mockResolvedValue("conn-id-1");
  });

  async function callPOST(req: NextRequest) {
    const { POST } = await import("../bridge/route");
    return POST(req);
  }

  it("accepts valid context token and redirects to sign-in", async () => {
    const form = makeFormData({ context_token: "valid-jwt" });
    const res = await callPOST(makeBridgeRequest(form));

    expect(res.status).toBe(307);
    expect(res.headers.get("location")).toContain(
      "/api/auth/sign-in?flow=bridge",
    );
    expect(setConnectionIdCookie).toHaveBeenCalledWith("conn-id-1");
    expect(clearInvitationTokenCookie).toHaveBeenCalled();
    expect(mockCreatePendingConnection).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        jti: "unique-jti",
        aiceId: "aice-1",
        customerIds: ["cust-ext-1"],
      }),
    );
  });

  it("returns 400 for missing context_token", async () => {
    const form = makeFormData({});
    const res = await callPOST(makeBridgeRequest(form));

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toContain("context_token");
  });

  it("returns 403 for invalid context token", async () => {
    mockVerifyContextToken.mockRejectedValue(new Error("bad signature"));
    const form = makeFormData({ context_token: "invalid-jwt" });
    const res = await callPOST(makeBridgeRequest(form));

    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error).toContain("Invalid context token");
  });

  it("audits expired context token with innerReason: trust_registry_key_expired", async () => {
    const expiresAtMs = Date.parse("2026-05-01T00:00:00Z");
    mockVerifyContextToken.mockRejectedValue(
      new TrustRegistryKeyExpiredError("trust_registry key expired", {
        aiceId: "aice-1",
        issuer: "https://aice.test",
        kid: "key-1",
        expiresAtMs,
      }),
    );

    const form = makeFormData({ context_token: "expired-jwt" });
    const res = await callPOST(makeBridgeRequest(form));

    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error).toBe("Invalid context token");

    expect(mockAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "bridge.connection_denied",
        details: expect.objectContaining({
          reason: "context_token_rejected",
          innerReason: "trust_registry_key_expired",
          aiceId: "aice-1",
          issuer: "https://aice.test",
          kid: "key-1",
          expiresAt: new Date(expiresAtMs).toISOString(),
        }),
      }),
    );
  });

  it("audits expired events envelope with innerReason: trust_registry_key_expired", async () => {
    const expiresAtMs = Date.parse("2026-05-01T00:00:00Z");
    mockVerifyEventsEnvelope.mockRejectedValue(
      new TrustRegistryKeyExpiredError("trust_registry key expired", {
        aiceId: "aice-1",
        issuer: "https://aice.test",
        kid: "envelope-key",
        expiresAtMs,
      }),
    );

    const eventsBlob = new File([new Uint8Array([1, 2, 3])], "events.bin");
    const form = makeFormData({
      context_token: "valid-jwt",
      events_envelope: "expired-jws",
      events_data: eventsBlob,
    });
    const res = await callPOST(makeBridgeRequest(form));

    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error).toBe("Invalid events envelope");

    expect(mockAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "bridge.connection_denied",
        actorId: validContextClaims.sub,
        aiceId: validContextClaims.aiceId,
        details: expect.objectContaining({
          reason: "envelope_rejected",
          innerReason: "trust_registry_key_expired",
          kid: "envelope-key",
          expiresAt: new Date(expiresAtMs).toISOString(),
          jti: validContextClaims.jti,
        }),
      }),
    );
  });

  it("returns 409 for jti replay (duplicate)", async () => {
    const jtiError = new Error(
      'duplicate key value violates unique constraint "pending_connections_jti_key"',
    );
    mockCreatePendingConnection.mockRejectedValue(jtiError);

    const form = makeFormData({ context_token: "valid-jwt" });
    const res = await callPOST(makeBridgeRequest(form));

    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error).toContain("already used");
  });

  it("accepts context token with events envelope", async () => {
    mockVerifyEventsEnvelope.mockResolvedValue({
      iss: "https://aice.test",
      aiceId: "aice-1",
      customerIds: ["cust-ext-1"],
      contextJti: "unique-jti",
      payloadHash: "abc123",
      eventCount: 10,
      schemaVersion: "1.0",
    });
    mockStageEventsPayload.mockResolvedValue("staged-id-1");

    const eventsBlob = new File([new Uint8Array([1, 2, 3])], "events.bin");
    const form = makeFormData({
      context_token: "valid-jwt",
      events_envelope: "valid-jws",
      events_data: eventsBlob,
    });
    const res = await callPOST(makeBridgeRequest(form));

    expect(res.status).toBe(307);
    expect(mockStageEventsPayload).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        connectionId: "conn-id-1",
        aiceId: "aice-1",
        payloadHash: "abc123",
      }),
    );
  });

  it("returns 403 for invalid events envelope", async () => {
    mockVerifyEventsEnvelope.mockRejectedValue(
      new Error("payload_hash mismatch"),
    );

    const eventsBlob = new File([new Uint8Array([1, 2, 3])], "events.bin");
    const form = makeFormData({
      context_token: "valid-jwt",
      events_envelope: "invalid-jws",
      events_data: eventsBlob,
    });
    const res = await callPOST(makeBridgeRequest(form));

    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error).toContain("Invalid events envelope");
  });

  it("returns 400 for envelope without events_data", async () => {
    const form = makeFormData({
      context_token: "valid-jwt",
      events_envelope: "some-jws",
    });
    const res = await callPOST(makeBridgeRequest(form));

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toContain("events_data");
  });

  it("returns 400 for events_data without envelope", async () => {
    const eventsBlob = new File([new Uint8Array([1, 2, 3])], "events.bin");
    const form = new FormData();
    form.append("context_token", "valid-jwt");
    form.append("events_data", eventsBlob);
    const res = await callPOST(makeBridgeRequest(form));

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toContain("events_envelope");
  });

  it("accepts events_data as a string (text part)", async () => {
    mockVerifyEventsEnvelope.mockResolvedValue({
      iss: "https://aice.test",
      aiceId: "aice-1",
      customerIds: ["cust-ext-1"],
      contextJti: "unique-jti",
      payloadHash: "abc123",
      eventCount: 1,
      schemaVersion: "0.0-stub",
    });
    mockStageEventsPayload.mockResolvedValue("staged-id-text");

    const jsonString = '{"hello":"world","schema_version":"0.0-stub"}';
    const form = makeFormData({
      context_token: "valid-jwt",
      events_envelope: "valid-jws",
      events_data: jsonString,
    });
    const res = await callPOST(makeBridgeRequest(form));

    expect(res.status).toBe(307);
    const verifyCall = mockVerifyEventsEnvelope.mock.calls[0];
    const passedBytes = verifyCall[2] as Uint8Array;
    expect(passedBytes).toEqual(new TextEncoder().encode(jsonString));
  });

  it("preserves leading/trailing whitespace in string events_data", async () => {
    mockVerifyEventsEnvelope.mockResolvedValue({
      iss: "https://aice.test",
      aiceId: "aice-1",
      customerIds: ["cust-ext-1"],
      contextJti: "unique-jti",
      payloadHash: "ws-hash",
      eventCount: 0,
      schemaVersion: "0.0-stub",
    });
    mockStageEventsPayload.mockResolvedValue("staged-id-ws");

    const padded = '   {"a":1}   ';
    const form = makeFormData({
      context_token: "valid-jwt",
      events_envelope: "valid-jws",
      events_data: padded,
    });
    const res = await callPOST(makeBridgeRequest(form));

    expect(res.status).toBe(307);
    const passedBytes = mockVerifyEventsEnvelope.mock.calls[0][2] as Uint8Array;
    expect(passedBytes).toEqual(new TextEncoder().encode(padded));
  });

  it("returns 400 for empty string events_data", async () => {
    const form = makeFormData({
      context_token: "valid-jwt",
      events_envelope: "some-jws",
      events_data: "",
    });
    const res = await callPOST(makeBridgeRequest(form));

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toContain("events_data");
    expect(mockVerifyEventsEnvelope).not.toHaveBeenCalled();
  });

  it("returns 400 for string events_data without envelope", async () => {
    const form = makeFormData({
      context_token: "valid-jwt",
      events_data: '{"hello":"world"}',
    });
    const res = await callPOST(makeBridgeRequest(form));

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toContain("events_envelope");
    expect(mockVerifyEventsEnvelope).not.toHaveBeenCalled();
  });

  it("returns 400 for empty events_data without envelope (presence detected)", async () => {
    const form = makeFormData({
      context_token: "valid-jwt",
      events_data: "",
    });
    const res = await callPOST(makeBridgeRequest(form));

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toContain("events_envelope");
    expect(mockVerifyEventsEnvelope).not.toHaveBeenCalled();
    expect(mockCreatePendingConnection).not.toHaveBeenCalled();
  });

  it("propagates payload_hash mismatch as 403 for string events_data", async () => {
    mockVerifyEventsEnvelope.mockRejectedValue(
      new Error("Events envelope payload_hash mismatch"),
    );

    const form = makeFormData({
      context_token: "valid-jwt",
      events_envelope: "valid-jws",
      events_data: '{"hello":"world"}',
    });
    const res = await callPOST(makeBridgeRequest(form));

    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error).toContain("Invalid events envelope");
  });

  it("propagates non-jti database errors as 500", async () => {
    mockCreatePendingConnection.mockRejectedValue(
      new Error("connection refused"),
    );

    const form = makeFormData({ context_token: "valid-jwt" });
    await expect(callPOST(makeBridgeRequest(form))).rejects.toThrow(
      "connection refused",
    );
  });
});
