import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

const mockGetStagedPayloadById = vi.fn();
const mockPoolQuery = vi.fn();

vi.mock("@/lib/auth/staged-events", () => ({
  getStagedPayloadById: (...args: unknown[]) =>
    mockGetStagedPayloadById(...args),
  expireStagedEvents: vi.fn(async () => 0),
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
      bridgeAiceId: null,
      bridgeCustomerIds: null,
      audit: {},
    }),
}));

vi.mock("@/lib/db/client", () => ({
  getAuthPool: vi.fn(() => ({ query: mockPoolQuery })),
}));

const VALID_UUID = "a0000000-0000-0000-0000-000000000001";

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("GET /api/events/staged/[payloadId]", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  async function callGET(payloadId: string) {
    const { GET } = await import("../staged/[payloadId]/route");
    const req = new NextRequest(
      `http://localhost:3000/api/events/staged/${payloadId}`,
    );
    return GET(req);
  }

  it("returns payload details when owned by session", async () => {
    mockPoolQuery.mockResolvedValue({ rows: [{ id: VALID_UUID }] });
    mockGetStagedPayloadById.mockResolvedValue({
      payloadId: VALID_UUID,
      aiceId: "aice-1",
      eventCount: 5,
      schemaVersion: "1.0",
      createdAt: new Date(),
      expiresAt: new Date(),
      customers: [
        {
          customerId: "c1",
          customerName: "Customer A",
          status: "pending",
          approvedAt: null,
        },
      ],
    });

    const res = await callGET(VALID_UUID);
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.event.payloadId).toBe(VALID_UUID);
    expect(body.event.customers).toHaveLength(1);
  });

  it("returns 404 when payload not owned by session", async () => {
    mockPoolQuery.mockResolvedValue({ rows: [] });

    const res = await callGET(VALID_UUID);
    expect(res.status).toBe(404);
  });

  it("returns 400 for invalid UUID", async () => {
    const res = await callGET("not-a-uuid");
    expect(res.status).toBe(400);
  });
});
