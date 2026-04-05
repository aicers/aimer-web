import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

const mockPoolQuery = vi.fn();
const mockConnect = vi.fn(() => ({
  query: vi.fn(),
  release: vi.fn(),
}));
const mockAssertAuthorized = vi.fn();
const mockAuditLog = vi.fn(async () => {});
const mockAssignAdminRole = vi.fn<(userId: string) => Promise<void>>(
  async () => {},
);
const mockRemoveAdminRole = vi.fn<(userId: string) => Promise<void>>(
  async () => {},
);

const SELF_ACCOUNT_ID = "00000000-0000-0000-0000-000000000099";

const mockWithAuth = vi.fn(
  // biome-ignore lint/complexity/noBannedTypes: test mock needs generic callable
  (handler: Function) => (req: NextRequest) =>
    handler(req, {
      accountId: SELF_ACCOUNT_ID,
      sessionId: "sess-1",
      authContext: "admin",
      tokenVersion: 1,
      iat: 1000,
      meta: { ipAddress: "127.0.0.1", userAgent: "test" },
      bridgeAiceId: null,
      bridgeCustomerIds: null,
      audit: {},
    }),
);

vi.mock("@/lib/auth/guards", () => ({
  // biome-ignore lint/complexity/noBannedTypes: test mock needs generic callable
  withAuth: (handler: Function, _opts?: unknown) => mockWithAuth(handler),
  verifyOrigin: () => null,
  verifyCsrf: () => null,
}));

vi.mock("@/lib/auth/authorization", () => ({
  assertAuthorized: (...args: unknown[]) => mockAssertAuthorized(...args),
}));

vi.mock("@/lib/audit", () => ({
  auditLog: mockAuditLog,
}));

vi.mock("@/lib/keycloak/admin-client", () => ({
  assignAdminRole: (userId: string) => mockAssignAdminRole(userId),
  removeAdminRole: (userId: string) => mockRemoveAdminRole(userId),
}));

const mockTxQuery = vi.fn();
vi.mock("@/lib/db/client", () => ({
  getAuthPool: vi.fn(() => ({ query: mockPoolQuery, connect: mockConnect })),
  withTransaction: vi.fn(
    (_pool: unknown, fn: (client: { query: typeof mockTxQuery }) => unknown) =>
      fn({ query: mockTxQuery }),
  ),
}));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const BASE_URL = "http://localhost:3000/api/admin/admins";
const TARGET_ACCOUNT_ID = "a0000000-0000-0000-0000-000000000001";

function makeGetRequest(): NextRequest {
  return new NextRequest(new URL(BASE_URL), { method: "GET" });
}

function makePostRequest(body: unknown): NextRequest {
  return new NextRequest(new URL(BASE_URL), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

function makeDeleteRequest(accountId = TARGET_ACCOUNT_ID): NextRequest {
  return new NextRequest(new URL(`${BASE_URL}/${accountId}`), {
    method: "DELETE",
  });
}

// ---------------------------------------------------------------------------
// Tests — GET /api/admin/admins
// ---------------------------------------------------------------------------

describe("GET /api/admin/admins", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAssertAuthorized.mockResolvedValue(new Set(["accounts:read"]));
    mockPoolQuery.mockResolvedValue({ rows: [] });
  });

  it("calls assertAuthorized with accounts:read", async () => {
    const { GET } = await import("../route");
    await GET(makeGetRequest());

    expect(mockAssertAuthorized).toHaveBeenCalledWith(
      expect.anything(),
      "admin",
      SELF_ACCOUNT_ID,
      "accounts:read",
    );
  });

  it("returns 403 when assertAuthorized rejects", async () => {
    const { HttpError } = await import("@/lib/auth/errors");
    mockAssertAuthorized.mockRejectedValue(new HttpError("Forbidden", 403));

    const { GET } = await import("../route");
    const res = await GET(makeGetRequest());

    expect(res.status).toBe(403);
  });

  it("returns empty admins array when no admins exist", async () => {
    const { GET } = await import("../route");
    const res = await GET(makeGetRequest());
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.admins).toEqual([]);
    expect(body.maxAdmins).toBe(3);
  });

  it("returns mapped camelCase admin data", async () => {
    mockPoolQuery.mockResolvedValue({
      rows: [
        {
          id: TARGET_ACCOUNT_ID,
          username: "admin1",
          display_name: "Admin One",
          email: "admin@example.com",
          status: "active",
          last_sign_in_at: "2026-03-31T10:00:00.000Z",
          created_at: "2026-01-01T00:00:00.000Z",
        },
      ],
    });

    const { GET } = await import("../route");
    const res = await GET(makeGetRequest());
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.admins).toHaveLength(1);
    expect(body.admins[0]).toEqual({
      id: TARGET_ACCOUNT_ID,
      username: "admin1",
      displayName: "Admin One",
      email: "admin@example.com",
      status: "active",
      lastSignInAt: "2026-03-31T10:00:00.000Z",
      createdAt: "2026-01-01T00:00:00.000Z",
    });
  });

  it("filters only admin_eligible accounts via SQL", async () => {
    const { GET } = await import("../route");
    await GET(makeGetRequest());

    const sql = mockPoolQuery.mock.calls[0][0] as string;
    expect(sql).toContain("admin_eligible = true");
  });
});

