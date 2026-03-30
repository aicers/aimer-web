import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

const mockUpdateCustomerStatus = vi.fn();
const mockGetStagedPayloadDecrypted = vi.fn();
const mockPoolQuery = vi.fn();
const mockAuditLog = vi.fn();
const mockAuthorize = vi.fn();
const mockStoreApprovedEvents = vi.fn();

vi.mock("@/lib/auth/staged-events", () => ({
  updateCustomerStatus: (...args: unknown[]) =>
    mockUpdateCustomerStatus(...args),
  getStagedPayloadDecrypted: (...args: unknown[]) =>
    mockGetStagedPayloadDecrypted(...args),
  expireStagedEvents: vi.fn(async () => 0),
}));

vi.mock("@/lib/audit", () => ({
  auditLog: mockAuditLog,
}));

vi.mock("@/lib/auth/authorization", () => ({
  authorize: (...args: unknown[]) => mockAuthorize(...args),
}));

vi.mock("@/lib/auth/event-storage", () => ({
  storeApprovedEvents: (...args: unknown[]) => mockStoreApprovedEvents(...args),
}));

vi.mock("@/lib/auth/guards", () => ({
  // biome-ignore lint/complexity/noBannedTypes: test mock needs generic callable
  withAuth: (handler: Function) => (req: NextRequest) =>
    handler(req, {
      accountId: "acct-1",
      sessionId: "sess-1",
      authContext: "general",
      tokenVersion: 1,
      iat: 1000,
      meta: { ipAddress: "127.0.0.1", userAgent: "test" },
      bridgeAiceId: "aice-1",
      bridgeCustomerIds: [
        "b0000000-0000-0000-0000-000000000001",
        "b0000000-0000-0000-0000-000000000002",
      ],
    }),
  verifyOrigin: () => null,
  verifyCsrf: () => null,
}));

const mockClientQuery = vi.fn();

vi.mock("@/lib/db/client", () => ({
  getAuthPool: vi.fn(() => ({ query: mockPoolQuery })),
  withTransaction: vi.fn((_pool: unknown, fn: (client: unknown) => unknown) =>
    fn({ query: mockClientQuery }),
  ),
}));

