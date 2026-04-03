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
const mockTxQuery = vi.fn();

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

const mockAuditLog = vi.fn();
vi.mock("@/lib/audit", () => ({
  auditLog: (...args: unknown[]) => mockAuditLog(...args),
}));

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

const BASE_URL = "http://localhost:3000/api/admin/environments";

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

const AICE_ID = "test-env-01";

function makePatchRequest(body: unknown, aiceId = AICE_ID): NextRequest {
  return new NextRequest(new URL(`${BASE_URL}/${aiceId}`), {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

function makeDeleteRequest(aiceId = AICE_ID): NextRequest {
  return new NextRequest(new URL(`${BASE_URL}/${aiceId}`), {
    method: "DELETE",
  });
}

function makeSampleEnvRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 1,
    aice_id: AICE_ID,
    name: "Test Environment",
    description: null,
    status: "active",
    created_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-01T00:00:00.000Z",
    customer_count: "2",
    key_count: "1",
    ...overrides,
  };
}

const VALID_POST_BODY = {
  aiceId: AICE_ID,
  name: "Test Environment",
  description: "A test env",
  status: "active",
};

// ---------------------------------------------------------------------------
// Tests — GET /api/admin/environments
// ---------------------------------------------------------------------------

describe("GET /api/admin/environments", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAssertAuthorized.mockResolvedValue(new Set(["aice-environments:read"]));
    mockPoolQuery.mockResolvedValue({ rows: [] });
  });

  it("calls assertAuthorized with aice-environments:read", async () => {
    const { GET } = await import("../route");
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

  it("returns empty environments array when none exist", async () => {
    const { GET } = await import("../route");
    const res = await GET(makeGetRequest());
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.environments).toEqual([]);
  });

  it("returns mapped camelCase environments with counts", async () => {
    const row = makeSampleEnvRow();
    mockPoolQuery.mockResolvedValue({ rows: [row] });

    const { GET } = await import("../route");
    const res = await GET(makeGetRequest());
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.environments).toHaveLength(1);
    expect(body.environments[0]).toEqual({
      id: row.id,
      aiceId: row.aice_id,
      name: row.name,
      description: row.description,
      status: row.status,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      customerCount: 2,
      keyCount: 1,
    });
  });

  it("orders by created_at", async () => {
    const { GET } = await import("../route");
    await GET(makeGetRequest());

    const sql = mockPoolQuery.mock.calls[0][0] as string;
    expect(sql).toContain("ORDER BY e.created_at");
  });
});

// ---------------------------------------------------------------------------
// Tests — POST /api/admin/environments
// ---------------------------------------------------------------------------