// ---------------------------------------------------------------------------
// Tests — POST /api/admin/admins
// ---------------------------------------------------------------------------

describe("POST /api/admin/admins", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockTxQuery.mockReset();
    mockAssertAuthorized.mockResolvedValue(new Set(["accounts:write"]));
    mockAssignAdminRole.mockResolvedValue(undefined);
    // Default: advisory lock, 0 current admins, target account exists and is active
    mockTxQuery
      .mockResolvedValueOnce({ rows: [] }) // pg_advisory_xact_lock
      .mockResolvedValueOnce({ rows: [{ admin_count: "0" }] }) // admin count
      .mockResolvedValueOnce({
        rows: [
          {
            status: "active",
            oidc_subject: "kc-user-123",
            admin_eligible: false,
          },
        ],
      }) // target account query
      .mockResolvedValue({
        rows: [{ admin_eligible_at: "2026-04-01T00:00:00.000Z" }],
      }); // update query (RETURNING admin_eligible_at)
  });

  it("calls assertAuthorized with accounts:write", async () => {
    const { POST } = await import("../route");
    await POST(makePostRequest({ accountId: TARGET_ACCOUNT_ID }));

    expect(mockAssertAuthorized).toHaveBeenCalledWith(
      expect.anything(),
      "admin",
      SELF_ACCOUNT_ID,
      "accounts:write",
    );
  });

  it("returns 403 when not authorized", async () => {
    const { HttpError } = await import("@/lib/auth/errors");
    mockAssertAuthorized.mockRejectedValue(new HttpError("Forbidden", 403));

    const { POST } = await import("../route");
    const res = await POST(makePostRequest({ accountId: TARGET_ACCOUNT_ID }));

    expect(res.status).toBe(403);
  });

  it("returns 400 for invalid accountId", async () => {
    const { POST } = await import("../route");
    const res = await POST(makePostRequest({ accountId: "not-a-uuid" }));

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toContain("accountId must be a valid UUID");
  });

  it("returns 400 for missing accountId", async () => {
    const { POST } = await import("../route");
    const res = await POST(makePostRequest({}));

    expect(res.status).toBe(400);
  });

  it("returns 400 for non-object body", async () => {
    const { POST } = await import("../route");
    const req = new NextRequest(new URL(BASE_URL), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify("just a string"),
    });
    const res = await POST(req);

    expect(res.status).toBe(400);
  });

  it("returns 400 for invalid JSON body", async () => {
    const { POST } = await import("../route");
    const req = new NextRequest(new URL(BASE_URL), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "not json{",
    });
    const res = await POST(req);

    expect(res.status).toBe(400);
  });

  it("designates admin successfully and returns 201", async () => {
    const { POST } = await import("../route");
    const res = await POST(makePostRequest({ accountId: TARGET_ACCOUNT_ID }));

    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body).toEqual({ id: TARGET_ACCOUNT_ID });
  });

  it("assigns Keycloak role after DB update", async () => {
    const { POST } = await import("../route");
    await POST(makePostRequest({ accountId: TARGET_ACCOUNT_ID }));

    expect(mockAssignAdminRole).toHaveBeenCalledWith("kc-user-123");
  });

  it("emits admin.designated audit log", async () => {
    const { POST } = await import("../route");
    await POST(makePostRequest({ accountId: TARGET_ACCOUNT_ID }));

    expect(mockAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({
        actorId: SELF_ACCOUNT_ID,
        authContext: "admin",
        action: "admin.designated",
        targetType: "account",
        targetId: TARGET_ACCOUNT_ID,
      }),
    );
  });

  it("returns 409 when max admins reached", async () => {
    mockTxQuery.mockReset();
    mockTxQuery
      .mockResolvedValueOnce({ rows: [] }) // advisory lock
      .mockResolvedValueOnce({ rows: [{ admin_count: "3" }] }); // count

    const { POST } = await import("../route");
    const res = await POST(makePostRequest({ accountId: TARGET_ACCOUNT_ID }));

    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error).toContain("Maximum");
  });

  it("returns 409 when account is already admin", async () => {
    mockTxQuery.mockReset();
    mockTxQuery
      .mockResolvedValueOnce({ rows: [] }) // advisory lock
      .mockResolvedValueOnce({ rows: [{ admin_count: "1" }] }) // count
      .mockResolvedValueOnce({
        rows: [
          {
            status: "active",
            oidc_subject: "kc-user-123",
            admin_eligible: true,
          },
        ],
      });

    const { POST } = await import("../route");
    const res = await POST(makePostRequest({ accountId: TARGET_ACCOUNT_ID }));

    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error).toBe("Account is already an admin");
  });

  it("returns 404 when target account does not exist", async () => {
    mockTxQuery.mockReset();
    mockTxQuery
      .mockResolvedValueOnce({ rows: [] }) // advisory lock
      .mockResolvedValueOnce({ rows: [{ admin_count: "0" }] }) // count
      .mockResolvedValueOnce({ rows: [] }); // account not found

    const { POST } = await import("../route");
    const res = await POST(makePostRequest({ accountId: TARGET_ACCOUNT_ID }));

    expect(res.status).toBe(404);
  });

  it("returns 409 for non-active account", async () => {
    mockTxQuery.mockReset();
    mockTxQuery
      .mockResolvedValueOnce({ rows: [] }) // advisory lock
      .mockResolvedValueOnce({ rows: [{ admin_count: "0" }] }) // count
      .mockResolvedValueOnce({
        rows: [
          {
            status: "suspended",
            oidc_subject: "kc-user-123",
            admin_eligible: false,
          },
        ],
      });

    const { POST } = await import("../route");
    const res = await POST(makePostRequest({ accountId: TARGET_ACCOUNT_ID }));

    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error).toContain("active");
  });

  it("rolls back DB change when Keycloak assignment fails", async () => {
    mockAssignAdminRole.mockRejectedValue(new Error("Keycloak error"));

    const { POST } = await import("../route");

    await expect(
      POST(makePostRequest({ accountId: TARGET_ACCOUNT_ID })),
    ).rejects.toThrow("Keycloak error");

    // Verify the rollback query guards on admin_eligible_at (not
    // updated_at, which is bumped by unrelated writes like sign-in)
    expect(mockPoolQuery).toHaveBeenCalledWith(
      expect.stringContaining("AND admin_eligible_at = $2"),
      [TARGET_ACCOUNT_ID, "2026-04-01T00:00:00.000Z"],
    );
  });

  it("does not overwrite concurrent admin-eligibility mutation on rollback", async () => {
    // Simulate: designation commits with admin_eligible_at T1, but by
    // the time Keycloak fails a concurrent revoke+re-designate has
    // changed admin_eligible_at to T2. The compensation UPDATE should
    // match 0 rows because the WHERE clause guards on admin_eligible_at.
    mockAssignAdminRole.mockRejectedValue(new Error("Keycloak error"));

    const { POST } = await import("../route");

    await expect(
      POST(makePostRequest({ accountId: TARGET_ACCOUNT_ID })),
    ).rejects.toThrow("Keycloak error");

    const rollbackCall = mockPoolQuery.mock.calls.find(
      (args) =>
        typeof args[0] === "string" &&
        args[0].includes("admin_eligible = false"),
    );
    expect(rollbackCall).toBeDefined();
    const [sql, params] = rollbackCall as [string, unknown[]];
    expect(sql).toContain("AND admin_eligible_at = $2");
    expect(sql).not.toContain("AND updated_at = $2");
    expect(params).toEqual([TARGET_ACCOUNT_ID, "2026-04-01T00:00:00.000Z"]);
  });

  it("rollback succeeds even when unrelated updated_at change occurs", async () => {
    // Regression: an unrelated account write (e.g. sign-in) bumps
    // updated_at but does NOT change admin_eligible_at. The
    // compensation must still clear admin_eligible because no newer
    // admin-eligibility decision has been made.
    mockAssignAdminRole.mockRejectedValue(new Error("Keycloak error"));

    const { POST } = await import("../route");

    await expect(
      POST(makePostRequest({ accountId: TARGET_ACCOUNT_ID })),
    ).rejects.toThrow("Keycloak error");

    // The compensation guards on admin_eligible_at, not updated_at,
    // so it will still match even when updated_at has been bumped
    // by an unrelated write.
    const rollbackCall = mockPoolQuery.mock.calls.find(
      (args) =>
        typeof args[0] === "string" &&
        args[0].includes("admin_eligible = false"),
    );
    expect(rollbackCall).toBeDefined();
    const [sql] = rollbackCall as [string, unknown[]];
    expect(sql).toContain("admin_eligible_at = $2");
    expect(sql).not.toContain("WHERE id = $1 AND updated_at");
  });

  it("acquires advisory lock before checking admin count", async () => {
    const { POST } = await import("../route");
    await POST(makePostRequest({ accountId: TARGET_ACCOUNT_ID }));

    const lockSql = mockTxQuery.mock.calls[0][0] as string;
    expect(lockSql).toContain("pg_advisory_xact_lock");
    expect(mockTxQuery.mock.calls[0][1]).toEqual([1100]);

    const countSql = mockTxQuery.mock.calls[1][0] as string;
    expect(countSql).toContain("COUNT(*)");
    expect(countSql).toContain("admin_eligible = true");
  });
});

