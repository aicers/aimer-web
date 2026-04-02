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
const mockProvisionCustomerDb = vi.fn();
const mockCreateCustomer = vi.fn();
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
  withTransaction: vi.fn(
    (_pool: unknown, fn: (client: { query: typeof vi.fn }) => unknown) =>
      fn({ query: vi.fn() }),
  ),
}));

vi.mock("@/lib/auth/customers", () => ({
  createCustomer: (...args: unknown[]) => mockCreateCustomer(...args),
}));

vi.mock("@/lib/db/provision-customer", () => ({
  provisionCustomerDb: (...args: unknown[]) => mockProvisionCustomerDb(...args),
}));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const BASE_URL = "http://localhost:3000/api/admin/customers";

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

const VALID_POST_BODY = {
  name: "Test Corp",
  externalKey: "test-001",
  managerAccountId: "a0000000-0000-0000-0000-000000000001",
};

function makeSampleCustomerRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "c0000000-0000-0000-0000-000000000001",
    name: "Test Corp",
    external_key: "test-001",
    description: null,
    status: "active",
    database_status: "active",
    created_at: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests — GET /api/admin/customers
// ---------------------------------------------------------------------------

describe("GET /api/admin/customers", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAssertAuthorized.mockResolvedValue(new Set(["customers:read"]));
    mockPoolQuery.mockResolvedValue({ rows: [] });
  });

  it("calls assertAuthorized with customers:read", async () => {
    const { GET } = await import("../route");
    await GET(makeGetRequest());

    expect(mockAssertAuthorized).toHaveBeenCalledWith(
      expect.anything(),
      "admin",
      SELF_ACCOUNT_ID,
      "customers:read",
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

  it("releases pool connection even when authorization fails", async () => {
    mockAssertAuthorized.mockRejectedValue(new Error("connection error"));

    const { GET } = await import("../route");
    await GET(makeGetRequest()).catch(() => {});

    const client = mockConnect.mock.results[0].value;
    expect(client.release).toHaveBeenCalled();
  });

  it("returns empty customers array when no customers exist", async () => {
    const { GET } = await import("../route");
    const res = await GET(makeGetRequest());
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.customers).toEqual([]);
  });

  it("returns mapped camelCase customers", async () => {
    const row = makeSampleCustomerRow();
    mockPoolQuery.mockResolvedValue({ rows: [row] });

    const { GET } = await import("../route");
    const res = await GET(makeGetRequest());
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.customers).toHaveLength(1);
    expect(body.customers[0]).toEqual({
      id: row.id,
      name: row.name,
      externalKey: row.external_key,
      description: row.description,
      status: row.status,
      databaseStatus: row.database_status,
      createdAt: row.created_at,
    });
  });

  it("handles multiple customers with varying fields", async () => {
    const rows = [
      makeSampleCustomerRow({
        id: "c1",
        description: "First customer",
        database_status: "active",
      }),
      makeSampleCustomerRow({
        id: "c2",
        status: "suspended",
        database_status: "failed",
      }),
      makeSampleCustomerRow({
        id: "c3",
        database_status: "provisioning",
      }),
    ];
    mockPoolQuery.mockResolvedValue({ rows });

    const { GET } = await import("../route");
    const res = await GET(makeGetRequest());
    const body = await res.json();

    expect(body.customers).toHaveLength(3);
    expect(body.customers[0].description).toBe("First customer");
    expect(body.customers[1].status).toBe("suspended");
    expect(body.customers[1].databaseStatus).toBe("failed");
    expect(body.customers[2].databaseStatus).toBe("provisioning");
  });

  it("orders by created_at", async () => {
    const { GET } = await import("../route");
    await GET(makeGetRequest());

    const sql = mockPoolQuery.mock.calls[0][0] as string;
    expect(sql).toContain("ORDER BY created_at");
  });
});

// ---------------------------------------------------------------------------
// Tests — POST /api/admin/customers
// ---------------------------------------------------------------------------

