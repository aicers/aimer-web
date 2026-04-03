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

vi.mock("@/lib/db/client", () => ({
  getAuthPool: vi.fn(() => ({ query: mockPoolQuery, connect: mockConnect })),
}));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const AICE_ID = "test-env-01";
const CUSTOMER_ID = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
const BASE_URL = `http://localhost:3000/api/admin/environments/${AICE_ID}/customers`;

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

function makeDeleteRequest(customerId = CUSTOMER_ID): NextRequest {
  return new NextRequest(new URL(`${BASE_URL}/${customerId}`), {
    method: "DELETE",
  });
}

// ---------------------------------------------------------------------------
// Tests — GET /api/admin/environments/[aiceId]/customers
// ---------------------------------------------------------------------------

describe("GET /api/admin/environments/[aiceId]/customers", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAssertAuthorized.mockResolvedValue(new Set(["aice-environments:read"]));
    mockPoolQuery.mockResolvedValue({ rows: [] });
  });

  it("calls assertAuthorized with aice-environments:read", async () => {
    const { GET } = await import("../[aiceId]/customers/route");
    await GET(makeGetRequest());

    expect(mockAssertAuthorized).toHaveBeenCalledWith(
      expect.anything(),
      "admin",
      SELF_ACCOUNT_ID,
      "aice-environments:read",
    );
  });

  it("returns 403 when assertAuthorized rejects", async () => {
    const { HttpError } = await import("@/lib/auth/errors");
    mockAssertAuthorized.mockRejectedValue(new HttpError("Forbidden", 403));

    const { GET } = await import("../[aiceId]/customers/route");
    const res = await GET(makeGetRequest());

    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error).toBe("Forbidden");
  });

  it("releases pool connection even when authorization fails", async () => {
    mockAssertAuthorized.mockRejectedValue(new Error("connection error"));

    const { GET } = await import("../[aiceId]/customers/route");
    await GET(makeGetRequest()).catch(() => {});

    const client = mockConnect.mock.results[0].value;
    expect(client.release).toHaveBeenCalled();
  });

  it("returns empty customers array when none linked", async () => {
    const { GET } = await import("../[aiceId]/customers/route");
    const res = await GET(makeGetRequest());
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.customers).toEqual([]);
  });

  it("returns mapped camelCase customer data", async () => {
    mockPoolQuery.mockResolvedValue({
      rows: [
        {
          customer_id: CUSTOMER_ID,
          customer_name: "Acme Corp",
          external_key: "acme-001",
          created_at: "2026-01-01T00:00:00.000Z",
        },
      ],
    });

    const { GET } = await import("../[aiceId]/customers/route");
    const res = await GET(makeGetRequest());
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.customers).toHaveLength(1);
    expect(body.customers[0]).toEqual({
      customerId: CUSTOMER_ID,
      customerName: "Acme Corp",
      externalKey: "acme-001",
      createdAt: "2026-01-01T00:00:00.000Z",
    });
  });

  it("queries with correct aiceId from URL path", async () => {
    const { GET } = await import("../[aiceId]/customers/route");
    await GET(makeGetRequest());

    const [sql, params] = mockPoolQuery.mock.calls[0];
    expect(sql).toContain("WHERE ec.aice_id = $1");
    expect(params).toEqual([AICE_ID]);
  });
});

// ---------------------------------------------------------------------------
// Tests — POST /api/admin/environments/[aiceId]/customers
// ---------------------------------------------------------------------------

