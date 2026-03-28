import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

const mockStageManualUpload = vi.fn();
const mockEncryptPayload = vi.fn();
const mockPoolQuery = vi.fn();
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
    }),
);

vi.mock("@/lib/auth/staged-events", () => ({
  stageManualUpload: (...args: unknown[]) => mockStageManualUpload(...args),
}));

vi.mock("@/lib/crypto/envelope", () => ({
  encryptPayload: (...args: unknown[]) => mockEncryptPayload(...args),
}));

vi.mock("@/lib/auth/audit-stub", () => ({
  auditLog: vi.fn(async () => {}),
}));

vi.mock("@/lib/auth/guards", () => ({
  // biome-ignore lint/complexity/noBannedTypes: test mock needs generic callable
  withAuth: (handler: Function) => mockWithAuth(handler),
  verifyOrigin: () => null,
  verifyCsrf: () => null,
}));

vi.mock("@/lib/db/client", () => ({
  getAuthPool: vi.fn(() => ({ query: mockPoolQuery })),
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
    // Default: account has access to the customer
    mockPoolQuery.mockResolvedValue({ rows: [{ "?column?": 1 }] });
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
    // Create a file that exceeds the default 50MB cap
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

  it("returns 403 when account has no access to customer", async () => {
    // Non-bridge session: access check query returns no rows
    mockPoolQuery.mockResolvedValue({ rows: [] });

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
  });

  it("returns 403 when aice_id does not match bridge scope", async () => {
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
          bridgeAiceId: "aice-real",
          bridgeCustomerIds: [CUSTOMER_ID],
        }),
    );

    vi.resetModules();
    const { POST } = await import("../ingest/route");

    const file = new File([new Uint8Array([1, 2, 3])], "events.bin");
    const form = new FormData();
    form.append("events_data", file);
    form.append("customer_id", CUSTOMER_ID);
    form.append("aice_id", "aice-wrong");
    form.append("schema_version", "1.0");
    form.append("event_count", "5");
    const req = new NextRequest("http://localhost:3000/api/events/ingest", {
      method: "POST",
      body: form,
      headers: { origin: "http://localhost:3000" },
    });

    const res = await POST(req);
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error).toContain("aice_id");
  });

  it("returns 403 when customer not in bridgeCustomerIds", async () => {
    // Override the mock to include bridgeCustomerIds that exclude CUSTOMER_ID
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
          bridgeCustomerIds: ["b0000000-0000-0000-0000-000000000099"],
        }),
    );

    // Reset module cache so the route re-evaluates withAuth
    vi.resetModules();
    const { POST } = await import("../ingest/route");

    const file = new File([new Uint8Array([1, 2, 3])], "events.bin");
    const req = makeIngestRequest({
      events_data: file,
      customer_id: CUSTOMER_ID,
      aice_id: "aice-1",
      schema_version: "1.0",
      event_count: "5",
    });

    const res = await POST(req);
    expect(res.status).toBe(403);
  });
});
