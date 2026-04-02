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

// Transaction mock: captures the query calls made inside the transaction
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

const BASE_URL = "http://localhost:3000/api/admin/accounts";
const TARGET_ACCOUNT_ID = "a0000000-0000-0000-0000-000000000001";
const PATCH_URL = `${BASE_URL}/${TARGET_ACCOUNT_ID}`;

function makeGetRequest(): NextRequest {
  return new NextRequest(new URL(BASE_URL), { method: "GET" });
}

function makePatchRequest(
  body: unknown,
  accountId = TARGET_ACCOUNT_ID,
): NextRequest {
  return new NextRequest(new URL(`${BASE_URL}/${accountId}`), {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

function makeSampleAccountRow(overrides: Record<string, unknown> = {}) {
  return {
    id: TARGET_ACCOUNT_ID,
    username: "testuser",
    display_name: "Test User",
    email: "test@example.com",
    status: "active",
    last_sign_in_at: "2026-03-31T10:00:00.000Z",
    admin_eligible: false,
    analyst_eligible: false,
    created_at: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests — GET /api/admin/accounts
// ---------------------------------------------------------------------------

describe("GET /api/admin/accounts", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAssertAuthorized.mockResolvedValue(new Set(["accounts:read"]));
    mockPoolQuery.mockResolvedValue({ rows: [] });
  });

  it("calls assertAuthorized with admin context and accounts:read", async () => {
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
    const body = await res.json();
    expect(body.error).toBe("Forbidden");
  });

  it("releases auth pool connection even when authorization fails", async () => {
    mockAssertAuthorized.mockRejectedValue(new Error("connection error"));

    const { GET } = await import("../route");
    await GET(makeGetRequest()).catch(() => {});

    const client = mockConnect.mock.results[0].value;
    expect(client.release).toHaveBeenCalled();
  });

  it("returns empty accounts array when no accounts exist", async () => {
    const { GET } = await import("../route");
    const res = await GET(makeGetRequest());
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.accounts).toEqual([]);
  });

  it("returns mapped camelCase accounts", async () => {
    const row = makeSampleAccountRow();
    mockPoolQuery.mockResolvedValue({ rows: [row] });

    const { GET } = await import("../route");
    const res = await GET(makeGetRequest());
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.accounts).toHaveLength(1);
    expect(body.accounts[0]).toEqual({
      id: row.id,
      username: row.username,
      displayName: row.display_name,
      email: row.email,
      status: row.status,
      lastSignInAt: row.last_sign_in_at,
      adminEligible: row.admin_eligible,
      analystEligible: row.analyst_eligible,
      createdAt: row.created_at,
    });
  });

  it("handles multiple accounts with varying fields", async () => {
    const rows = [
      makeSampleAccountRow({ id: "a1", email: null, last_sign_in_at: null }),
      makeSampleAccountRow({
        id: "a2",
        admin_eligible: true,
        analyst_eligible: true,
        status: "suspended",
      }),
    ];
    mockPoolQuery.mockResolvedValue({ rows });

    const { GET } = await import("../route");
    const res = await GET(makeGetRequest());
    const body = await res.json();

    expect(body.accounts).toHaveLength(2);
    expect(body.accounts[0].email).toBeNull();
    expect(body.accounts[0].lastSignInAt).toBeNull();
    expect(body.accounts[1].adminEligible).toBe(true);
    expect(body.accounts[1].analystEligible).toBe(true);
    expect(body.accounts[1].status).toBe("suspended");
  });

  it("orders by created_at", async () => {
    const { GET } = await import("../route");
    await GET(makeGetRequest());

    const sql = mockPoolQuery.mock.calls[0][0] as string;
    expect(sql).toContain("ORDER BY created_at");
  });
});

// ---------------------------------------------------------------------------
// Tests — PATCH /api/admin/accounts/[accountId]
// ---------------------------------------------------------------------------

