import type { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// Mocks — bypass session/guard machinery and the DB, so we exercise the
// create route's request-shape validation, eligibility, tz resolution, and
// authorization ordering directly.
// ---------------------------------------------------------------------------

vi.mock("server-only", () => ({}));

vi.mock("@/lib/auth/guards", () => ({
  withAuth:
    (handler: (req: NextRequest, auth: unknown) => Promise<Response>) =>
    (req: NextRequest) =>
      handler(req, {
        accountId: "acct-1",
        sessionId: "sid-1",
        iat: 0,
        meta: { ipAddress: "127.0.0.1" },
      }),
  verifyOrigin: () => null,
  verifyCsrf: () => null,
}));

const fakeClient = {
  query: vi.fn().mockResolvedValue({ rows: [], rowCount: 0 }),
  release: vi.fn(),
};
const fakePool = { connect: vi.fn().mockResolvedValue(fakeClient) };
vi.mock("@/lib/db/client", () => ({ getAuthPool: () => fakePool }));

const mockAuditLog = vi.fn();
vi.mock("@/lib/audit", () => ({
  auditLog: (...a: unknown[]) => mockAuditLog(...a),
}));

const mockAssertManagement = vi.fn();
vi.mock("@/lib/auth/group-authorization", () => ({
  assertAllMemberManagement: (...a: unknown[]) => mockAssertManagement(...a),
}));

const mockFetchMemberStates = vi.fn();
const mockCreateGroup = vi.fn();
vi.mock("@/lib/groups/groups", () => ({
  fetchMemberStates: (...a: unknown[]) => mockFetchMemberStates(...a),
  createGroup: (...a: unknown[]) => mockCreateGroup(...a),
}));

const mockProvisionGroupDb = vi.fn();
vi.mock("@/lib/db/provision-group", () => ({
  provisionGroupDb: (...a: unknown[]) => mockProvisionGroupDb(...a),
}));

const { POST } = await import("../route");
const { HttpError } = await import("@/lib/auth/errors");

const A = "11111111-1111-1111-1111-111111111111";
const B = "22222222-2222-2222-2222-222222222222";

// `n` distinct UUIDs (1..n), for exercising the member-count cap boundary.
function uuids(n: number): string[] {
  return Array.from({ length: n }, (_, i) => {
    const h = (i + 1).toString(16).padStart(12, "0");
    return `00000000-0000-0000-0000-${h}`;
  });
}

function req(body: unknown): NextRequest {
  return {
    nextUrl: { pathname: "/api/groups" },
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
  mockAssertManagement.mockResolvedValue(undefined);
  mockProvisionGroupDb.mockResolvedValue("active");
  mockAuditLog.mockResolvedValue(undefined);
});

describe("POST /api/groups — request validation", () => {
  it("rejects invalid JSON", async () => {
    const res = await POST({
      nextUrl: { pathname: "/api/groups" },
      json: async () => {
        throw new Error("bad");
      },
    } as unknown as NextRequest);
    expect(res.status).toBe(400);
  });

  it("rejects a missing name", async () => {
    const res = await POST(req({ memberIds: [A, B] }));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("name_required");
  });

  it("rejects a non-array memberIds", async () => {
    const res = await POST(req({ name: "G", memberIds: "nope" }));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("memberIds_required");
  });

  it("rejects a non-UUID member id", async () => {
    const res = await POST(req({ name: "G", memberIds: [A, "not-a-uuid"] }));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("invalid_member_id");
  });

  it("rejects duplicate member ids (no satisfying >=2 by repetition)", async () => {
    const res = await POST(req({ name: "G", memberIds: [A, A] }));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("duplicate_members");
  });

  it("rejects fewer than 2 members", async () => {
    const res = await POST(req({ name: "G", memberIds: [A] }));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("too_few_members");
  });

  it("rejects an invalid IANA tz", async () => {
    const res = await POST(
      req({ name: "G", memberIds: [A, B], tz: "Not/AZone" }),
    );
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("invalid_timezone");
  });

  it("accepts exactly GROUP_MAX_MEMBERS (10) members", async () => {
    const ten = uuids(10);
    mockFetchMemberStates.mockResolvedValue(
      ten.map((id) => operational(id, "UTC")),
    );
    mockCreateGroup.mockResolvedValue({
      id: "group-10",
      name: "G",
      description: null,
      ownerId: "acct-1",
      createdBy: "acct-1",
      createdAt: "2026-01-01T00:00:00.000Z",
      tz: "UTC",
      memberIds: ten,
    });
    const res = await POST(req({ name: "G", memberIds: ten }));
    expect(res.status).toBe(201);
    expect(mockCreateGroup).toHaveBeenCalled();
  });

  it("rejects 11 members with too_many_members (over the cap)", async () => {
    const eleven = uuids(11);
    const res = await POST(req({ name: "G", memberIds: eleven }));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("too_many_members");
    // The cap is a request-shape check: it precedes the gate and any write.
    expect(mockAssertManagement).not.toHaveBeenCalled();
    expect(mockCreateGroup).not.toHaveBeenCalled();
  });
});

describe("POST /api/groups — authorization + eligibility + tz", () => {
  it("returns 403 when the management predicate fails", async () => {
    mockAssertManagement.mockRejectedValue(new HttpError("Forbidden", 403));
    const res = await POST(req({ name: "G", memberIds: [A, B] }));
    expect(res.status).toBe(403);
    expect(mockCreateGroup).not.toHaveBeenCalled();
  });

  it("returns 400 member_not_found when a member id is absent", async () => {
    // Management predicate passes (mocked), but a member disappeared
    // between the auth check and the state fetch.
    mockFetchMemberStates.mockResolvedValue([operational(A, "UTC")]);
    const res = await POST(req({ name: "G", memberIds: [A, B] }));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("member_not_found");
    expect(mockCreateGroup).not.toHaveBeenCalled();
  });

  it("returns 422 when a member is not operational", async () => {
    mockFetchMemberStates.mockResolvedValue([
      operational(A, "UTC"),
      { id: B, status: "suspended", databaseStatus: "active", timezone: "UTC" },
    ]);
    const res = await POST(req({ name: "G", memberIds: [A, B] }));
    expect(res.status).toBe(422);
    expect((await res.json()).error).toBe("member_not_operational");
  });

  it("returns 400 { recommendedTz } when members differ and no tz given", async () => {
    mockFetchMemberStates.mockResolvedValue([
      operational(A, "UTC"),
      operational(B, "Asia/Seoul"),
    ]);
    const res = await POST(req({ name: "G", memberIds: [A, B] }));
    expect(res.status).toBe(400);
    // Tie (1 each) → lexicographically smallest IANA name.
    expect((await res.json()).recommendedTz).toBe("Asia/Seoul");
    expect(mockCreateGroup).not.toHaveBeenCalled();
  });

  it("auto-adopts the shared tz and creates the group (201)", async () => {
    mockFetchMemberStates.mockResolvedValue([
      operational(A, "Asia/Seoul"),
      operational(B, "Asia/Seoul"),
    ]);
    mockCreateGroup.mockResolvedValue({
      id: "group-1",
      name: "G",
      description: null,
      ownerId: "acct-1",
      createdBy: "acct-1",
      createdAt: "2026-01-01T00:00:00.000Z",
      tz: "Asia/Seoul",
      memberIds: [A, B],
    });
    const res = await POST(req({ name: "G", memberIds: [A, B] }));
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.id).toBe("group-1");
    expect(body.ownerId).toBe("acct-1");
    expect(body.tz).toBe("Asia/Seoul");
    // The resolved tz is threaded into createGroup.
    expect(mockCreateGroup).toHaveBeenCalledWith(
      fakeClient,
      expect.objectContaining({ tz: "Asia/Seoul", creatorAccountId: "acct-1" }),
    );
    // The group DB is provisioned after commit and awaited; its status is
    // surfaced in the 201 body.
    expect(mockProvisionGroupDb).toHaveBeenCalledWith(
      fakePool,
      "group-1",
      expect.objectContaining({
        actorContext: expect.objectContaining({ actorId: "acct-1" }),
      }),
    );
    expect(body.databaseStatus).toBe("active");
  });

  it("surfaces a failed provision status in the 201 body", async () => {
    mockFetchMemberStates.mockResolvedValue([
      operational(A, "Asia/Seoul"),
      operational(B, "Asia/Seoul"),
    ]);
    mockCreateGroup.mockResolvedValue({
      id: "group-2",
      name: "G",
      description: null,
      ownerId: "acct-1",
      createdBy: "acct-1",
      createdAt: "2026-01-01T00:00:00.000Z",
      tz: "Asia/Seoul",
      memberIds: [A, B],
    });
    mockProvisionGroupDb.mockResolvedValue("failed");
    const res = await POST(req({ name: "G", memberIds: [A, B] }));
    expect(res.status).toBe(201);
    expect((await res.json()).databaseStatus).toBe("failed");
  });

  it("awaits the PII create audit before responding (no anonymize race)", async () => {
    mockFetchMemberStates.mockResolvedValue([
      operational(A, "Asia/Seoul"),
      operational(B, "Asia/Seoul"),
    ]);
    mockCreateGroup.mockResolvedValue({
      id: "group-3",
      name: "G",
      description: null,
      ownerId: "acct-1",
      createdBy: "acct-1",
      createdAt: "2026-01-01T00:00:00.000Z",
      tz: "Asia/Seoul",
      memberIds: [A, B],
    });

    // Gate the customer_group.created write so we can observe the
    // happens-before edge: the PII-bearing create row (details.name,
    // details.memberIds) must be written BEFORE the 201 returns, so a
    // subsequent delete's anonymizeGroupAuditLogs() cannot be beaten by a
    // late raw create insert. Provisioning, which follows the audit write,
    // must stay blocked until that row lands.
    let resolveAudit!: () => void;
    mockAuditLog.mockReturnValue(
      new Promise<void>((resolve) => {
        resolveAudit = resolve;
      }),
    );

    const pending = POST(req({ name: "G", memberIds: [A, B] }));
    // Drain microtasks past the awaited auth-DB mocks; the handler should
    // now be parked on the (gated) audit write, with provisioning blocked.
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(mockAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "customer_group.created",
        targetId: "group-3",
        details: { name: "G", memberIds: [A, B], tz: "Asia/Seoul" },
      }),
    );
    expect(mockProvisionGroupDb).not.toHaveBeenCalled();

    resolveAudit();
    const res = await pending;
    expect(res.status).toBe(201);
    expect(mockProvisionGroupDb).toHaveBeenCalled();
  });
});
