import type { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

let bridgeCustomerIds: string[] | null = null;
vi.mock("@/lib/auth/guards", () => ({
  withAuth:
    (handler: (req: NextRequest, auth: unknown) => Promise<Response>) =>
    (req: NextRequest) =>
      handler(req, {
        accountId: "acct-1",
        sessionId: "sid-1",
        iat: 0,
        bridgeCustomerIds,
        meta: { ipAddress: "127.0.0.1" },
      }),
}));

const fakeClient = { query: vi.fn(), release: vi.fn() };
vi.mock("@/lib/db/client", () => ({
  getAuthPool: () => ({}),
  withTransaction: (_pool: unknown, cb: (c: unknown) => unknown) =>
    cb(fakeClient),
}));

const mockListEligible = vi.fn();
vi.mock("@/lib/groups/eligible-members", () => ({
  listGroupEligibleMembers: (...a: unknown[]) => mockListEligible(...a),
}));

const { GET } = await import("../route");

function req(): NextRequest {
  return {
    nextUrl: { pathname: "/api/groups/eligible-members" },
  } as unknown as NextRequest;
}

beforeEach(() => {
  vi.clearAllMocks();
  bridgeCustomerIds = null;
});

describe("GET /api/groups/eligible-members", () => {
  it("returns the eligible customers with timezone", async () => {
    mockListEligible.mockResolvedValue([
      {
        id: "c1",
        name: "Acme",
        externalKey: "acme",
        timezone: "Asia/Seoul",
        role: "Manager",
        isAnalyst: false,
      },
    ]);
    const res = await GET(req());
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.customers).toHaveLength(1);
    expect(body.customers[0]).toMatchObject({
      id: "c1",
      timezone: "Asia/Seoul",
    });
    expect(mockListEligible).toHaveBeenCalledWith(fakeClient, "acct-1");
  });

  it("short-circuits a bridge session to an empty list", async () => {
    bridgeCustomerIds = ["c1"];
    const res = await GET(req());
    expect(res.status).toBe(200);
    expect((await res.json()).customers).toEqual([]);
    expect(mockListEligible).not.toHaveBeenCalled();
  });
});