describe("POST /api/admin/environments", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAssertAuthorized.mockResolvedValue(
      new Set(["aice-environments:write"]),
    );
    mockTxQuery.mockResolvedValue({
      rows: [
        {
          id: 1,
          aice_id: AICE_ID,
          name: "Test Environment",
          description: "A test env",
          status: "active",
        },
      ],
    });
  });

  it("calls assertAuthorized with aice-environments:write", async () => {
    const { POST } = await import("../route");
    await POST(makePostRequest(VALID_POST_BODY));

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

    const { POST } = await import("../route");
    const res = await POST(makePostRequest(VALID_POST_BODY));

    expect(res.status).toBe(403);
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
    const body = await res.json();
    expect(body.error).toBe("Invalid JSON");
  });

  it("returns 400 for non-object body", async () => {
    const { POST } = await import("../route");
    const res = await POST(makePostRequest("just a string"));

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe("Request body must be a JSON object");
  });

  it("returns 400 when aiceId is missing", async () => {
    const { POST } = await import("../route");
    const res = await POST(makePostRequest({ name: "Env" }));

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toContain("aiceId");
  });

  it("returns 400 when name is missing", async () => {
    const { POST } = await import("../route");
    const res = await POST(makePostRequest({ aiceId: AICE_ID }));

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toContain("name");
  });

  it("returns 400 for invalid aiceId format", async () => {
    const { POST } = await import("../route");
    const res = await POST(
      makePostRequest({ ...VALID_POST_BODY, aiceId: "has spaces!" }),
    );

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toContain("alphanumeric");
  });

  it("returns 400 for invalid status value", async () => {
    const { POST } = await import("../route");
    const res = await POST(
      makePostRequest({ ...VALID_POST_BODY, status: "deleted" }),
    );

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toContain("status must be");
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

  it("returns 201 with environment data on success", async () => {
    const { POST } = await import("../route");
    const res = await POST(makePostRequest(VALID_POST_BODY));

    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.aiceId).toBe(AICE_ID);
    expect(body.name).toBe("Test Environment");
    expect(body.trustRegistryKey).toBeNull();
  });

  it("returns 409 on duplicate aice_id", async () => {
    mockTxQuery.mockRejectedValue({
      code: "23505",
      constraint: "aice_environments_aice_id_key",
    });

    const { POST } = await import("../route");
    const res = await POST(makePostRequest(VALID_POST_BODY));

    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error).toBe("aice_id_conflict");
  });

  it("creates environment with trust registry key in one transaction", async () => {
    // First call: INSERT environment, second: INSERT trust_registry key
    mockTxQuery
      .mockResolvedValueOnce({
        rows: [
          {
            id: 1,
            aice_id: AICE_ID,
            name: "Test",
            description: null,
            status: "active",
          },
        ],
      })
      .mockResolvedValueOnce({
        rows: [{ id: 10, issuer: "https://issuer.example", kid: "key-1" }],
      });

    const { POST } = await import("../route");
    const res = await POST(
      makePostRequest({
        ...VALID_POST_BODY,
        trustRegistryKey: {
          issuer: "https://issuer.example",
          kid: "key-1",
          publicKey: { kty: "RSA", n: "abc", e: "AQAB" },
        },
      }),
    );

    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.trustRegistryKey).toEqual({
      id: 10,
      issuer: "https://issuer.example",
      kid: "key-1",
    });
    expect(mockTxQuery).toHaveBeenCalledTimes(2);
  });

  it("returns 400 when trustRegistryKey is missing required fields", async () => {
    const { POST } = await import("../route");
    const res = await POST(
      makePostRequest({
        ...VALID_POST_BODY,
        trustRegistryKey: { issuer: "", kid: "k" },
      }),
    );

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toContain("issuer");
  });

  it("returns 400 when trustRegistryKey.publicKey is not an object", async () => {
    const { POST } = await import("../route");
    const res = await POST(
      makePostRequest({
        ...VALID_POST_BODY,
        trustRegistryKey: {
          issuer: "iss",
          kid: "k",
          publicKey: "not-an-object",
        },
      }),
    );

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toContain("JWK object");
  });

  it("checks trust-registry:write when trustRegistryKey is present", async () => {
    mockTxQuery
      .mockResolvedValueOnce({
        rows: [
          {
            id: 1,
            aice_id: AICE_ID,
            name: "Test",
            description: null,
            status: "active",
          },
        ],
      })
      .mockResolvedValueOnce({
        rows: [{ id: 10, issuer: "https://issuer.example", kid: "key-1" }],
      });

    const { POST } = await import("../route");
    await POST(
      makePostRequest({
        ...VALID_POST_BODY,
        trustRegistryKey: {
          issuer: "https://issuer.example",
          kid: "key-1",
          publicKey: { kty: "RSA", n: "abc", e: "AQAB" },
        },
      }),
    );

    expect(mockAssertAuthorized).toHaveBeenCalledTimes(2);
    expect(mockAssertAuthorized).toHaveBeenCalledWith(
      expect.anything(),
      "admin",
      SELF_ACCOUNT_ID,
      "trust-registry:write",
    );
  });

  it("returns 403 when trust-registry:write is missing for combined registration", async () => {
    const { HttpError } = await import("@/lib/auth/errors");
    mockAssertAuthorized
      .mockResolvedValueOnce(new Set(["aice-environments:write"]))
      .mockRejectedValueOnce(new HttpError("Forbidden", 403));

    const { POST } = await import("../route");
    const res = await POST(
      makePostRequest({
        ...VALID_POST_BODY,
        trustRegistryKey: {
          issuer: "https://issuer.example",
          kid: "key-1",
          publicKey: { kty: "RSA", n: "abc", e: "AQAB" },
        },
      }),
    );

    expect(res.status).toBe(403);
    expect(mockTxQuery).not.toHaveBeenCalled();
  });

  it("does not check trust-registry:write when trustRegistryKey is absent", async () => {
    const { POST } = await import("../route");
    await POST(makePostRequest(VALID_POST_BODY));

    expect(mockAssertAuthorized).toHaveBeenCalledTimes(1);
    expect(mockAssertAuthorized).toHaveBeenCalledWith(
      expect.anything(),
      "admin",
      SELF_ACCOUNT_ID,
      "aice-environments:write",
    );
  });

  it("emits trust_registry.key_registered audit event for combined registration", async () => {
    mockTxQuery
      .mockResolvedValueOnce({
        rows: [
          {
            id: 1,
            aice_id: AICE_ID,
            name: "Test",
            description: null,
            status: "active",
          },
        ],
      })
      .mockResolvedValueOnce({
        rows: [{ id: 10, issuer: "https://issuer.example", kid: "key-1" }],
      });

    const { POST } = await import("../route");
    const res = await POST(
      makePostRequest({
        ...VALID_POST_BODY,
        trustRegistryKey: {
          issuer: "https://issuer.example",
          kid: "key-1",
          publicKey: { kty: "RSA", n: "abc", e: "AQAB" },
        },
      }),
    );

    expect(res.status).toBe(201);
    expect(mockAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "trust_registry.key_registered",
        targetType: "trust_registry",
        targetId: "10",
        details: expect.objectContaining({
          aiceId: AICE_ID,
          issuer: "https://issuer.example",
          kid: "key-1",
        }),
      }),
    );
  });

  it("does not emit trust_registry audit event without trustRegistryKey", async () => {
    const { POST } = await import("../route");
    await POST(makePostRequest(VALID_POST_BODY));

    expect(mockAuditLog).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Tests — PATCH /api/admin/environments/[aiceId]
// ---------------------------------------------------------------------------

describe("PATCH /api/admin/environments/[aiceId]", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAssertAuthorized.mockResolvedValue(
      new Set(["aice-environments:write"]),
    );
    mockPoolQuery.mockResolvedValue({
      rows: [
        {
          id: 1,
          aice_id: AICE_ID,
          name: "Updated",
          description: null,
          status: "active",
          updated_at: "2026-01-02T00:00:00.000Z",
        },
      ],
    });
  });

  it("calls assertAuthorized with aice-environments:write", async () => {
    const { PATCH } = await import("../[aiceId]/route");
    await PATCH(makePatchRequest({ name: "New Name" }));

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

    const { PATCH } = await import("../[aiceId]/route");
    const res = await PATCH(makePatchRequest({ name: "New Name" }));

    expect(res.status).toBe(403);
  });

  it("returns 400 for invalid JSON body", async () => {
    const { PATCH } = await import("../[aiceId]/route");
    const req = new NextRequest(new URL(`${BASE_URL}/${AICE_ID}`), {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: "not json{",
    });
    const res = await PATCH(req);

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe("Invalid JSON");
  });

  it("returns 400 for non-object body", async () => {
    const { PATCH } = await import("../[aiceId]/route");
    const res = await PATCH(makePatchRequest("just a string"));

    expect(res.status).toBe(400);
  });

  it("returns 400 when no fields to update", async () => {
    const { PATCH } = await import("../[aiceId]/route");
    const res = await PATCH(makePatchRequest({}));

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe("No fields to update");
  });

  it("returns 400 for empty name", async () => {
    const { PATCH } = await import("../[aiceId]/route");
    const res = await PATCH(makePatchRequest({ name: "  " }));

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toContain("name");
  });

  it("returns 400 for invalid status", async () => {
    const { PATCH } = await import("../[aiceId]/route");
    const res = await PATCH(makePatchRequest({ status: "deleted" }));

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toContain("status must be");
  });

  it("returns 200 with updated environment", async () => {
    const { PATCH } = await import("../[aiceId]/route");
    const res = await PATCH(
      makePatchRequest({ name: "Updated", status: "suspended" }),
    );

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.aiceId).toBe(AICE_ID);
    expect(body.name).toBe("Updated");
  });

  it("returns 404 when environment does not exist", async () => {
    mockPoolQuery.mockResolvedValue({ rows: [] });

    const { PATCH } = await import("../[aiceId]/route");
    const res = await PATCH(makePatchRequest({ name: "Updated" }));

    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error).toBe("Environment not found");
  });
});