// ---------------------------------------------------------------------------
// Tests — DELETE /api/admin/admins/[accountId]
// ---------------------------------------------------------------------------

describe("DELETE /api/admin/admins/[accountId]", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockTxQuery.mockReset();
    mockAssertAuthorized.mockResolvedValue(new Set(["accounts:write"]));
    mockRemoveAdminRole.mockResolvedValue(undefined);
    // Default: target is an admin
    mockTxQuery
      .mockResolvedValueOnce({
        rows: [{ admin_eligible: true, oidc_subject: "kc-user-456" }],
      })
      .mockResolvedValue({ rows: [] });
  });

  it("calls assertAuthorized with accounts:write", async () => {
    const { DELETE } = await import("../[accountId]/route");
    await DELETE(makeDeleteRequest());

    expect(mockAssertAuthorized).toHaveBeenCalledWith(
      expect.anything(),
      "admin",
      SELF_ACCOUNT_ID,
      "accounts:write",
    );
  });

  it("returns 403 when not authorized", async () => {
    const { HttpError } = await import("@/lib/auth/errors");
    mockAssertAuthorized.mockRejectedValue(new HttpError("Forbidden", 403));

    const { DELETE } = await import("../[accountId]/route");
    const res = await DELETE(makeDeleteRequest());

    expect(res.status).toBe(403);
  });

  it("returns 400 for invalid UUID", async () => {
    const { DELETE } = await import("../[accountId]/route");
    const res = await DELETE(makeDeleteRequest("not-a-uuid"));

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe("Invalid account ID");
  });

  it("returns 400 when admin tries to revoke self", async () => {
    const { DELETE } = await import("../[accountId]/route");
    const res = await DELETE(makeDeleteRequest(SELF_ACCOUNT_ID));

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe("cannot_revoke_self");
  });

  it("returns 204 on successful revocation", async () => {
    const { DELETE } = await import("../[accountId]/route");
    const res = await DELETE(makeDeleteRequest());

    expect(res.status).toBe(204);
  });

  it("revokes admin sessions without bumping token_version", async () => {
    const { DELETE } = await import("../[accountId]/route");
    await DELETE(makeDeleteRequest());

    // 3 queries: SELECT FOR UPDATE, UPDATE admin_eligible,
    // UPDATE sessions (no token_version bump)
    expect(mockTxQuery).toHaveBeenCalledTimes(3);

    const calls = mockTxQuery.mock.calls;
    // Session revocation (admin context only)
    expect(calls[2][0]).toContain("SET revoked = true");
    expect(calls[2][0]).toContain("auth_context = 'admin'");
    expect(calls[2][1]).toContain(TARGET_ACCOUNT_ID);
  });

  it("does not invalidate general sessions on revocation", async () => {
    const { DELETE } = await import("../[accountId]/route");
    await DELETE(makeDeleteRequest());

    const allSql = mockTxQuery.mock.calls.map((c) => c[0] as string);
    // No token_version bump — general JWTs remain valid
    expect(allSql.every((s) => !s.includes("token_version"))).toBe(true);
    // Session revocation targets admin context only
    const sessionSql = allSql.find((s) => s.includes("SET revoked = true"));
    expect(sessionSql).toContain("auth_context = 'admin'");
    expect(sessionSql).not.toContain("auth_context = 'general'");
  });

  it("removes Keycloak role after DB update", async () => {
    const { DELETE } = await import("../[accountId]/route");
    await DELETE(makeDeleteRequest());

    expect(mockRemoveAdminRole).toHaveBeenCalledWith("kc-user-456");
  });

  it("emits admin.revoked audit log", async () => {
    const { DELETE } = await import("../[accountId]/route");
    await DELETE(makeDeleteRequest());

    expect(mockAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({
        actorId: SELF_ACCOUNT_ID,
        authContext: "admin",
        action: "admin.revoked",
        targetType: "account",
        targetId: TARGET_ACCOUNT_ID,
      }),
    );
  });

  it("returns 404 when account does not exist", async () => {
    mockTxQuery.mockReset();
    mockTxQuery.mockResolvedValueOnce({ rows: [] });

    const { DELETE } = await import("../[accountId]/route");
    const res = await DELETE(makeDeleteRequest());

    expect(res.status).toBe(404);
  });

  it("returns 409 when account is not an admin", async () => {
    mockTxQuery.mockReset();
    mockTxQuery.mockResolvedValueOnce({
      rows: [{ admin_eligible: false, oidc_subject: "kc-user-456" }],
    });

    const { DELETE } = await import("../[accountId]/route");
    const res = await DELETE(makeDeleteRequest());

    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error).toBe("Account is not an admin");
  });

  it("does not revert DB on Keycloak role removal failure", async () => {
    mockRemoveAdminRole.mockRejectedValue(new Error("Keycloak error"));

    const { DELETE } = await import("../[accountId]/route");
    const res = await DELETE(makeDeleteRequest());

    // Should still succeed (Keycloak removal is best-effort on revoke)
    expect(res.status).toBe(204);
  });

  it("uses SELECT FOR UPDATE for concurrency safety", async () => {
    const { DELETE } = await import("../[accountId]/route");
    await DELETE(makeDeleteRequest());

    const firstSql = mockTxQuery.mock.calls[0][0] as string;
    expect(firstSql).toContain("FOR UPDATE");
  });
});