describe("POST /api/admin/customers", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAssertAuthorized.mockResolvedValue(new Set(["customers:write"]));
    mockCreateCustomer.mockResolvedValue({
      id: "c0000000-0000-0000-0000-000000000001",
      name: "Test Corp",
      externalKey: "test-001",
      status: "active",
      databaseStatus: "provisioning",
    });
    mockProvisionCustomerDb.mockResolvedValue("active");
  });

  // =========================================================================
  // Authorization
  // =========================================================================

  it("calls assertAuthorized with customers:write", async () => {
    const { POST } = await import("../route");
    await POST(makePostRequest(VALID_POST_BODY));

    expect(mockAssertAuthorized).toHaveBeenCalledWith(
      expect.anything(),
      "admin",
      SELF_ACCOUNT_ID,
      "customers:write",
    );
  });

  it("returns 403 when assertAuthorized rejects", async () => {
    const { HttpError } = await import("@/lib/auth/errors");
    mockAssertAuthorized.mockRejectedValue(new HttpError("Forbidden", 403));

    const { POST } = await import("../route");
    const res = await POST(makePostRequest(VALID_POST_BODY));

    expect(res.status).toBe(403);
  });

  // =========================================================================
  // Input validation
  // =========================================================================

  it("returns 400 for invalid JSON body", async () => {
    const { POST } = await import("../route");
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
    const { POST } = await import("../route");
    const req = new NextRequest(new URL(BASE_URL), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify("just a string"),
    });
    const res = await POST(req);

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe("Request body must be a JSON object");
  });

  it("returns 400 for array body", async () => {
    const { POST } = await import("../route");
    const res = await POST(makePostRequest([]));

    expect(res.status).toBe(400);
  });

  it("returns 400 when name is missing", async () => {
    const { POST } = await import("../route");
    const res = await POST(
      makePostRequest({
        externalKey: "k",
        managerAccountId: VALID_POST_BODY.managerAccountId,
      }),
    );

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toContain("name");
  });

  it("returns 400 when externalKey is empty string", async () => {
    const { POST } = await import("../route");
    const res = await POST(
      makePostRequest({ ...VALID_POST_BODY, externalKey: "  " }),
    );

    expect(res.status).toBe(400);
  });

  // Discussion #9 item 35-10: Customer creation requires manager_account_id
  it("returns 400 when managerAccountId is missing", async () => {
    const { POST } = await import("../route");
    const res = await POST(makePostRequest({ name: "Test", externalKey: "k" }));

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe("manager_account_id_required");
  });

  it("returns 400 when managerAccountId is not a valid UUID", async () => {
    const { POST } = await import("../route");
    const res = await POST(
      makePostRequest({ ...VALID_POST_BODY, managerAccountId: "not-uuid" }),
    );

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toContain("Invalid managerAccountId");
  });

  it("returns 400 when description is not a string", async () => {
    const { POST } = await import("../route");
    const res = await POST(
      makePostRequest({ ...VALID_POST_BODY, description: 123 }),
    );

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toContain("description must be a string");
  });

  // =========================================================================
  // Success path
  // =========================================================================

  it("returns 201 with customer data on success", async () => {
    const { POST } = await import("../route");
    const res = await POST(makePostRequest(VALID_POST_BODY));

    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body).toEqual({
      id: "c0000000-0000-0000-0000-000000000001",
      name: "Test Corp",
      externalKey: "test-001",
      status: "active",
      databaseStatus: "active",
    });
  });

  it("calls createCustomer with correct params", async () => {
    const { POST } = await import("../route");
    await POST(makePostRequest(VALID_POST_BODY));

    expect(mockCreateCustomer).toHaveBeenCalledWith(expect.anything(), {
      name: "Test Corp",
      externalKey: "test-001",
      description: undefined,
      managerAccountId: "a0000000-0000-0000-0000-000000000001",
    });
  });

  it("passes description when provided", async () => {
    const { POST } = await import("../route");
    await POST(makePostRequest({ ...VALID_POST_BODY, description: "A test" }));

    expect(mockCreateCustomer).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ description: "A test" }),
    );
  });

  it("calls provisionCustomerDb after customer creation", async () => {
    const { POST } = await import("../route");
    await POST(makePostRequest(VALID_POST_BODY));

    expect(mockProvisionCustomerDb).toHaveBeenCalledWith(
      expect.anything(),
      "c0000000-0000-0000-0000-000000000001",
      expect.objectContaining({
        actorContext: expect.objectContaining({
          actorId: SELF_ACCOUNT_ID,
          authContext: "admin",
        }),
      }),
    );
  });

  // =========================================================================
  // Error handling
  // =========================================================================

  it("returns 409 on duplicate external_key", async () => {
    const { HttpError } = await import("@/lib/auth/errors");
    mockCreateCustomer.mockRejectedValue(
      new HttpError("external_key_conflict", 409),
    );

    const { POST } = await import("../route");
    const res = await POST(makePostRequest(VALID_POST_BODY));

    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error).toBe("external_key_conflict");
  });

  it("returns 404 when manager account not found", async () => {
    const { HttpError } = await import("@/lib/auth/errors");
    mockCreateCustomer.mockRejectedValue(
      new HttpError("Account not found", 404),
    );

    const { POST } = await import("../route");
    const res = await POST(makePostRequest(VALID_POST_BODY));

    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error).toBe("Account not found");
  });

  it("re-throws non-HttpError exceptions", async () => {
    mockCreateCustomer.mockRejectedValue(new Error("Unexpected DB error"));

    const { POST } = await import("../route");
    await expect(POST(makePostRequest(VALID_POST_BODY))).rejects.toThrow(
      "Unexpected DB error",
    );
  });
});
