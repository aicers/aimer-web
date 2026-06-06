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
const mockAuditLog = vi.fn<(params: { action: string }) => Promise<void>>(
  async () => {},
);

const SELF_ACCOUNT_ID = "00000000-0000-0000-0000-000000000099";
const TARGET_ACCOUNT_ID = "a0000000-0000-0000-0000-000000000001";
const CUSTOMER_A = "c0000000-0000-0000-0000-00000000000a";
const CUSTOMER_B = "c0000000-0000-0000-0000-00000000000b";

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

const BASE_URL = "http://localhost:3000/api/admin/analysts";

function makeGetRequest(path = ""): NextRequest {
  return new NextRequest(new URL(`${BASE_URL}${path}`), { method: "GET" });
}

function makePostRequest(body: unknown, path = ""): NextRequest {
  return new NextRequest(new URL(`${BASE_URL}${path}`), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

function makePatchRequest(body: unknown, accountId = TARGET_ACCOUNT_ID) {
  return new NextRequest(new URL(`${BASE_URL}/${accountId}`), {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

function makeDeleteRequest(
  accountId = TARGET_ACCOUNT_ID,
  customerId = CUSTOMER_A,
): NextRequest {
  return new NextRequest(
    new URL(`${BASE_URL}/${accountId}/assignments/${customerId}`),
    { method: "DELETE" },
  );
}

// ---------------------------------------------------------------------------
// Tests — GET /api/admin/analysts
// ---------------------------------------------------------------------------

describe("GET /api/admin/analysts", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAssertAuthorized.mockResolvedValue(new Set(["analysts:read"]));
    mockPoolQuery.mockResolvedValue({ rows: [] });
  });

  it("calls assertAuthorized with analysts:read", async () => {
    const { GET } = await import("../route");
    await GET(makeGetRequest());

    expect(mockAssertAuthorized).toHaveBeenCalledWith(
      expect.anything(),
      "admin",
      SELF_ACCOUNT_ID,
      "analysts:read",
    );
  });

  it("returns 403 when not authorized", async () => {
    const { HttpError } = await import("@/lib/auth/errors");
    mockAssertAuthorized.mockRejectedValue(new HttpError("Forbidden", 403));

    const { GET } = await import("../route");
    const res = await GET(makeGetRequest());

    expect(res.status).toBe(403);
  });

  it("includes eligible OR assigned accounts via SQL", async () => {
    const { GET } = await import("../route");
    await GET(makeGetRequest());

    const sql = mockPoolQuery.mock.calls[0][0] as string;
    expect(sql).toContain("analyst_eligible = true");
    expect(sql).toContain("aca.customer_id IS NOT NULL");
  });

  it("returns mapped camelCase analyst data", async () => {
    mockPoolQuery.mockResolvedValue({
      rows: [
        {
          account_id: TARGET_ACCOUNT_ID,
          email: "a@example.com",
          display_name: "Analyst One",
          analyst_eligible: true,
          assigned_customer_ids: [CUSTOMER_A, CUSTOMER_B],
          last_sign_in_at: "2026-03-31T10:00:00.000Z",
        },
      ],
    });

    const { GET } = await import("../route");
    const res = await GET(makeGetRequest());
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.analysts).toHaveLength(1);
    expect(body.analysts[0]).toEqual({
      accountId: TARGET_ACCOUNT_ID,
      email: "a@example.com",
      displayName: "Analyst One",
      analystEligible: true,
      assignedCustomerIds: [CUSTOMER_A, CUSTOMER_B],
      lastSignInAt: "2026-03-31T10:00:00.000Z",
    });
  });
});

// ---------------------------------------------------------------------------
// Tests — POST /api/admin/analysts (designation)
// ---------------------------------------------------------------------------

describe("POST /api/admin/analysts", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockTxQuery.mockReset();
    mockAssertAuthorized.mockResolvedValue(new Set(["analysts:write"]));
    // Default happy path: account active, customers active, eligibility
    // flips, both inserts new.
    mockTxQuery
      .mockResolvedValueOnce({ rows: [{ status: "active" }] }) // account lookup
      .mockResolvedValueOnce({
        rows: [
          { id: CUSTOMER_A, status: "active" },
          { id: CUSTOMER_B, status: "active" },
        ],
      }) // customer validation
      .mockResolvedValueOnce({ rows: [{ analyst_eligible: true }] }) // eligible update
      .mockResolvedValueOnce({
        rows: [{ customer_id: CUSTOMER_A }, { customer_id: CUSTOMER_B }],
      }) // insert returning
      .mockResolvedValueOnce({
        rows: [{ customer_id: CUSTOMER_A }, { customer_id: CUSTOMER_B }],
      }); // current assignments
  });

  it("calls assertAuthorized with analysts:write", async () => {
    const { POST } = await import("../route");
    await POST(
      makePostRequest({
        accountId: TARGET_ACCOUNT_ID,
        customerIds: [CUSTOMER_A, CUSTOMER_B],
      }),
    );

    expect(mockAssertAuthorized).toHaveBeenCalledWith(
      expect.anything(),
      "admin",
      SELF_ACCOUNT_ID,
      "analysts:write",
    );
  });

  it("returns 400 for invalid accountId", async () => {
    const { POST } = await import("../route");
    const res = await POST(
      makePostRequest({ accountId: "nope", customerIds: [CUSTOMER_A] }),
    );
    expect(res.status).toBe(400);
  });

  it("returns 400 for empty customerIds", async () => {
    const { POST } = await import("../route");
    const res = await POST(
      makePostRequest({ accountId: TARGET_ACCOUNT_ID, customerIds: [] }),
    );
    expect(res.status).toBe(400);
  });

  it("returns 400 for non-UUID customerIds", async () => {
    const { POST } = await import("../route");
    const res = await POST(
      makePostRequest({ accountId: TARGET_ACCOUNT_ID, customerIds: ["nope"] }),
    );
    expect(res.status).toBe(400);
  });

  it("designates and returns 200 with state", async () => {
    const { POST } = await import("../route");
    const res = await POST(
      makePostRequest({
        accountId: TARGET_ACCOUNT_ID,
        customerIds: [CUSTOMER_A, CUSTOMER_B],
      }),
    );

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({
      accountId: TARGET_ACCOUNT_ID,
      analystEligible: true,
      assignedCustomerIds: [CUSTOMER_A, CUSTOMER_B],
    });
  });

  it("emits one eligible-changed and one created audit per inserted row", async () => {
    const { POST } = await import("../route");
    await POST(
      makePostRequest({
        accountId: TARGET_ACCOUNT_ID,
        customerIds: [CUSTOMER_A, CUSTOMER_B],
      }),
    );

    expect(mockAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "account.analyst_eligible_changed",
        details: { from: false, to: true },
      }),
    );
    const created = mockAuditLog.mock.calls.filter(
      (c) => c[0].action === "analyst.assignment.created",
    );
    expect(created).toHaveLength(2);
  });

  it("dedupes customerIds before insert", async () => {
    const { POST } = await import("../route");
    await POST(
      makePostRequest({
        accountId: TARGET_ACCOUNT_ID,
        customerIds: [CUSTOMER_A, CUSTOMER_A, CUSTOMER_B],
      }),
    );

    // customer validation query (2nd tx query) receives deduped array
    const validationParams = mockTxQuery.mock.calls[1][1] as unknown[];
    expect(validationParams[0]).toEqual([CUSTOMER_A, CUSTOMER_B]);
  });

  it("emits no eligible-changed audit when already eligible (idempotent)", async () => {
    mockTxQuery.mockReset();
    mockTxQuery
      .mockResolvedValueOnce({ rows: [{ status: "active" }] })
      .mockResolvedValueOnce({ rows: [{ id: CUSTOMER_A, status: "active" }] })
      .mockResolvedValueOnce({ rows: [] }) // eligible update no-op
      .mockResolvedValueOnce({ rows: [] }) // insert no-op
      .mockResolvedValueOnce({ rows: [{ customer_id: CUSTOMER_A }] });

    const { POST } = await import("../route");
    const res = await POST(
      makePostRequest({
        accountId: TARGET_ACCOUNT_ID,
        customerIds: [CUSTOMER_A],
      }),
    );

    expect(res.status).toBe(200);
    expect(mockAuditLog).not.toHaveBeenCalled();
  });

  it("returns 404 when account does not exist", async () => {
    mockTxQuery.mockReset();
    mockTxQuery.mockResolvedValueOnce({ rows: [] });

    const { POST } = await import("../route");
    const res = await POST(
      makePostRequest({
        accountId: TARGET_ACCOUNT_ID,
        customerIds: [CUSTOMER_A],
      }),
    );
    expect(res.status).toBe(404);
  });

  it("returns 400 when account is not active", async () => {
    mockTxQuery.mockReset();
    mockTxQuery.mockResolvedValueOnce({ rows: [{ status: "suspended" }] });

    const { POST } = await import("../route");
    const res = await POST(
      makePostRequest({
        accountId: TARGET_ACCOUNT_ID,
        customerIds: [CUSTOMER_A],
      }),
    );
    expect(res.status).toBe(400);
  });

  it("returns 404 when a customer does not exist", async () => {
    mockTxQuery.mockReset();
    mockTxQuery
      .mockResolvedValueOnce({ rows: [{ status: "active" }] })
      .mockResolvedValueOnce({ rows: [] }); // customer missing

    const { POST } = await import("../route");
    const res = await POST(
      makePostRequest({
        accountId: TARGET_ACCOUNT_ID,
        customerIds: [CUSTOMER_A],
      }),
    );
    expect(res.status).toBe(404);
  });

  it("returns 400 when a customer is not active", async () => {
    mockTxQuery.mockReset();
    mockTxQuery
      .mockResolvedValueOnce({ rows: [{ status: "active" }] })
      .mockResolvedValueOnce({
        rows: [{ id: CUSTOMER_A, status: "disabled" }],
      });

    const { POST } = await import("../route");
    const res = await POST(
      makePostRequest({
        accountId: TARGET_ACCOUNT_ID,
        customerIds: [CUSTOMER_A],
      }),
    );
    expect(res.status).toBe(400);
  });
});

