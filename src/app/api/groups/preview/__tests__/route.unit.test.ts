import type { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// Mocks — bypass session/guard machinery and the DB so we exercise the preview
// route's shared validation, the no-write guarantee, the over-cap annotation,
// and tz divergence directly. The auth-DB client is faked; the per-member
// customer DB read (cross-DB event count) is faked via getCustomerRuntimePool.
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
  denyBridgeManagement: (b: string[] | null) =>
    b !== null ? Response.json({ error: "Forbidden" }, { status: 403 }) : null,
}));

const fakeClient = {
  query: vi.fn().mockResolvedValue({ rows: [], rowCount: 0 }),
  release: vi.fn(),
};
const fakePool = { connect: vi.fn().mockResolvedValue(fakeClient) };
vi.mock("@/lib/db/client", () => ({ getAuthPool: () => fakePool }));

const mockAssertManagement = vi.fn();
vi.mock("@/lib/auth/group-authorization", () => ({
  assertAllMemberManagement: (...a: unknown[]) => mockAssertManagement(...a),
}));

const mockFetchMemberStates = vi.fn();
// createGroup is mocked alongside so we can assert the no-write guarantee even
// though the preview route never imports it.
const mockCreateGroup = vi.fn();
vi.mock("@/lib/groups/groups", () => ({
  fetchMemberStates: (...a: unknown[]) => mockFetchMemberStates(...a),
  createGroup: (...a: unknown[]) => mockCreateGroup(...a),
}));

const mockAuditLog = vi.fn();
vi.mock("@/lib/audit", () => ({
  auditLog: (...a: unknown[]) => mockAuditLog(...a),
}));

const mockProvisionGroupDb = vi.fn();
vi.mock("@/lib/db/provision-group", () => ({
  provisionGroupDb: (...a: unknown[]) => mockProvisionGroupDb(...a),
}));

// Per-member customer DB pool — its query returns a fixed deduped event count
// so the combined volume is a predictable sum across members.
const mockMemberQuery = vi.fn();
const mockGetCustomerRuntimePool = vi.fn((_id: string) => ({
  query: mockMemberQuery,
}));
vi.mock("@/lib/db/customer-runtime-pool", () => ({
  getCustomerRuntimePool: (id: string) => mockGetCustomerRuntimePool(id),
}));

const { POST } = await import("../route");
const { HttpError } = await import("@/lib/auth/errors");

const A = "11111111-1111-1111-1111-111111111111";
const B = "22222222-2222-2222-2222-222222222222";

function uuids(n: number): string[] {
  return Array.from({ length: n }, (_, i) => {
    const h = (i + 1).toString(16).padStart(12, "0");
    return `00000000-0000-0000-0000-${h}`;
  });
}

function req(body: unknown): NextRequest {
  return {
    nextUrl: { pathname: "/api/groups/preview" },
    json: async () => body,
  } as unknown as NextRequest;
}

const operational = (id: string, timezone: string) => ({
  id,
  status: "active",
  databaseStatus: "active",
  timezone,
});

beforeEach(() => {
  vi.clearAllMocks();
  bridgeCustomerIds = null;
  mockAssertManagement.mockResolvedValue(undefined);
  // Each member contributes 100 deduped events over the trailing window.
  mockMemberQuery.mockResolvedValue({ rows: [{ count: 100 }] });
});

function expectNoWrites() {
  expect(mockCreateGroup).not.toHaveBeenCalled();
  expect(mockAuditLog).not.toHaveBeenCalled();
  expect(mockProvisionGroupDb).not.toHaveBeenCalled();
}