describe("PATCH /api/admin/accounts/[accountId]", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAssertAuthorized.mockResolvedValue(new Set(["accounts:write"]));
    // Default: account found with active status
    mockTxQuery.mockResolvedValue({ rows: [{ status: "active" }] });
  });

  // =========================================================================
  // Authorization
  // =========================================================================

  it("calls assertAuthorized with accounts:write", async () => {
    const { PATCH } = await import("../[accountId]/route");
    await PATCH(makePatchRequest({ status: "suspended" }));

    expect(mockAssertAuthorized).toHaveBeenCalledWith(
      expect.anything(),
      "admin",
      SELF_ACCOUNT_ID,
      "accounts:write",
    );
  });

  it("returns 403 when assertAuthorized rejects", async () => {
    const { HttpError } = await import("@/lib/auth/errors");
    mockAssertAuthorized.mockRejectedValue(new HttpError("Forbidden", 403));

    const { PATCH } = await import("../[accountId]/route");
    const res = await PATCH(makePatchRequest({ status: "suspended" }));

    expect(res.status).toBe(403);
  });

  it("releases auth pool connection on authorization failure", async () => {
    mockAssertAuthorized.mockRejectedValue(new Error("db error"));

    const { PATCH } = await import("../[accountId]/route");
    await PATCH(makePatchRequest({ status: "suspended" })).catch(() => {});

    const client = mockConnect.mock.results[0].value;
    expect(client.release).toHaveBeenCalled();
  });

  // =========================================================================
  // Self-suspension prevention
  // =========================================================================

  it("returns 400 when admin tries to suspend their own account", async () => {
    const { PATCH } = await import("../[accountId]/route");
    // acct-1 is the authenticated admin's accountId
    const res = await PATCH(
      makePatchRequest({ status: "suspended" }, SELF_ACCOUNT_ID),
    );

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe("cannot_suspend_self");
  });

  // =========================================================================
  // Input validation
  // =========================================================================

  it("returns 400 for invalid UUID in path", async () => {
    const { PATCH } = await import("../[accountId]/route");
    const res = await PATCH(
      makePatchRequest({ status: "suspended" }, "not-a-uuid"),
    );

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe("Invalid account ID");
  });

  it("returns 400 for invalid status value", async () => {
    const { PATCH } = await import("../[accountId]/route");
    const res = await PATCH(makePatchRequest({ status: "deleted" }));

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toContain("status must be");
  });

  it("returns 400 for missing status field", async () => {
    const { PATCH } = await import("../[accountId]/route");
    const res = await PATCH(makePatchRequest({}));

    expect(res.status).toBe(400);
  });

  it("returns 400 for non-string status", async () => {
    const { PATCH } = await import("../[accountId]/route");
    const res = await PATCH(makePatchRequest({ status: 123 }));

    expect(res.status).toBe(400);
  });

  it("returns 400 for non-object body", async () => {
    const { PATCH } = await import("../[accountId]/route");
    const req = new NextRequest(new URL(PATCH_URL), {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify("just a string"),
    });
    const res = await PATCH(req);

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe("Request body must be a JSON object");
  });

  it("returns 400 for array body", async () => {
    const { PATCH } = await import("../[accountId]/route");
    const req = new NextRequest(new URL(PATCH_URL), {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify([{ status: "suspended" }]),
    });
    const res = await PATCH(req);

    expect(res.status).toBe(400);
  });

  it("returns 400 for invalid JSON body", async () => {
    const { PATCH } = await import("../[accountId]/route");
    const req = new NextRequest(new URL(PATCH_URL), {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: "not json{",
    });
    const res = await PATCH(req);

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe("Invalid JSON");
  });

  // =========================================================================
  // Not found
  // =========================================================================

  it("returns 404 when account does not exist", async () => {
    mockTxQuery.mockResolvedValue({ rows: [] });

    const { PATCH } = await import("../[accountId]/route");
    const res = await PATCH(makePatchRequest({ status: "suspended" }));

    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error).toBe("Account not found");
  });

  // =========================================================================
  // Disabled account guard
  // =========================================================================

  it("returns 409 when trying to change a disabled account", async () => {
    mockTxQuery.mockResolvedValueOnce({ rows: [{ status: "disabled" }] });

    const { PATCH } = await import("../[accountId]/route");
    const res = await PATCH(makePatchRequest({ status: "active" }));

    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error).toBe("Cannot change status of a disabled account");
  });

  it("returns 409 when trying to suspend a disabled account", async () => {
    mockTxQuery.mockResolvedValueOnce({ rows: [{ status: "disabled" }] });

    const { PATCH } = await import("../[accountId]/route");
    const res = await PATCH(makePatchRequest({ status: "suspended" }));

    expect(res.status).toBe(409);
  });

  // =========================================================================
  // Suspend flow
  // =========================================================================

  it("suspends account and returns updated status", async () => {
    // First call: SELECT status → active; rest: UPDATE calls
    mockTxQuery
      .mockResolvedValueOnce({ rows: [{ status: "active" }] })
      .mockResolvedValue({ rows: [] });

    const { PATCH } = await import("../[accountId]/route");
    const res = await PATCH(makePatchRequest({ status: "suspended" }));

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ id: TARGET_ACCOUNT_ID, status: "suspended" });
  });

  it("revokes sessions and bumps token_version on suspend", async () => {
    mockTxQuery
      .mockResolvedValueOnce({ rows: [{ status: "active" }] })
      .mockResolvedValue({ rows: [] });

    const { PATCH } = await import("../[accountId]/route");
    await PATCH(makePatchRequest({ status: "suspended" }));

    // Verify the three transactional queries:
    // 1. SELECT FOR UPDATE
    // 2. UPDATE status
    // 3. UPDATE sessions SET revoked = true
    // 4. UPDATE token_version
    expect(mockTxQuery).toHaveBeenCalledTimes(4);

    const calls = mockTxQuery.mock.calls;
    // Session revocation
    expect(calls[2][0]).toContain("SET revoked = true");
    expect(calls[2][1]).toContain(TARGET_ACCOUNT_ID);
    // Token version bump
    expect(calls[3][0]).toContain("token_version = token_version + 1");
    expect(calls[3][1]).toContain(TARGET_ACCOUNT_ID);
  });

  it("emits account.suspended audit log on suspend", async () => {
    mockTxQuery
      .mockResolvedValueOnce({ rows: [{ status: "active" }] })
      .mockResolvedValue({ rows: [] });

    const { PATCH } = await import("../[accountId]/route");
    await PATCH(makePatchRequest({ status: "suspended" }));

    expect(mockAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({
        actorId: SELF_ACCOUNT_ID,
        authContext: "admin",
        action: "account.suspended",
        targetType: "account",
        targetId: TARGET_ACCOUNT_ID,
        details: { previousStatus: "active", newStatus: "suspended" },
      }),
    );
  });

  // =========================================================================
  // Unsuspend (restore) flow
  // =========================================================================

  it("unsuspends account and returns updated status", async () => {
    mockTxQuery
      .mockResolvedValueOnce({ rows: [{ status: "suspended" }] })
      .mockResolvedValue({ rows: [] });

    const { PATCH } = await import("../[accountId]/route");
    const res = await PATCH(makePatchRequest({ status: "active" }));

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ id: TARGET_ACCOUNT_ID, status: "active" });
  });

  it("does NOT revoke sessions or bump token_version on unsuspend", async () => {
    mockTxQuery
      .mockResolvedValueOnce({ rows: [{ status: "suspended" }] })
      .mockResolvedValue({ rows: [] });

    const { PATCH } = await import("../[accountId]/route");
    await PATCH(makePatchRequest({ status: "active" }));

    // Only 2 queries: SELECT FOR UPDATE + UPDATE status
    expect(mockTxQuery).toHaveBeenCalledTimes(2);
  });

  it("emits account.restored audit log on unsuspend", async () => {
    mockTxQuery
      .mockResolvedValueOnce({ rows: [{ status: "suspended" }] })
      .mockResolvedValue({ rows: [] });

    const { PATCH } = await import("../[accountId]/route");
    await PATCH(makePatchRequest({ status: "active" }));

    expect(mockAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "account.restored",
        details: { previousStatus: "suspended", newStatus: "active" },
      }),
    );
  });

  // =========================================================================
  // No-op when status unchanged
  // =========================================================================

  it("returns 200 without DB writes when status already matches", async () => {
    mockTxQuery.mockResolvedValueOnce({ rows: [{ status: "suspended" }] });

    const { PATCH } = await import("../[accountId]/route");
    const res = await PATCH(makePatchRequest({ status: "suspended" }));

    expect(res.status).toBe(200);
    // Only the SELECT FOR UPDATE query; no UPDATE
    expect(mockTxQuery).toHaveBeenCalledTimes(1);
  });

  it("does not emit audit log when status already matches", async () => {
    mockTxQuery.mockResolvedValueOnce({ rows: [{ status: "active" }] });

    const { PATCH } = await import("../[accountId]/route");
    await PATCH(makePatchRequest({ status: "active" }));

    expect(mockAuditLog).not.toHaveBeenCalled();
  });

  // =========================================================================
  // Row locking
  // =========================================================================

  it("uses SELECT FOR UPDATE for concurrency safety", async () => {
    mockTxQuery
      .mockResolvedValueOnce({ rows: [{ status: "active" }] })
      .mockResolvedValue({ rows: [] });

    const { PATCH } = await import("../[accountId]/route");
    await PATCH(makePatchRequest({ status: "suspended" }));

    const selectSql = mockTxQuery.mock.calls[0][0] as string;
    expect(selectSql).toContain("FOR UPDATE");
  });
});
