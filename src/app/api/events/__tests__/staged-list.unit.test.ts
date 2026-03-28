import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

const mockListStagedEventsBySession = vi.fn();

vi.mock("@/lib/auth/staged-events", () => ({
  listStagedEventsBySession: (...args: unknown[]) =>
    mockListStagedEventsBySession(...args),
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
    }),
}));

vi.mock("@/lib/db/client", () => ({
  getAuthPool: vi.fn(() => ({})),
}));

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("GET /api/events/staged", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  async function callGET() {
    const { GET } = await import("../staged/route");
    const req = new NextRequest("http://localhost:3000/api/events/staged");
    return GET(req);
  }

  it("returns staged events for the session", async () => {
    const events = [
      {
        payloadId: "p1",
        aiceId: "aice-1",
        eventCount: 10,
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
      },
    ];
    mockListStagedEventsBySession.mockResolvedValue(events);

    const res = await callGET();
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.events).toHaveLength(1);
    expect(body.events[0].payloadId).toBe("p1");
    expect(mockListStagedEventsBySession).toHaveBeenCalledWith(
      expect.anything(),
      "sess-1",
    );
  });

  it("returns empty list when no staged events", async () => {
    mockListStagedEventsBySession.mockResolvedValue([]);

    const res = await callGET();
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.events).toEqual([]);
  });
});