// ---------------------------------------------------------------------------
// Tests — DELETE /api/admin/environments/[aiceId]
// ---------------------------------------------------------------------------

describe("DELETE /api/admin/environments/[aiceId]", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAssertAuthorized.mockResolvedValue(
      new Set(["aice-environments:write"]),
    );
    // Default: environment found and deleted
    mockTxQuery.mockResolvedValue({ rows: [{ aice_id: AICE_ID }] });
  });

  it("calls assertAuthorized with aice-environments:write", async () => {
    const { DELETE } = await import("../[aiceId]/route");
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

    const { DELETE } = await import("../[aiceId]/route");
    const res = await DELETE(makeDeleteRequest());

    expect(res.status).toBe(403);
  });

  it("returns 204 on successful deletion", async () => {
    const { DELETE } = await import("../[aiceId]/route");
    const res = await DELETE(makeDeleteRequest());

    expect(res.status).toBe(204);
  });

  it("deletes trust registry keys before environment", async () => {
    const { DELETE } = await import("../[aiceId]/route");
    await DELETE(makeDeleteRequest());

    expect(mockTxQuery).toHaveBeenCalledTimes(2);
    const firstSql = mockTxQuery.mock.calls[0][0] as string;
    expect(firstSql).toContain("DELETE FROM trust_registry");
    const secondSql = mockTxQuery.mock.calls[1][0] as string;
    expect(secondSql).toContain("DELETE FROM aice_environments");
  });

  it("returns 404 when environment does not exist", async () => {
    mockTxQuery
      .mockResolvedValueOnce({ rows: [] }) // trust_registry delete
      .mockResolvedValueOnce({ rows: [] }); // environment delete

    const { DELETE } = await import("../[aiceId]/route");
    const res = await DELETE(makeDeleteRequest());

    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error).toBe("Environment not found");
  });
});
