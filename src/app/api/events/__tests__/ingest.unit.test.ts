import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

const mockStageManualUpload = vi.fn();
const mockEncryptPayload = vi.fn();
const mockAuthorize = vi.fn();
const mockWithAuth = vi.fn(
  // biome-ignore lint/complexity/noBannedTypes: test mock needs generic callable
  (handler: Function) => (req: NextRequest) =>
    handler(req, {
      accountId: "acct-1",
      sessionId: "sess-1",
      authContext: "general",
      tokenVersion: 1,
      iat: 1000,
      meta: { ipAddress: "127.0.0.1", userAgent: "test" },
      bridgeAiceId: null,
      bridgeCustomerIds: null,
      audit: {},
    }),
);

vi.mock("@/lib/auth/staged-events", () => ({
  stageManualUpload: (...args: unknown[]) => mockStageManualUpload(...args),
}));

vi.mock("@/lib/crypto/envelope", () => ({
  encryptPayload: (...args: unknown[]) => mockEncryptPayload(...args),
}));

const mockAuditLog = vi.fn(async () => {});
vi.mock("@/lib/audit", () => ({
  auditLog: mockAuditLog,
}));

vi.mock("@/lib/auth/authorization", () => ({
  authorize: (...args: unknown[]) => mockAuthorize(...args),
}));

vi.mock("@/lib/auth/guards", () => ({
  // biome-ignore lint/complexity/noBannedTypes: test mock needs generic callable
  withAuth: (handler: Function) => mockWithAuth(handler),
  verifyOrigin: () => null,
  verifyCsrf: () => null,
}));

vi.mock("@/lib/db/client", () => ({
  getAuthPool: vi.fn(() => ({ query: vi.fn() })),
  withTransaction: vi.fn((_pool: unknown, fn: (client: unknown) => unknown) =>
    fn({}),
  ),
}));

