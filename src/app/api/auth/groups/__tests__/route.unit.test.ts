import type { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// Mocks — bypass the guard/session machinery and the DB so we exercise the
// route's bridge short-circuit and its delegation to listAccessibleGroups.
// ---------------------------------------------------------------------------

vi.mock("server-only", () => ({}));

let authOverride: {
  accountId: string;
  bridgeAiceId: string | null;
  bridgeCustomerIds: string[] | null;
};

vi.mock("@/lib/auth/guards", () => ({
  withAuth:
    (handler: (req: NextRequest, auth: unknown) => Promise<Response>) =>
    (req: NextRequest) =>
      handler(req, authOverride),
}));

const fakePool = {};
vi.mock("@/lib/db/client", () => ({
  getAuthPool: () => fakePool,
  withTransaction: (_pool: unknown, fn: (client: unknown) => unknown) => fn({}),
}));

const mockList = vi.fn();
vi.mock("@/lib/auth/group-authorization", () => ({
  listAccessibleGroups: (...a: unknown[]) => mockList(...a),
}));

import { GET } from "../route";

describe("GET /api/auth/groups", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns the account's accessible groups", async () => {
    authOverride = {
      accountId: "acct-1",
      bridgeAiceId: null,
      bridgeCustomerIds: null,
    };
    const groups = [
      {
        id: "g1",
        name: "Alpha",
        description: null,
        memberIds: ["c1"],
        tz: "UTC",
      },
    ];
    mockList.mockResolvedValue(groups);

    const res = await GET(new Request("http://x/api/auth/groups") as never);
    expect(await res.json()).toEqual({ groups });
    expect(mockList).toHaveBeenCalledWith(expect.anything(), "acct-1");
  });

  it("short-circuits a bridge session to an empty list, without a DB read", async () => {
    authOverride = {
      accountId: "acct-1",
      bridgeAiceId: "aice-1",
      bridgeCustomerIds: ["c1"],
    };

    const res = await GET(new Request("http://x/api/auth/groups") as never);
    expect(await res.json()).toEqual({ groups: [] });
    expect(mockList).not.toHaveBeenCalled();
  });
});