describe("POST /api/groups/preview — figures + no-write", () => {
  it("returns the figures for an in-cap group and writes nothing", async () => {
    mockFetchMemberStates.mockResolvedValue([
      operational(A, "Asia/Seoul"),
      operational(B, "Asia/Seoul"),
    ]);
    const res = await POST(req({ memberIds: [A, B] }));
    expect(res.status).toBe(200);
    const body = await res.json();

    expect(body.memberCount).toBe(2);
    expect(body.maxMembers).toBe(10);
    expect(body.overMemberCap).toBe(false);
    expect(body.generationCadence).toEqual([
      "LIVE",
      "DAILY",
      "WEEKLY",
      "MONTHLY",
    ]);
    // Combined volume is the sum across members (100 + 100).
    expect(body.combinedRecentEventVolume).toBe(200);
    // The computed monetary/token figures are present (non-null) and positive.
    expect(typeof body.estimatedMonthlyTokens).toBe("number");
    expect(body.estimatedMonthlyTokens).toBeGreaterThan(0);
    expect(typeof body.estimatedMonthlyCostUsd).toBe("number");
    expect(body.estimatedMonthlyCostUsd).toBeGreaterThan(0);
    // No tz hint when members agree.
    expect(body.recommendedTz).toBeUndefined();

    // Cross-read happened once per member; nothing was written.
    expect(mockGetCustomerRuntimePool).toHaveBeenCalledTimes(2);
    expectNoWrites();
  });

  it("does not leak the calculation method or coefficients", async () => {
    mockFetchMemberStates.mockResolvedValue([
      operational(A, "UTC"),
      operational(B, "UTC"),
    ]);
    const res = await POST(req({ memberIds: [A, B] }));
    const body = await res.json();
    // Only the documented figure keys cross the boundary.
    expect(Object.keys(body).sort()).toEqual(
      [
        "combinedRecentEventVolume",
        "estimatedMonthlyCostUsd",
        "estimatedMonthlyTokens",
        "generationCadence",
        "maxMembers",
        "memberCount",
        "overMemberCap",
      ].sort(),
    );
  });
});

describe("POST /api/groups/preview — over-cap annotation", () => {
  it("annotates 11 members with overMemberCap + null figures (no 400, no cross-read)", async () => {
    const eleven = uuids(11);
    mockFetchMemberStates.mockResolvedValue(
      eleven.map((id) => operational(id, "UTC")),
    );
    const res = await POST(req({ memberIds: eleven }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.overMemberCap).toBe(true);
    expect(body.memberCount).toBe(11);
    expect(body.maxMembers).toBe(10);
    // The three computed figures are skipped and null — never 0.
    expect(body.combinedRecentEventVolume).toBeNull();
    expect(body.estimatedMonthlyTokens).toBeNull();
    expect(body.estimatedMonthlyCostUsd).toBeNull();
    // Cadence is always present.
    expect(body.generationCadence).toHaveLength(4);
    // No point paying the cross-DB reads for an uncreatable group.
    expect(mockGetCustomerRuntimePool).not.toHaveBeenCalled();
    expectNoWrites();
  });
});

describe("POST /api/groups/preview — tz divergence", () => {
  it("returns figures + recommendedTz (no 400) when members differ and no tz", async () => {
    mockFetchMemberStates.mockResolvedValue([
      operational(A, "UTC"),
      operational(B, "Asia/Seoul"),
    ]);
    const res = await POST(req({ memberIds: [A, B] }));
    expect(res.status).toBe(200);
    const body = await res.json();
    // Tie (1 each) → lexicographically smallest IANA name.
    expect(body.recommendedTz).toBe("Asia/Seoul");
    // Figures still computed (cost is tz-independent).
    expect(body.combinedRecentEventVolume).toBe(200);
    expect(body.estimatedMonthlyTokens).toBeGreaterThan(0);
    expectNoWrites();
  });

  it("still 400s a syntactically invalid tz", async () => {
    const res = await POST(req({ memberIds: [A, B], tz: "Not/AZone" }));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("invalid_timezone");
  });
});

describe("POST /api/groups/preview — shared front-door checks", () => {
  it("rejects fewer than 2 members", async () => {
    const res = await POST(req({ memberIds: [A] }));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("too_few_members");
  });

  it("propagates the management gate 403 without writing", async () => {
    mockAssertManagement.mockRejectedValue(new HttpError("Forbidden", 403));
    const res = await POST(req({ memberIds: [A, B] }));
    expect(res.status).toBe(403);
    expect(mockGetCustomerRuntimePool).not.toHaveBeenCalled();
    expectNoWrites();
  });

  it("returns 422 when a member is not operational", async () => {
    mockFetchMemberStates.mockResolvedValue([
      operational(A, "UTC"),
      { id: B, status: "suspended", databaseStatus: "active", timezone: "UTC" },
    ]);
    const res = await POST(req({ memberIds: [A, B] }));
    expect(res.status).toBe(422);
    expect((await res.json()).error).toBe("member_not_operational");
  });

  it("denies a bridge session with 403 before any gate or cross-read", async () => {
    bridgeCustomerIds = ["c1"];
    const res = await POST(req({ memberIds: [A, B] }));
    expect(res.status).toBe(403);
    expect((await res.json()).error).toBe("Forbidden");
    expect(mockAssertManagement).not.toHaveBeenCalled();
    expect(mockGetCustomerRuntimePool).not.toHaveBeenCalled();
    expectNoWrites();
  });
});