// ---------------------------------------------------------------------------
// Tests — GET /api/admin/analysts/[accountId] (detail)
// ---------------------------------------------------------------------------

describe("GET /api/admin/analysts/[accountId]", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAssertAuthorized.mockResolvedValue(new Set(["analysts:read"]));
  });

  it("returns 404 when account not found", async () => {
    mockPoolQuery.mockResolvedValueOnce({ rows: [] });

    const { GET } = await import("../[accountId]/route");
    const res = await GET(makeGetRequest(`/${TARGET_ACCOUNT_ID}`));
    expect(res.status).toBe(404);
  });

  it("returns detail with assignedCustomers", async () => {
    mockPoolQuery
      .mockResolvedValueOnce({
        rows: [
          {
            account_id: TARGET_ACCOUNT_ID,
            email: "a@example.com",
            display_name: "Analyst One",
            analyst_eligible: true,
            last_sign_in_at: null,
          },
        ],
      })
      .mockResolvedValueOnce({
        rows: [
          {
            id: CUSTOMER_A,
            external_key: "ext-a",
            name: "Customer A",
            status: "active",
          },
        ],
      });

    const { GET } = await import("../[accountId]/route");
    const res = await GET(makeGetRequest(`/${TARGET_ACCOUNT_ID}`));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.accountId).toBe(TARGET_ACCOUNT_ID);
    expect(body.assignedCustomerIds).toEqual([CUSTOMER_A]);
    expect(body.assignedCustomers).toEqual([
      {
        id: CUSTOMER_A,
        externalKey: "ext-a",
        name: "Customer A",
        status: "active",
      },
    ]);
  });
});

