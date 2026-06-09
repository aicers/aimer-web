import type { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// Mocks — bypass session/guard machinery and the DB so we exercise the
// per-group sub-route handlers (delete, retention GET/PUT, timezone PUT):
// their 404 / 403 / body-validation branches and authorize-before-parse
// ordering. The underlying lib functions and the all-member predicate are
// covered by their own DB tests; here we test the route wiring.
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

const fakeClient = { query: vi.fn(), release: vi.fn() };
const fakePool = { connect: vi.fn().mockResolvedValue(fakeClient) };
const fakeAuditPool = {};
vi.mock("@/lib/db/client", () => ({
  getAuthPool: () => fakePool,
  getMigrationAuditPool: () => fakeAuditPool,
}));

vi.mock("@/lib/audit", () => ({ auditLog: vi.fn() }));

const mockTeardownGroupDb = vi.fn();
vi.mock("@/lib/db/teardown-group", () => ({
  teardownGroupDb: (...a: unknown[]) => mockTeardownGroupDb(...a),
}));

const mockAssertManagement = vi.fn();
vi.mock("@/lib/auth/group-authorization", () => ({
  assertAllMemberManagement: (...a: unknown[]) => mockAssertManagement(...a),
}));

const mockGetGroupWithMembers = vi.fn();
const mockDeleteGroup = vi.fn();
const mockGetGroupRetention = vi.fn();
const mockUpdateGroupRetention = vi.fn();
const mockUpdateGroupTimezone = vi.fn();
vi.mock("@/lib/groups/groups", () => ({
  getGroupWithMembers: (...a: unknown[]) => mockGetGroupWithMembers(...a),
  deleteGroup: (...a: unknown[]) => mockDeleteGroup(...a),
  getGroupRetention: (...a: unknown[]) => mockGetGroupRetention(...a),
  updateGroupRetention: (...a: unknown[]) => mockUpdateGroupRetention(...a),
  updateGroupTimezone: (...a: unknown[]) => mockUpdateGroupTimezone(...a),
}));

const { DELETE } = await import("../route");
const { GET: RETENTION_GET, PUT: RETENTION_PUT } = await import(
  "../retention/route"
);
const { PUT: TIMEZONE_PUT } = await import("../timezone/route");
const { HttpError } = await import("@/lib/auth/errors");

const GID = "33333333-3333-3333-3333-333333333333";
const M1 = "11111111-1111-1111-1111-111111111111";
const M2 = "22222222-2222-2222-2222-222222222222";

function req(pathname: string, body?: unknown): NextRequest {
  return {
    nextUrl: { pathname },
    json: async () => {
      if (body === undefined) throw new Error("no body");
      return body;
    },
  } as unknown as NextRequest;
}

const loaded = {
  group: {
    id: GID,
    name: "G",
    description: null,
    ownerId: "acct-1",
    createdBy: "acct-1",
    createdAt: "2026-01-01T00:00:00.000Z",
    tz: "Asia/Seoul",
  },
  memberIds: [M1, M2],
};

beforeEach(() => {
  vi.clearAllMocks();
  mockAssertManagement.mockResolvedValue(undefined);
  mockGetGroupWithMembers.mockResolvedValue(loaded);
  mockTeardownGroupDb.mockResolvedValue(undefined);
});

describe("DELETE /api/groups/[groupId]", () => {
  it("returns 400 for a non-UUID id", async () => {
    const res = await DELETE(req("/api/groups/not-a-uuid"));
    expect(res.status).toBe(400);
    expect(mockGetGroupWithMembers).not.toHaveBeenCalled();
  });

  it("returns 404 when the group does not exist", async () => {
    mockGetGroupWithMembers.mockResolvedValue(null);
    const res = await DELETE(req(`/api/groups/${GID}`));
    expect(res.status).toBe(404);
    expect(mockAssertManagement).not.toHaveBeenCalled();
  });

  it("returns 403 when the management predicate fails", async () => {
    mockAssertManagement.mockRejectedValue(new HttpError("Forbidden", 403));
    const res = await DELETE(req(`/api/groups/${GID}`));
    expect(res.status).toBe(403);
    expect(mockDeleteGroup).not.toHaveBeenCalled();
  });

  it("returns 204 on a successful delete and tears down the group DB", async () => {
    mockDeleteGroup.mockResolvedValue(true);
    const res = await DELETE(req(`/api/groups/${GID}`));
    expect(res.status).toBe(204);
    expect(mockDeleteGroup).toHaveBeenCalledWith(fakeClient, GID);
    // Best-effort post-commit teardown of the group's dedicated data DB.
    expect(mockTeardownGroupDb).toHaveBeenCalledWith(
      fakeAuditPool,
      GID,
      expect.objectContaining({ actorId: "acct-1" }),
    );
  });

  it("returns 404 when a concurrent delete won the race", async () => {
    mockDeleteGroup.mockResolvedValue(false);
    const res = await DELETE(req(`/api/groups/${GID}`));
    expect(res.status).toBe(404);
    expect(mockTeardownGroupDb).not.toHaveBeenCalled();
  });
});

describe("GET /api/groups/[groupId]/retention", () => {
  it("returns the policy days", async () => {
    mockGetGroupRetention.mockResolvedValue({ analysisDays: 1095 });
    const res = await RETENTION_GET(req(`/api/groups/${GID}/retention`));
    expect(res.status).toBe(200);
    expect((await res.json()).groupPolicyDays).toBe(1095);
  });

  it("surfaces a null policy (no expiry) as null", async () => {
    mockGetGroupRetention.mockResolvedValue({ analysisDays: null });
    const res = await RETENTION_GET(req(`/api/groups/${GID}/retention`));
    expect((await res.json()).groupPolicyDays).toBeNull();
  });

  it("returns 404 when the group is missing", async () => {
    mockGetGroupWithMembers.mockResolvedValue(null);
    const res = await RETENTION_GET(req(`/api/groups/${GID}/retention`));
    expect(res.status).toBe(404);
  });

  it("returns 403 when the management predicate fails", async () => {
    mockAssertManagement.mockRejectedValue(new HttpError("Forbidden", 403));
    const res = await RETENTION_GET(req(`/api/groups/${GID}/retention`));
    expect(res.status).toBe(403);
    expect(mockGetGroupRetention).not.toHaveBeenCalled();
  });
});

describe("PUT /api/groups/[groupId]/retention", () => {
  it("authorizes before parsing the body (403, not a validation error)", async () => {
    mockAssertManagement.mockRejectedValue(new HttpError("Forbidden", 403));
    const res = await RETENTION_PUT(
      req(`/api/groups/${GID}/retention`, { groupPolicyDays: "nonsense" }),
    );
    expect(res.status).toBe(403);
  });

  it("rejects a too-short retention window with 422", async () => {
    const res = await RETENTION_PUT(
      req(`/api/groups/${GID}/retention`, { groupPolicyDays: 10 }),
    );
    expect(res.status).toBe(422);
    expect((await res.json()).error).toBe("retention_too_short");
    expect(mockUpdateGroupRetention).not.toHaveBeenCalled();
  });

  it("rejects a non-integer value with 400", async () => {
    const res = await RETENTION_PUT(
      req(`/api/groups/${GID}/retention`, { groupPolicyDays: 90.5 }),
    );
    expect(res.status).toBe(400);
  });

  it("accepts null (no expiry) and returns the updated value", async () => {
    mockUpdateGroupRetention.mockResolvedValue({
      before: 1095,
      after: null,
      changed: true,
    });
    const res = await RETENTION_PUT(
      req(`/api/groups/${GID}/retention`, { groupPolicyDays: null }),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.groupPolicyDays).toBeNull();
    expect(body.changed).toBe(true);
  });

  it("returns 200 with changed=false on a no-op", async () => {
    mockUpdateGroupRetention.mockResolvedValue({
      before: 90,
      after: 90,
      changed: false,
    });
    const res = await RETENTION_PUT(
      req(`/api/groups/${GID}/retention`, { groupPolicyDays: 90 }),
    );
    expect(res.status).toBe(200);
    expect((await res.json()).changed).toBe(false);
  });
});

describe("PUT /api/groups/[groupId]/timezone", () => {
  it("rejects an invalid IANA tz with 400", async () => {
    const res = await TIMEZONE_PUT(
      req(`/api/groups/${GID}/timezone`, { tz: "Not/AZone" }),
    );
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("invalid_timezone");
    expect(mockUpdateGroupTimezone).not.toHaveBeenCalled();
  });

  it("returns 404 when the group is missing", async () => {
    mockGetGroupWithMembers.mockResolvedValue(null);
    const res = await TIMEZONE_PUT(
      req(`/api/groups/${GID}/timezone`, { tz: "UTC" }),
    );
    expect(res.status).toBe(404);
  });

  it("re-sets a valid tz and reports the change", async () => {
    mockUpdateGroupTimezone.mockResolvedValue({
      before: "Asia/Seoul",
      after: "UTC",
      changed: true,
    });
    const res = await TIMEZONE_PUT(
      req(`/api/groups/${GID}/timezone`, { tz: "UTC" }),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.tz).toBe("UTC");
    expect(body.changed).toBe(true);
    expect(mockUpdateGroupTimezone).toHaveBeenCalledWith(
      fakeClient,
      GID,
      "UTC",
    );
  });

  it("authorizes before validating the body", async () => {
    mockAssertManagement.mockRejectedValue(new HttpError("Forbidden", 403));
    const res = await TIMEZONE_PUT(
      req(`/api/groups/${GID}/timezone`, { tz: "Not/AZone" }),
    );
    expect(res.status).toBe(403);
  });
});
