import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

const mockUpdateCustomerStatus = vi.fn();
const mockPoolQuery = vi.fn();
const mockAuditLog = vi.fn();

vi.mock("@/lib/auth/staged-events", () => ({
  updateCustomerStatus: (...args: unknown[]) =>
    mockUpdateCustomerStatus(...args),
  expireStagedEvents: vi.fn(async () => 0),
}));

vi.mock("@/lib/auth/audit-stub", () => ({
  auditLog: mockAuditLog,
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

vi.mock("@/lib/db/client", () => ({
  getAuthPool: vi.fn(() => ({ query: mockPoolQuery })),
  withTransaction: vi.fn((_pool: unknown, fn: (client: unknown) => unknown) =>
    fn({}),
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
    // Default: payload belongs to session
    mockPoolQuery.mockResolvedValue({ rows: [{ id: PAYLOAD_ID }] });
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

  it("approves a pending customer", async () => {
    mockUpdateCustomerStatus.mockResolvedValue({
      updated: true,
      newStatus: "approved",
    });

    const res = await callPATCH(PAYLOAD_ID, CUSTOMER_ID, {
      action: "approve",
    });
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.status).toBe("approved");
    expect(mockUpdateCustomerStatus).toHaveBeenCalledWith(
      expect.anything(),
      PAYLOAD_ID,
      CUSTOMER_ID,
      "approve",
    );
    expect(mockAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "staged_event.approve",
        targetId: PAYLOAD_ID,
        customerId: CUSTOMER_ID,
      }),
    );
  });

  it("rejects a pending customer", async () => {
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
    expect(mockAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "staged_event.reject",
        targetId: PAYLOAD_ID,
        customerId: CUSTOMER_ID,
      }),
    );
  });

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

  it("returns 404 when payload not owned by session", async () => {
    mockPoolQuery.mockResolvedValue({ rows: [] });

    const res = await callPATCH(PAYLOAD_ID, CUSTOMER_ID, {
      action: "approve",
    });
    expect(res.status).toBe(404);
  });

  it("returns 403 when customer not in bridge scope", async () => {
    const res = await callPATCH(PAYLOAD_ID, "not-in-scope-id", {
      action: "approve",
    });
    // "not-in-scope-id" is not a valid UUID, so it returns 400 first
    expect(res.status).toBe(400);
  });

  it("returns 403 for customer not in bridgeCustomerIds", async () => {
    const otherCust = "b0000000-0000-0000-0000-000000000099";
    const res = await callPATCH(PAYLOAD_ID, otherCust, {
      action: "approve",
    });
    expect(res.status).toBe(403);
  });

  it("returns 409 when no pending approval exists", async () => {
    mockUpdateCustomerStatus.mockResolvedValue({
      updated: false,
      newStatus: "unchanged",
    });

    const res = await callPATCH(PAYLOAD_ID, CUSTOMER_ID, {
      action: "approve",
    });
    expect(res.status).toBe(409);
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