// ---------------------------------------------------------------------------
// Tests — PATCH /api/admin/analysts/[accountId] (revoke)
// ---------------------------------------------------------------------------

describe("PATCH /api/admin/analysts/[accountId]", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockTxQuery.mockReset();
    mockAssertAuthorized.mockResolvedValue(new Set(["analysts:write"]));
    mockTxQuery
      .mockResolvedValueOnce({ rows: [{ analyst_eligible: true }] }) // existence
      .mockResolvedValueOnce({ rows: [{ analyst_eligible: false }] }); // update
  });

  it("returns 400 for non-boolean analystEligible", async () => {
    const { PATCH } = await import("../[accountId]/route");
    const res = await PATCH(makePatchRequest({ analystEligible: "no" }));
    expect(res.status).toBe(400);
  });

  it("rejects analystEligible: true (revocation only, no write)", async () => {
    const { PATCH } = await import("../[accountId]/route");
    const res = await PATCH(makePatchRequest({ analystEligible: true }));
    expect(res.status).toBe(400);
    // Re-enablement must go through POST designation: no DB write, no audit.
    expect(mockTxQuery).not.toHaveBeenCalled();
    expect(mockAuditLog).not.toHaveBeenCalled();
  });

  it("revokes and emits audit", async () => {
    const { PATCH } = await import("../[accountId]/route");
    const res = await PATCH(makePatchRequest({ analystEligible: false }));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body).toEqual({
      accountId: TARGET_ACCOUNT_ID,
      analystEligible: false,
    });
    expect(mockAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "account.analyst_eligible_changed",
        details: { from: true, to: false },
      }),
    );
  });

  it("returns 404 when account not found", async () => {
    mockTxQuery.mockReset();
    mockTxQuery.mockResolvedValueOnce({ rows: [] });

    const { PATCH } = await import("../[accountId]/route");
    const res = await PATCH(makePatchRequest({ analystEligible: false }));
    expect(res.status).toBe(404);
  });

  it("emits no audit on no-op (already revoked)", async () => {
    mockTxQuery.mockReset();
    mockTxQuery
      .mockResolvedValueOnce({ rows: [{ analyst_eligible: false }] })
      .mockResolvedValueOnce({ rows: [] }); // update no-op

    const { PATCH } = await import("../[accountId]/route");
    const res = await PATCH(makePatchRequest({ analystEligible: false }));
    expect(res.status).toBe(200);
    expect(mockAuditLog).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Tests — POST /api/admin/analysts/[accountId]/assignments (add)
// ---------------------------------------------------------------------------

describe("POST /api/admin/analysts/[accountId]/assignments", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockTxQuery.mockReset();
    mockAssertAuthorized.mockResolvedValue(new Set(["analysts:write"]));
    mockTxQuery
      .mockResolvedValueOnce({ rows: [{ id: TARGET_ACCOUNT_ID }] }) // account
      .mockResolvedValueOnce({ rows: [{ status: "active" }] }) // customer
      .mockResolvedValueOnce({ rows: [{ customer_id: CUSTOMER_A }] }); // insert
  });

  it("adds assignment and emits audit", async () => {
    const { POST } = await import("../[accountId]/assignments/route");
    const res = await POST(
      makePostRequest(
        { customerId: CUSTOMER_A },
        `/${TARGET_ACCOUNT_ID}/assignments`,
      ),
    );
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body).toEqual({
      accountId: TARGET_ACCOUNT_ID,
      customerId: CUSTOMER_A,
    });
    expect(mockAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({ action: "analyst.assignment.created" }),
    );
  });

  it("is idempotent — no audit when row already exists", async () => {
    mockTxQuery.mockReset();
    mockTxQuery
      .mockResolvedValueOnce({ rows: [{ id: TARGET_ACCOUNT_ID }] })
      .mockResolvedValueOnce({ rows: [{ status: "active" }] })
      .mockResolvedValueOnce({ rows: [] }); // conflict, no insert

    const { POST } = await import("../[accountId]/assignments/route");
    const res = await POST(
      makePostRequest(
        { customerId: CUSTOMER_A },
        `/${TARGET_ACCOUNT_ID}/assignments`,
      ),
    );
    expect(res.status).toBe(200);
    expect(mockAuditLog).not.toHaveBeenCalled();
  });

  it("returns 404 when account not found", async () => {
    mockTxQuery.mockReset();
    mockTxQuery.mockResolvedValueOnce({ rows: [] });

    const { POST } = await import("../[accountId]/assignments/route");
    const res = await POST(
      makePostRequest(
        { customerId: CUSTOMER_A },
        `/${TARGET_ACCOUNT_ID}/assignments`,
      ),
    );
    expect(res.status).toBe(404);
  });

  it("returns 404 when customer not found", async () => {
    mockTxQuery.mockReset();
    mockTxQuery
      .mockResolvedValueOnce({ rows: [{ id: TARGET_ACCOUNT_ID }] })
      .mockResolvedValueOnce({ rows: [] });

    const { POST } = await import("../[accountId]/assignments/route");
    const res = await POST(
      makePostRequest(
        { customerId: CUSTOMER_A },
        `/${TARGET_ACCOUNT_ID}/assignments`,
      ),
    );
    expect(res.status).toBe(404);
  });

  it("returns 400 when customer not active", async () => {
    mockTxQuery.mockReset();
    mockTxQuery
      .mockResolvedValueOnce({ rows: [{ id: TARGET_ACCOUNT_ID }] })
      .mockResolvedValueOnce({ rows: [{ status: "disabled" }] });

    const { POST } = await import("../[accountId]/assignments/route");
    const res = await POST(
      makePostRequest(
        { customerId: CUSTOMER_A },
        `/${TARGET_ACCOUNT_ID}/assignments`,
      ),
    );
    expect(res.status).toBe(400);
  });
});

