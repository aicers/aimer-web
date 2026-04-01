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

const mockWithAuth = vi.fn(
  // biome-ignore lint/complexity/noBannedTypes: test mock needs generic callable
  (handler: Function) => (req: NextRequest) =>
    handler(req, {
      accountId: "acct-1",
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

vi.mock("@/lib/db/client", () => ({
  getAuthPool: vi.fn(() => ({ connect: mockConnect })),
  getAuditPool: vi.fn(() => ({ query: mockPoolQuery })),
}));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const BASE_URL = "http://localhost:3000/api/admin/audit-logs";

function makeRequest(params?: Record<string, string>): NextRequest {
  const url = new URL(BASE_URL);
  if (params) {
    for (const [key, value] of Object.entries(params)) {
      url.searchParams.set(key, value);
    }
  }
  return new NextRequest(url, { method: "GET" });
}

function makeSampleRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 42,
    timestamp: "2026-03-31T10:00:00.000Z",
    actor_id: "actor-1",
    auth_context: "admin",
    action: "admin.auth.sign_in_success",
    target_type: "session",
    target_id: "sess-1",
    details: { reason: "test" },
    ip_address: "127.0.0.1",
    sid: "sid-1",
    customer_id: null,
    aice_id: null,
    correlation_id: "c0000000-0000-0000-0000-000000000001",
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("GET /api/admin/audit-logs", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAssertAuthorized.mockResolvedValue(new Set(["audit-logs:read"]));
    mockPoolQuery.mockResolvedValue({ rows: [] });
  });

  // =========================================================================
  // Authorization
  // =========================================================================

  it("calls assertAuthorized with admin context and audit-logs:read", async () => {
    const { GET } = await import("../route");
    await GET(makeRequest());

    expect(mockAssertAuthorized).toHaveBeenCalledWith(
      expect.anything(), // PoolClient
      "admin",
      "acct-1",
      "audit-logs:read",
    );
  });

  it("returns 403 when assertAuthorized rejects", async () => {
    const { HttpError } = await import("@/lib/auth/errors");
    mockAssertAuthorized.mockRejectedValue(new HttpError("Forbidden", 403));

    const { GET } = await import("../route");
    const res = await GET(makeRequest());

    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error).toBe("Forbidden");
  });

  it("releases auth pool connection even when authorization fails", async () => {
    mockAssertAuthorized.mockRejectedValue(new Error("connection error"));

    const { GET } = await import("../route");
    await GET(makeRequest()).catch(() => {});

    const client = mockConnect.mock.results[0].value;
    expect(client.release).toHaveBeenCalled();
  });

  // =========================================================================
  // Default behaviour (no filters)
  // =========================================================================

  it("returns empty data array when no logs exist", async () => {
    const { GET } = await import("../route");
    const res = await GET(makeRequest());
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.data).toEqual([]);
    expect(body.nextCursor).toBeNull();
  });

  it("returns mapped camelCase entries", async () => {
    const row = makeSampleRow();
    mockPoolQuery.mockResolvedValue({ rows: [row] });

    const { GET } = await import("../route");
    const res = await GET(makeRequest());
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.data).toHaveLength(1);
    expect(body.data[0]).toEqual({
      id: "42",
      timestamp: row.timestamp,
      actorId: row.actor_id,
      authContext: row.auth_context,
      action: row.action,
      targetType: row.target_type,
      targetId: row.target_id,
      details: row.details,
      ipAddress: row.ip_address,
      sid: row.sid,
      customerId: row.customer_id,
      aiceId: row.aice_id,
      correlationId: row.correlation_id,
    });
  });

  // =========================================================================
  // Pagination
  // =========================================================================

  it("defaults to limit 50 (queries 51 for hasMore)", async () => {
    const { GET } = await import("../route");
    await GET(makeRequest());

    const sql = mockPoolQuery.mock.calls[0][0] as string;
    const params = mockPoolQuery.mock.calls[0][1] as unknown[];
    expect(sql).toContain("LIMIT $1");
    expect(params).toContain(51); // limit + 1
  });

  it("respects custom limit", async () => {
    const { GET } = await import("../route");
    await GET(makeRequest({ limit: "10" }));

    const params = mockPoolQuery.mock.calls[0][1] as unknown[];
    expect(params).toContain(11); // 10 + 1
  });

  it("returns nextCursor when more results exist", async () => {
    // Return 51 rows (limit 50 + 1 extra)
    const rows = Array.from({ length: 51 }, (_, i) =>
      makeSampleRow({ id: 100 - i }),
    );
    mockPoolQuery.mockResolvedValue({ rows });

    const { GET } = await import("../route");
    const res = await GET(makeRequest());
    const body = await res.json();

    expect(body.data).toHaveLength(50);
    expect(body.nextCursor).toBe("51"); // last row's id
  });

  it("returns null nextCursor when no more results", async () => {
    const rows = Array.from({ length: 5 }, (_, i) =>
      makeSampleRow({ id: 5 - i }),
    );
    mockPoolQuery.mockResolvedValue({ rows });

    const { GET } = await import("../route");
    const res = await GET(makeRequest());
    const body = await res.json();

    expect(body.data).toHaveLength(5);
    expect(body.nextCursor).toBeNull();
  });

  it("applies cursor to WHERE clause", async () => {
    const { GET } = await import("../route");
    await GET(makeRequest({ cursor: "99" }));

    const sql = mockPoolQuery.mock.calls[0][0] as string;
    const params = mockPoolQuery.mock.calls[0][1] as unknown[];
    expect(sql).toContain("id < $1");
    expect(params[0]).toBe(99);
  });

  // =========================================================================
  // Filtering
  // =========================================================================

  it("filters by auth_context", async () => {
    const { GET } = await import("../route");
    await GET(makeRequest({ auth_context: "admin" }));

    const sql = mockPoolQuery.mock.calls[0][0] as string;
    const params = mockPoolQuery.mock.calls[0][1] as unknown[];
    expect(sql).toContain("auth_context = $1");
    expect(params[0]).toBe("admin");
  });

  it("filters by action", async () => {
    const { GET } = await import("../route");
    await GET(makeRequest({ action: "admin.auth.sign_in_success" }));

    const sql = mockPoolQuery.mock.calls[0][0] as string;
    expect(sql).toContain("action = $1");
  });

  it("filters by actor_id", async () => {
    const { GET } = await import("../route");
    await GET(makeRequest({ actor_id: "actor-abc" }));

    const sql = mockPoolQuery.mock.calls[0][0] as string;
    expect(sql).toContain("actor_id = $1");
  });

  it("filters by customer_id (UUID cast)", async () => {
    const uuid = "a0000000-0000-0000-0000-000000000001";
    const { GET } = await import("../route");
    await GET(makeRequest({ customer_id: uuid }));

    const sql = mockPoolQuery.mock.calls[0][0] as string;
    expect(sql).toContain("customer_id = $1::uuid");
  });

  it("filters by aice_id", async () => {
    const { GET } = await import("../route");
    await GET(makeRequest({ aice_id: "aice-env-1" }));

    const sql = mockPoolQuery.mock.calls[0][0] as string;
    expect(sql).toContain("aice_id = $1");
  });

  it("filters by correlation_id (UUID cast)", async () => {
    const uuid = "c0000000-0000-0000-0000-000000000001";
    const { GET } = await import("../route");
    await GET(makeRequest({ correlation_id: uuid }));

    const sql = mockPoolQuery.mock.calls[0][0] as string;
    expect(sql).toContain("correlation_id = $1::uuid");
  });

  it("filters by date range (from/to)", async () => {
    const { GET } = await import("../route");
    await GET(
      makeRequest({
        from: "2026-01-01T00:00:00Z",
        to: "2026-12-31T23:59:59Z",
      }),
    );

    const sql = mockPoolQuery.mock.calls[0][0] as string;
    expect(sql).toContain("timestamp >= $1::timestamptz");
    expect(sql).toContain("timestamp <= $2::timestamptz");
  });

  it("combines multiple filters into AND conditions", async () => {
    const { GET } = await import("../route");
    await GET(
      makeRequest({
        auth_context: "general",
        action: "general.auth.sign_in_success",
        actor_id: "actor-1",
      }),
    );

    const sql = mockPoolQuery.mock.calls[0][0] as string;
    expect(sql).toContain("auth_context = $1");
    expect(sql).toContain("action = $2");
    expect(sql).toContain("actor_id = $3");
    expect(sql).toContain("AND");
  });

  // =========================================================================
  // Validation errors
  // =========================================================================

  it("returns 400 for invalid cursor", async () => {
    const { GET } = await import("../route");
    const res = await GET(makeRequest({ cursor: "not-a-number" }));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toContain("cursor");
  });

  it("returns 400 for negative cursor", async () => {
    const { GET } = await import("../route");
    const res = await GET(makeRequest({ cursor: "-5" }));
    expect(res.status).toBe(400);
  });

  it("returns 400 for limit below 1", async () => {
    const { GET } = await import("../route");
    const res = await GET(makeRequest({ limit: "0" }));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toContain("limit");
  });

  it("returns 400 for limit above 200", async () => {
    const { GET } = await import("../route");
    const res = await GET(makeRequest({ limit: "201" }));
    expect(res.status).toBe(400);
  });

  it("returns 400 for non-numeric limit", async () => {
    const { GET } = await import("../route");
    const res = await GET(makeRequest({ limit: "abc" }));
    expect(res.status).toBe(400);
  });

  it("returns 400 for invalid auth_context", async () => {
    const { GET } = await import("../route");
    const res = await GET(makeRequest({ auth_context: "superadmin" }));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toContain("auth_context");
  });

  it("returns 400 for invalid customer_id UUID", async () => {
    const { GET } = await import("../route");
    const res = await GET(makeRequest({ customer_id: "not-a-uuid" }));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toContain("customer_id");
  });

  it("returns 400 for invalid correlation_id UUID", async () => {
    const { GET } = await import("../route");
    const res = await GET(makeRequest({ correlation_id: "bad" }));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toContain("correlation_id");
  });

  it("returns 400 for invalid from date", async () => {
    const { GET } = await import("../route");
    const res = await GET(makeRequest({ from: "not-a-date" }));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toContain("from");
  });

  it("returns 400 for invalid to date", async () => {
    const { GET } = await import("../route");
    const res = await GET(makeRequest({ to: "also-not-a-date" }));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toContain("to");
  });

  // =========================================================================
  // Boundary values
  // =========================================================================

  it("accepts limit=1 (minimum)", async () => {
    const { GET } = await import("../route");
    const res = await GET(makeRequest({ limit: "1" }));
    expect(res.status).toBe(200);

    const params = mockPoolQuery.mock.calls[0][1] as unknown[];
    expect(params).toContain(2); // 1 + 1
  });

  it("accepts limit=200 (maximum)", async () => {
    const { GET } = await import("../route");
    const res = await GET(makeRequest({ limit: "200" }));
    expect(res.status).toBe(200);

    const params = mockPoolQuery.mock.calls[0][1] as unknown[];
    expect(params).toContain(201); // 200 + 1
  });

  it("accepts cursor=0", async () => {
    const { GET } = await import("../route");
    const res = await GET(makeRequest({ cursor: "0" }));
    expect(res.status).toBe(200);
  });

  // =========================================================================
  // Error propagation
  // =========================================================================

  it("propagates unexpected DB errors", async () => {
    mockPoolQuery.mockRejectedValue(new Error("connection refused"));

    const { GET } = await import("../route");
    await expect(GET(makeRequest())).rejects.toThrow("connection refused");
  });

  // =========================================================================
  // SQL ordering
  // =========================================================================

  it("orders results by id DESC", async () => {
    const { GET } = await import("../route");
    await GET(makeRequest());

    const sql = mockPoolQuery.mock.calls[0][0] as string;
    expect(sql).toContain("ORDER BY id DESC");
  });
});