describe("POST /api/admin/environments/[aiceId]/customers", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAssertAuthorized.mockResolvedValue(
      new Set(["aice-environments:write"]),
    );
    // Default: environment exists, customer exists, insert succeeds
    mockPoolQuery
      .mockResolvedValueOnce({ rows: [{ "?column?": 1 }] }) // env check
      .mockResolvedValueOnce({ rows: [{ "?column?": 1 }] }) // cust check
      .mockResolvedValueOnce({ rows: [] }); // insert
  });

  it("calls assertAuthorized with aice-environments:write", async () => {
    const { POST } = await import("../[aiceId]/customers/route");
    await POST(makePostRequest({ customerId: CUSTOMER_ID }));

    expect(mockAssertAuthorized).toHaveBeenCalledWith(
      expect.anything(),
      "admin",
      SELF_ACCOUNT_ID,
      "aice-environments:write",
    );
  });

  it("returns 403 when assertAuthorized rejects", async () => {
    const { HttpError } = await import("@/lib/auth/errors");
    mockAssertAuthorized.mockRejectedValue(new HttpError("Forbidden", 403));

    const { POST } = await import("../[aiceId]/customers/route");
    const res = await POST(makePostRequest({ customerId: CUSTOMER_ID }));

    expect(res.status).toBe(403);
  });

  it("returns 400 for invalid JSON body", async () => {
    const { POST } = await import("../[aiceId]/customers/route");
    const req = new NextRequest(new URL(BASE_URL), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "not json{",
    });
    const res = await POST(req);

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe("Invalid JSON");
  });

  it("returns 400 for non-object body", async () => {
    const { POST } = await import("../[aiceId]/customers/route");
    const res = await POST(makePostRequest("just a string"));

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe("Request body must be a JSON object");
  });

  it("returns 400 when customerId is missing", async () => {
    const { POST } = await import("../[aiceId]/customers/route");
    const res = await POST(makePostRequest({}));

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toContain("customerId");
  });

  it("returns 400 when customerId is not a valid UUID", async () => {
    const { POST } = await import("../[aiceId]/customers/route");
    const res = await POST(makePostRequest({ customerId: "not-a-uuid" }));

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toContain("UUID");
  });

  it("returns 404 when environment does not exist", async () => {
    mockPoolQuery.mockReset();
    mockPoolQuery.mockResolvedValueOnce({ rows: [] }); // env check: not found

    const { POST } = await import("../[aiceId]/customers/route");
    const res = await POST(makePostRequest({ customerId: CUSTOMER_ID }));

    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error).toBe("Environment not found");
  });

  it("returns 404 when customer does not exist", async () => {
    mockPoolQuery.mockReset();
    mockPoolQuery
      .mockResolvedValueOnce({ rows: [{ "?column?": 1 }] }) // env exists
      .mockResolvedValueOnce({ rows: [] }); // cust not found

    const { POST } = await import("../[aiceId]/customers/route");
    const res = await POST(makePostRequest({ customerId: CUSTOMER_ID }));

    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error).toBe("Customer not found");
  });

  it("returns 201 on successful link", async () => {
    const { POST } = await import("../[aiceId]/customers/route");
    const res = await POST(makePostRequest({ customerId: CUSTOMER_ID }));

    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body).toEqual({ aiceId: AICE_ID, customerId: CUSTOMER_ID });
  });

  it("returns 409 when customer is already linked", async () => {
    mockPoolQuery.mockReset();
    mockPoolQuery
      .mockResolvedValueOnce({ rows: [{ "?column?": 1 }] }) // env exists
      .mockResolvedValueOnce({ rows: [{ "?column?": 1 }] }) // cust exists
      .mockRejectedValueOnce({ code: "23505" }); // unique violation

    const { POST } = await import("../[aiceId]/customers/route");
    const res = await POST(makePostRequest({ customerId: CUSTOMER_ID }));

    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error).toContain("already linked");
  });
});

// ---------------------------------------------------------------------------
// Tests — DELETE /api/admin/environments/[aiceId]/customers/[customerId]
// ---------------------------------------------------------------------------

describe("DELETE /api/admin/environments/[aiceId]/customers/[customerId]", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAssertAuthorized.mockResolvedValue(
      new Set(["aice-environments:write"]),
    );
    mockPoolQuery.mockResolvedValue({ rows: [{ aice_id: AICE_ID }] });
  });

  it("calls assertAuthorized with aice-environments:write", async () => {
    const { DELETE } = await import("../[aiceId]/customers/[customerId]/route");
    await DELETE(makeDeleteRequest());

    expect(mockAssertAuthorized).toHaveBeenCalledWith(
      expect.anything(),
      "admin",
      SELF_ACCOUNT_ID,
      "aice-environments:write",
    );
  });

  it("returns 403 when assertAuthorized rejects", async () => {
    const { HttpError } = await import("@/lib/auth/errors");
    mockAssertAuthorized.mockRejectedValue(new HttpError("Forbidden", 403));

    const { DELETE } = await import("../[aiceId]/customers/[customerId]/route");
    const res = await DELETE(makeDeleteRequest());

    expect(res.status).toBe(403);
  });

  it("returns 400 when customerId is not a valid UUID", async () => {
    const { DELETE } = await import("../[aiceId]/customers/[customerId]/route");
    const res = await DELETE(makeDeleteRequest("not-a-uuid"));

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe("Invalid parameters");
  });

  it("returns 204 on successful unlink", async () => {
    const { DELETE } = await import("../[aiceId]/customers/[customerId]/route");
    const res = await DELETE(makeDeleteRequest());

    expect(res.status).toBe(204);
  });

  it("returns 404 when mapping does not exist", async () => {
    mockPoolQuery.mockResolvedValue({ rows: [] });

    const { DELETE } = await import("../[aiceId]/customers/[customerId]/route");
    const res = await DELETE(makeDeleteRequest());

    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error).toBe("Mapping not found");
  });

  it("deletes with correct aiceId and customerId parameters", async () => {
    const { DELETE } = await import("../[aiceId]/customers/[customerId]/route");
    await DELETE(makeDeleteRequest());

    const [sql, params] = mockPoolQuery.mock.calls[0];
    expect(sql).toContain("DELETE FROM aice_environment_customers");
    expect(params).toEqual([AICE_ID, CUSTOMER_ID]);
  });
});