// ---------------------------------------------------------------------------
// Tests — DELETE /api/admin/analysts/[accountId]/assignments/[customerId]
// ---------------------------------------------------------------------------

describe("DELETE /api/admin/analysts/[accountId]/assignments/[customerId]", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAssertAuthorized.mockResolvedValue(new Set(["analysts:write"]));
  });

  it("returns 400 for invalid UUIDs", async () => {
    const { DELETE } = await import(
      "../[accountId]/assignments/[customerId]/route"
    );
    const res = await DELETE(makeDeleteRequest("nope", CUSTOMER_A));
    expect(res.status).toBe(400);
  });

  it("removes assignment and emits audit", async () => {
    mockPoolQuery.mockResolvedValueOnce({
      rows: [{ customer_id: CUSTOMER_A }],
    });

    const { DELETE } = await import(
      "../[accountId]/assignments/[customerId]/route"
    );
    const res = await DELETE(makeDeleteRequest());
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body).toEqual({
      accountId: TARGET_ACCOUNT_ID,
      customerId: CUSTOMER_A,
    });
    expect(mockAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({ action: "analyst.assignment.removed" }),
    );
  });

  it("is idempotent — 200 with no audit for unknown row", async () => {
    mockPoolQuery.mockResolvedValueOnce({ rows: [] });

    const { DELETE } = await import(
      "../[accountId]/assignments/[customerId]/route"
    );
    const res = await DELETE(makeDeleteRequest());

    expect(res.status).toBe(200);
    expect(mockAuditLog).not.toHaveBeenCalled();
  });
});