const PAYLOAD_ID = "a0000000-0000-0000-0000-000000000001";
const CUSTOMER_ID = "b0000000-0000-0000-0000-000000000001";

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("PATCH /api/events/staged/[payloadId]/customers/[customerId]", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Default: payload belongs to session with metadata
    mockPoolQuery.mockResolvedValue({
      rows: [
        {
          id: PAYLOAD_ID,
          aice_id: "aice-1",
          event_count: 5,
          schema_version: "1.0",
          connection_id: null,
        },
      ],
    });
    // Default: FOR UPDATE claim succeeds (pending row exists)
    mockClientQuery.mockResolvedValue({ rows: [{}] });
    // Default: authorized
    mockAuthorize.mockResolvedValue({ authorized: true });
    // Default: decrypted payload available
    mockGetStagedPayloadDecrypted.mockResolvedValue({
      payload: Buffer.from("decrypted-data"),
      payloadHash: "abc123",
    });
    mockStoreApprovedEvents.mockResolvedValue("event-id-1");
    mockUpdateCustomerStatus.mockResolvedValue({
      updated: true,
      newStatus: "approved",
    });
  });

  async function callPATCH(
    payloadId: string,
    customerId: string,
    body: unknown,
  ) {
    const { PATCH } = await import(
      "../staged/[payloadId]/customers/[customerId]/route"
    );
    const req = new NextRequest(
      `http://localhost:3000/api/events/staged/${payloadId}/customers/${customerId}`,
      {
        method: "PATCH",
        headers: {
          "Content-Type": "application/json",
          origin: "http://localhost:3000",
        },
        body: JSON.stringify(body),
      },
    );
    return PATCH(req);
  }

  // -----------------------------------------------------------------------
  // Happy path
  // -----------------------------------------------------------------------

  it("approves and stores events in customer_db", async () => {
    const res = await callPATCH(PAYLOAD_ID, CUSTOMER_ID, {
      action: "approve",
    });
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.status).toBe("approved");
    expect(body.eventId).toBe("event-id-1");

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
      }),
    );
    expect(mockStoreApprovedEvents).toHaveBeenCalledWith(
      expect.objectContaining({
        customerId: CUSTOMER_ID,
        aiceId: "aice-1",
        eventCount: 5,
        source: "manual",
        connectionId: null,
        ingestedBy: "acct-1",
        plaintext: Buffer.from("decrypted-data"),
        payloadHash: "abc123",
      }),
    );
    expect(mockAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "detection_events.transfer_approved",
        targetId: PAYLOAD_ID,
        customerId: CUSTOMER_ID,
      }),
    );
  });

  it("stores events BEFORE updating status (atomicity)", async () => {
    const callOrder: string[] = [];
    mockGetStagedPayloadDecrypted.mockImplementation(async () => {
      callOrder.push("decrypt");
      return {
        payload: Buffer.from("decrypted-data"),
        payloadHash: "abc123",
      };
    });
    mockStoreApprovedEvents.mockImplementation(async () => {
      callOrder.push("store");
      return "event-id-1";
    });
    mockUpdateCustomerStatus.mockImplementation(async () => {
      callOrder.push("updateStatus");
      return { updated: true, newStatus: "approved" };
    });

    await callPATCH(PAYLOAD_ID, CUSTOMER_ID, { action: "approve" });

    expect(callOrder).toEqual(["decrypt", "store", "updateStatus"]);
  });

  it("sets source to 'bridge' when connection_id is present", async () => {
    mockPoolQuery.mockResolvedValue({
      rows: [
        {
          id: PAYLOAD_ID,
          aice_id: "aice-1",
          event_count: 3,
          schema_version: "2.0",
          connection_id: "c0000000-0000-0000-0000-000000000001",
        },
      ],
    });

    const res = await callPATCH(PAYLOAD_ID, CUSTOMER_ID, {
      action: "approve",
    });
    expect(res.status).toBe(200);

    expect(mockStoreApprovedEvents).toHaveBeenCalledWith(
      expect.objectContaining({
        source: "bridge",
        connectionId: "c0000000-0000-0000-0000-000000000001",
      }),
    );
  });

  it("does not decrypt or store events on reject", async () => {
    mockUpdateCustomerStatus.mockResolvedValue({
      updated: true,
      newStatus: "rejected",
    });

    const res = await callPATCH(PAYLOAD_ID, CUSTOMER_ID, {
      action: "reject",
    });
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.status).toBe("rejected");
    expect(body.eventId).toBeUndefined();
    expect(mockGetStagedPayloadDecrypted).not.toHaveBeenCalled();
    expect(mockStoreApprovedEvents).not.toHaveBeenCalled();
  });

  it("passes bridge scope to authorize()", async () => {
    await callPATCH(PAYLOAD_ID, CUSTOMER_ID, { action: "approve" });

    expect(mockAuthorize).toHaveBeenCalledWith(
      expect.anything(),
      "general",
      "acct-1",
      "analyses:create",
      expect.objectContaining({
        bridgeScope: {
          aiceId: "aice-1",
          customerIds: [
            "b0000000-0000-0000-0000-000000000001",
            "b0000000-0000-0000-0000-000000000002",
          ],
        },
      }),
    );
  });

  // -----------------------------------------------------------------------
  // Authorization failures
  // -----------------------------------------------------------------------

  it("returns 403 and logs audit when authorize() denies access", async () => {
    mockAuthorize.mockResolvedValue({ authorized: false });

    const res = await callPATCH(PAYLOAD_ID, CUSTOMER_ID, {
      action: "approve",
    });
    expect(res.status).toBe(403);
    expect(mockUpdateCustomerStatus).not.toHaveBeenCalled();
    expect(mockStoreApprovedEvents).not.toHaveBeenCalled();
    expect(mockAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "detection_events.transfer_denied",
        details: expect.objectContaining({
          reason: "authorization_failed",
        }),
      }),
    );
  });

  it("returns 403 for customer not in bridgeCustomerIds", async () => {
    const otherCust = "b0000000-0000-0000-0000-000000000099";
    mockAuthorize.mockResolvedValue({ authorized: false });

    const res = await callPATCH(PAYLOAD_ID, otherCust, {
      action: "approve",
    });
    expect(res.status).toBe(403);
  });

  // -----------------------------------------------------------------------
  // Storage failures (approve path)
  // -----------------------------------------------------------------------

  it("returns 404 when staged payload cannot be decrypted", async () => {
    mockGetStagedPayloadDecrypted.mockResolvedValue(null);

    const res = await callPATCH(PAYLOAD_ID, CUSTOMER_ID, {
      action: "approve",
    });
    expect(res.status).toBe(404);
    expect(mockUpdateCustomerStatus).not.toHaveBeenCalled();
  });

  it("propagates storage error, logs failure audit, and does not update status", async () => {
    mockStoreApprovedEvents.mockRejectedValue(
      new Error("customer_db unavailable"),
    );

    await expect(
      callPATCH(PAYLOAD_ID, CUSTOMER_ID, { action: "approve" }),
    ).rejects.toThrow("customer_db unavailable");

    // Status must NOT be updated — staged status stays "pending"
    expect(mockUpdateCustomerStatus).not.toHaveBeenCalled();
    expect(mockAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "detection_events.transfer_failed",
        details: expect.objectContaining({
          reason: "storage_error",
          error: "customer_db unavailable",
        }),
      }),
    );
  });

  // -----------------------------------------------------------------------
  // Validation failures
  // -----------------------------------------------------------------------

  it("returns 400 for invalid action", async () => {
    const res = await callPATCH(PAYLOAD_ID, CUSTOMER_ID, {
      action: "delete",
    });
    expect(res.status).toBe(400);

    const body = await res.json();
    expect(body.error).toContain("approve");
  });

  it("returns 400 for invalid payloadId UUID", async () => {
    const res = await callPATCH("not-uuid", CUSTOMER_ID, {
      action: "approve",
    });
    expect(res.status).toBe(400);
  });

  it("returns 400 for invalid customerId UUID", async () => {
    const res = await callPATCH(PAYLOAD_ID, "not-uuid", {
      action: "approve",
    });
    expect(res.status).toBe(400);
  });

  it("returns 404 and logs audit when payload not owned by session", async () => {
    mockPoolQuery.mockResolvedValue({ rows: [] });

    const res = await callPATCH(PAYLOAD_ID, CUSTOMER_ID, {
      action: "approve",
    });
    expect(res.status).toBe(404);
    expect(mockAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "detection_events.transfer_not_found",
        details: expect.objectContaining({
          reason: "payload_not_owned",
        }),
      }),
    );
  });

  it("returns 409 when no pending approval exists (reject)", async () => {
    mockUpdateCustomerStatus.mockResolvedValue({
      updated: false,
      newStatus: "unchanged",
    });

    const res = await callPATCH(PAYLOAD_ID, CUSTOMER_ID, {
      action: "reject",
    });
    expect(res.status).toBe(409);
    expect(mockAuditLog).not.toHaveBeenCalled();
  });

  it("returns 409 when no pending approval exists (approve)", async () => {
    // FOR UPDATE claim finds no pending row
    mockClientQuery.mockResolvedValue({ rows: [] });

    const res = await callPATCH(PAYLOAD_ID, CUSTOMER_ID, {
      action: "approve",
    });
    expect(res.status).toBe(409);
    expect(mockStoreApprovedEvents).not.toHaveBeenCalled();
    expect(mockAuditLog).not.toHaveBeenCalled();
  });

  it("returns 400 for invalid JSON body", async () => {
    const { PATCH } = await import(
      "../staged/[payloadId]/customers/[customerId]/route"
    );
    const req = new NextRequest(
      `http://localhost:3000/api/events/staged/${PAYLOAD_ID}/customers/${CUSTOMER_ID}`,
      {
        method: "PATCH",
        headers: {
          "Content-Type": "application/json",
          origin: "http://localhost:3000",
        },
        body: "not json",
      },
    );
    const res = await PATCH(req);
    expect(res.status).toBe(400);
  });
});
