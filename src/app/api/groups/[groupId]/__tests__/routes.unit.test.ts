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

const mockAuditLog = vi.fn();
vi.mock("@/lib/audit", () => ({
  auditLog: (...a: unknown[]) => mockAuditLog(...a),
}));

const mockTeardownGroupDb = vi.fn();
vi.mock("@/lib/db/teardown-group", () => ({
  teardownGroupDb: (...a: unknown[]) => mockTeardownGroupDb(...a),
}));

// Keep the REAL `assertGroupOwner` (a pure owner-id check used by DELETE)
// while stubbing the async all-member predicate that retention/timezone use.
const mockAssertManagement = vi.fn();
vi.mock("@/lib/auth/group-authorization", async (importActual) => {
  const actual =
    await importActual<typeof import("@/lib/auth/group-authorization")>();
  return {
    ...actual,
    assertAllMemberManagement: (...a: unknown[]) => mockAssertManagement(...a),
  };
});

const mockGetGroupWithMembers = vi.fn();
const mockDeleteGroup = vi.fn();
const mockGetGroupRetention = vi.fn();
const mockUpdateGroupRetention = vi.fn();
const mockUpdateGroupTimezone = vi.fn();
const mockFetchMemberNames = vi.fn();
vi.mock("@/lib/groups/groups", () => ({
  getGroupWithMembers: (...a: unknown[]) => mockGetGroupWithMembers(...a),
  deleteGroup: (...a: unknown[]) => mockDeleteGroup(...a),
  getGroupRetention: (...a: unknown[]) => mockGetGroupRetention(...a),
  updateGroupRetention: (...a: unknown[]) => mockUpdateGroupRetention(...a),
  updateGroupTimezone: (...a: unknown[]) => mockUpdateGroupTimezone(...a),
  fetchMemberNames: (...a: unknown[]) => mockFetchMemberNames(...a),
}));

const mockProvisionGroupDb = vi.fn();
vi.mock("@/lib/db/provision-group", () => ({
  provisionGroupDb: (...a: unknown[]) => mockProvisionGroupDb(...a),
}));

const { DELETE, GET: DETAIL_GET } = await import("../route");
const { GET: RETENTION_GET, PUT: RETENTION_PUT } = await import(
  "../retention/route"
);
const { PUT: TIMEZONE_PUT } = await import("../timezone/route");
const { POST: RETRY_PROVISION } = await import("../retry-provision/route");
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
    databaseStatus: "active",
  },
  memberIds: [M1, M2],
};

beforeEach(() => {
  vi.clearAllMocks();
  mockAssertManagement.mockResolvedValue(undefined);
  mockGetGroupWithMembers.mockResolvedValue(loaded);
  mockTeardownGroupDb.mockResolvedValue(undefined);
  mockAuditLog.mockResolvedValue(undefined);
  mockProvisionGroupDb.mockResolvedValue("active");
  mockFetchMemberNames.mockResolvedValue([
    { id: M1, name: "Member One" },
    { id: M2, name: "Member Two" },
  ]);
  mockGetGroupRetention.mockResolvedValue({ analysisDays: 1095 });
});