const CUSTOMER_ID = "a0000000-0000-0000-0000-000000000001";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeIngestRequest(fields: Record<string, string | File>): NextRequest {
  const form = new FormData();
  for (const [key, value] of Object.entries(fields)) {
    form.append(key, value);
  }
  return new NextRequest("http://localhost:3000/api/events/ingest", {
    method: "POST",
    body: form,
    headers: { origin: "http://localhost:3000" },
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("POST /api/events/ingest", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockEncryptPayload.mockResolvedValue({
      ciphertext: Buffer.from("encrypted"),
      wrappedDek: "vault:v1:testkey",
    });
    mockStageManualUpload.mockResolvedValue("payload-id-1");
    // Default: authorized
    mockAuthorize.mockResolvedValue({ authorized: true });
  });

  async function callPOST(req: NextRequest) {
    const { POST } = await import("../ingest/route");
    return POST(req);
  }

  it("stages a manually uploaded file", async () => {
    const file = new File([new Uint8Array([1, 2, 3])], "events.bin");
    const req = makeIngestRequest({
      events_data: file,
      customer_id: CUSTOMER_ID,
      aice_id: "aice-1",
      schema_version: "1.0",
      event_count: "5",
    });

    const res = await callPOST(req);
    expect(res.status).toBe(201);

    const body = await res.json();
    expect(body.payloadId).toBe("payload-id-1");
    expect(body.eventCount).toBe(5);

    expect(mockAuthorize).toHaveBeenCalledWith(
      expect.anything(),
      "general",
      "acct-1",
      "analyses:create",
      expect.objectContaining({
        customerId: CUSTOMER_ID,
        aiceId: "aice-1",
        requiresAiceId: true,
        operationKind: "ingest",
        bridgeScope: null,
      }),
    );
    expect(mockEncryptPayload).toHaveBeenCalledOnce();
    expect(mockStageManualUpload).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        sessionId: "sess-1",
        aiceId: "aice-1",
        customerIds: [CUSTOMER_ID],
      }),
    );
  });

  it("returns 403 and logs denial audit when authorize() denies access", async () => {
    mockAuthorize.mockResolvedValue({ authorized: false });

    const file = new File([new Uint8Array([1, 2, 3])], "events.bin");
    const req = makeIngestRequest({
      events_data: file,
      customer_id: CUSTOMER_ID,
      aice_id: "aice-1",
      schema_version: "1.0",
      event_count: "5",
    });

    const res = await callPOST(req);
    expect(res.status).toBe(403);
    expect(mockAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "detection_events.upload_denied",
        details: expect.objectContaining({
          reason: "authorization_failed",
        }),
      }),
    );
  });

  it("passes bridge scope to authorize() in bridge sessions", async () => {
    mockWithAuth.mockImplementation(
      // biome-ignore lint/complexity/noBannedTypes: test mock needs generic callable
      (handler: Function) => (req: NextRequest) =>
        handler(req, {
          accountId: "acct-1",
          sessionId: "sess-1",
          authContext: "general",
          tokenVersion: 1,
          iat: 1000,
          meta: { ipAddress: "127.0.0.1", userAgent: "test" },
          bridgeAiceId: "aice-1",
          bridgeCustomerIds: [CUSTOMER_ID],
          audit: {},
        }),
    );

    vi.resetModules();
    const { POST } = await import("../ingest/route");

    const file = new File([new Uint8Array([1, 2, 3])], "events.bin");
    const form = new FormData();
    form.append("events_data", file);
    form.append("customer_id", CUSTOMER_ID);
    form.append("aice_id", "aice-1");
    form.append("schema_version", "1.0");
    form.append("event_count", "5");
    const req = new NextRequest("http://localhost:3000/api/events/ingest", {
      method: "POST",
      body: form,
      headers: { origin: "http://localhost:3000" },
    });

    const res = await POST(req);
    expect(res.status).toBe(201);

    expect(mockAuthorize).toHaveBeenCalledWith(
      expect.anything(),
      "general",
      "acct-1",
      "analyses:create",
      expect.objectContaining({
        bridgeScope: {
          aiceId: "aice-1",
          customerIds: [CUSTOMER_ID],
        },
      }),
    );
  });

  it("emits bridge.write_attempt_blocked when authorize returns bridge_write_blocked", async () => {
    mockAuthorize.mockResolvedValue({
      authorized: false,
      reason: "bridge_write_blocked",
    });

    const file = new File([new Uint8Array([1, 2, 3])], "events.bin");
    const req = makeIngestRequest({
      events_data: file,
      customer_id: CUSTOMER_ID,
      aice_id: "aice-1",
      schema_version: "1.0",
      event_count: "5",
    });

    const res = await callPOST(req);
    expect(res.status).toBe(403);

    // Should emit both bridge.write_attempt_blocked AND upload_denied
    expect(mockAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "bridge.write_attempt_blocked",
        details: expect.objectContaining({
          operation: "ingest",
        }),
      }),
    );
    expect(mockAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "detection_events.upload_denied",
        details: expect.objectContaining({
          reason: "bridge_write_blocked",
        }),
      }),
    );
    expect(mockAuditLog).toHaveBeenCalledTimes(2);
  });

  it("returns 400 when events_data is missing", async () => {
    const req = makeIngestRequest({
      customer_id: CUSTOMER_ID,
      aice_id: "aice-1",
      schema_version: "1.0",
      event_count: "5",
    });

    const res = await callPOST(req);
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toContain("events_data");
  });

  it("returns 400 when customer_id is invalid", async () => {
    const file = new File([new Uint8Array([1])], "events.bin");
    const req = makeIngestRequest({
      events_data: file,
      customer_id: "not-a-uuid",
      aice_id: "aice-1",
      schema_version: "1.0",
      event_count: "5",
    });

    const res = await callPOST(req);
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toContain("customer_id");
  });

  it("returns 400 when aice_id is missing", async () => {
    const file = new File([new Uint8Array([1])], "events.bin");
    const req = makeIngestRequest({
      events_data: file,
      customer_id: CUSTOMER_ID,
      schema_version: "1.0",
      event_count: "5",
    });

    const res = await callPOST(req);
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toContain("aice_id");
  });

  it("returns 400 when event_count is invalid", async () => {
    const file = new File([new Uint8Array([1])], "events.bin");
    const req = makeIngestRequest({
      events_data: file,
      customer_id: CUSTOMER_ID,
      aice_id: "aice-1",
      schema_version: "1.0",
      event_count: "abc",
    });

    const res = await callPOST(req);
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toContain("event_count");
  });

  it("returns 400 when event_count is non-integer", async () => {
    const file = new File([new Uint8Array([1])], "events.bin");
    const req = makeIngestRequest({
      events_data: file,
      customer_id: CUSTOMER_ID,
      aice_id: "aice-1",
      schema_version: "1.0",
      event_count: "1.5",
    });

    const res = await callPOST(req);
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toContain("event_count");
  });

  it("returns 400 when schema_version is missing", async () => {
    const file = new File([new Uint8Array([1])], "events.bin");
    const req = makeIngestRequest({
      events_data: file,
      customer_id: CUSTOMER_ID,
      aice_id: "aice-1",
      event_count: "5",
    });

    const res = await callPOST(req);
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toContain("schema_version");
  });

  it("returns 413 when payload exceeds size cap", async () => {
    const originalEnv = process.env.BRIDGE_MAX_PAYLOAD_BYTES;
    process.env.BRIDGE_MAX_PAYLOAD_BYTES = "10"; // 10 bytes cap

    try {
      const file = new File(
        [new Uint8Array(20)], // 20 bytes > 10 byte cap
        "events.bin",
      );
      const req = makeIngestRequest({
        events_data: file,
        customer_id: CUSTOMER_ID,
        aice_id: "aice-1",
        schema_version: "1.0",
        event_count: "5",
      });

      const res = await callPOST(req);
      expect(res.status).toBe(413);
      const body = await res.json();
      expect(body.error).toContain("size");
    } finally {
      if (originalEnv === undefined) {
        delete process.env.BRIDGE_MAX_PAYLOAD_BYTES;
      } else {
        process.env.BRIDGE_MAX_PAYLOAD_BYTES = originalEnv;
      }
    }
  });
});
