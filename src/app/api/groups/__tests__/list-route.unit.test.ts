import type { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// Mocks — exercise the management-scoped GET /api/groups list handler: its
// bridge short-circuit and the management-gated projection. The set-based
// `listManageableGroups` predicate is covered by its own tests; here we test
// the route wiring (bridge branch, response shape).
// ---------------------------------------------------------------------------

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
  verifyOrigin: () => null,
  verifyCsrf: () => null,
}));

const fakeClient = { query: vi.fn(), release: vi.fn() };
vi.mock("@/lib/db/client", () => ({
  getAuthPool: () => ({}),
  withTransaction: (_pool: unknown, cb: (c: unknown) => unknown) =>
    cb(fakeClient),
}));

const mockListManageableGroups = vi.fn();
vi.mock("@/lib/auth/group-authorization", () => ({
  listManageableGroups: (...a: unknown[]) => mockListManageableGroups(...a),
}));

// The create path's collaborators are imported by the route module; stub them
// so the import graph resolves (the GET handler does not touch them).
vi.mock("@/lib/audit", () => ({ auditLog: vi.fn() }));
vi.mock("@/lib/auth/customers", () => ({ validateCustomerFields: vi.fn() }));
vi.mock("@/lib/auth/retention-defaults", () => ({
  DEFAULT_ANALYSIS_RETENTION_DAYS: 1095,
}));
vi.mock("@/lib/db/provision-group", () => ({ provisionGroupDb: vi.fn() }));
vi.mock("@/lib/groups/groups", () => ({ createGroup: vi.fn() }));
vi.mock("@/lib/groups/member-validation", () => ({
  validateGroupMembers: vi.fn(),
}));

const { GET } = await import("../route");

function req(): NextRequest {
  return { nextUrl: { pathname: "/api/groups" } } as unknown as NextRequest;
}

beforeEach(() => {
  vi.clearAllMocks();
  bridgeCustomerIds = null;
});

describe("GET /api/groups — management list", () => {
  it("returns the manageable groups", async () => {
    mockListManageableGroups.mockResolvedValue([
      {
        id: "g1",
        name: "Group One",
        memberCount: 3,
        databaseStatus: "active",
        ownerId: "acct-1",
        createdBy: "acct-1",
      },
    ]);
    const res = await GET(req());
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.groups).toHaveLength(1);
    expect(body.groups[0]).toMatchObject({
      id: "g1",
      memberCount: 3,
      ownerId: "acct-1",
    });
    expect(mockListManageableGroups).toHaveBeenCalledWith(fakeClient, "acct-1");
  });

  it("short-circuits a bridge session to an empty list", async () => {
    bridgeCustomerIds = ["c1"];
    const res = await GET(req());
    expect(res.status).toBe(200);
    expect((await res.json()).groups).toEqual([]);
    // The management query is never reached under a bridge.
    expect(mockListManageableGroups).not.toHaveBeenCalled();
  });
});