describe("GET /api/groups/[groupId] — management detail", () => {
  it("returns 400 for a non-UUID id", async () => {
    const res = await DETAIL_GET(req("/api/groups/not-a-uuid"));
    expect(res.status).toBe(400);
    expect(mockGetGroupWithMembers).not.toHaveBeenCalled();
  });

  it("returns 404 when the group does not exist", async () => {
    mockGetGroupWithMembers.mockResolvedValue(null);
    const res = await DETAIL_GET(req(`/api/groups/${GID}`));
    expect(res.status).toBe(404);
    expect(mockAssertManagement).not.toHaveBeenCalled();
  });

  it("returns 403 when the caller does not manage every member", async () => {
    mockAssertManagement.mockRejectedValue(new HttpError("Forbidden", 403));
    const res = await DETAIL_GET(req(`/api/groups/${GID}`));
    expect(res.status).toBe(403);
    expect(mockFetchMemberNames).not.toHaveBeenCalled();
  });

  it("returns owner, members with names, db status, and retention", async () => {
    const res = await DETAIL_GET(req(`/api/groups/${GID}`));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({
      id: GID,
      tz: "Asia/Seoul",
      ownerId: "acct-1",
      createdBy: "acct-1",
      databaseStatus: "active",
      groupPolicyDays: 1095,
    });
    expect(body.members).toEqual([
      { id: M1, name: "Member One" },
      { id: M2, name: "Member Two" },
    ]);
  });

  it("treats a missing retention policy row as no-expiry (null)", async () => {
    mockGetGroupRetention.mockResolvedValue(undefined);
    const res = await DETAIL_GET(req(`/api/groups/${GID}`));
    expect(res.status).toBe(200);
    expect((await res.json()).groupPolicyDays).toBeNull();
  });
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

  it("returns 403 when the requester is not the group owner (#510)", async () => {
    mockGetGroupWithMembers.mockResolvedValue({
      ...loaded,
      group: { ...loaded.group, ownerId: "someone-else" },
    });
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

  it("awaits the PII delete audit before tearing down (no anonymize race)", async () => {
    mockDeleteGroup.mockResolvedValue(true);

    // Gate the customer_group.deleted write so we can observe the
    // happens-before edge: teardown (which runs anonymizeGroupAuditLogs)
    // must not start until that PII-bearing audit row is written.
    let resolveAudit!: () => void;
    mockAuditLog.mockReturnValue(
      new Promise<void>((resolve) => {
        resolveAudit = resolve;
      }),
    );

    const pending = DELETE(req(`/api/groups/${GID}`));
    // Drain pending microtasks past the awaited auth-DB mocks; the handler
    // should now be parked on the (gated) audit write, with teardown blocked.
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(mockAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "customer_group.deleted",
        targetId: GID,
        details: { memberIds: [M1, M2] },
      }),
    );
    expect(mockTeardownGroupDb).not.toHaveBeenCalled();

    resolveAudit();
    const res = await pending;
    expect(res.status).toBe(204);
    expect(mockTeardownGroupDb).toHaveBeenCalled();
  });
});

describe("POST /api/groups/[groupId]/retry-provision", () => {
  const path = `/api/groups/${GID}/retry-provision`;

  it("returns 403 when the requester is not the group owner (#510)", async () => {
    mockGetGroupWithMembers.mockResolvedValue({
      ...loaded,
      group: { ...loaded.group, ownerId: "someone-else" },
    });
    const res = await RETRY_PROVISION(req(path));
    expect(res.status).toBe(403);
    expect(mockProvisionGroupDb).not.toHaveBeenCalled();
  });

  it("returns 404 when the group does not exist", async () => {
    mockGetGroupWithMembers.mockResolvedValue(null);
    const res = await RETRY_PROVISION(req(path));
    expect(res.status).toBe(404);
    expect(mockProvisionGroupDb).not.toHaveBeenCalled();
  });

  it("returns 409 when database_status is not 'failed'", async () => {
    fakeClient.query.mockResolvedValue({
      rows: [{ database_status: "active" }],
    });
    const res = await RETRY_PROVISION(req(path));
    expect(res.status).toBe(409);
    expect(mockProvisionGroupDb).not.toHaveBeenCalled();
  });

  it("re-provisions for the owner when database_status is 'failed'", async () => {
    fakeClient.query.mockResolvedValue({
      rows: [{ database_status: "failed" }],
    });
    mockProvisionGroupDb.mockResolvedValue("provisioning");
    const res = await RETRY_PROVISION(req(path));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ databaseStatus: "provisioning" });
    expect(mockProvisionGroupDb).toHaveBeenCalledWith(
      fakePool,
      GID,
      expect.objectContaining({ isRetry: true }),
    );
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
