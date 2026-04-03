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
const KEY_ID = "42";
const BASE_URL = `http://localhost:3000/api/admin/environments/${AICE_ID}/trust-registry`;

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

function makePatchRequest(body: unknown, keyId = KEY_ID): NextRequest {
  return new NextRequest(new URL(`${BASE_URL}/${keyId}`), {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

function makeDeleteRequest(keyId = KEY_ID): NextRequest {
  return new NextRequest(new URL(`${BASE_URL}/${keyId}`), {
    method: "DELETE",
  });
}

const VALID_POST_BODY = {
  issuer: "https://issuer.example",
  kid: "key-1",
  publicKey: { kty: "RSA", n: "abc", e: "AQAB" },
};

// ---------------------------------------------------------------------------
// Tests — GET /api/admin/environments/[aiceId]/trust-registry
// ---------------------------------------------------------------------------

describe("GET /api/admin/environments/[aiceId]/trust-registry", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAssertAuthorized.mockResolvedValue(new Set(["trust-registry:read"]));
    mockPoolQuery.mockResolvedValue({ rows: [] });
  });

  it("calls assertAuthorized with trust-registry:read", async () => {
    const { GET } = await import("../[aiceId]/trust-registry/route");
    await GET(makeGetRequest());

    expect(mockAssertAuthorized).toHaveBeenCalledWith(
      expect.anything(),
      "admin",
      SELF_ACCOUNT_ID,
      "trust-registry:read",
    );
  });

  it("returns 403 when assertAuthorized rejects", async () => {
    const { HttpError } = await import("@/lib/auth/errors");
    mockAssertAuthorized.mockRejectedValue(new HttpError("Forbidden", 403));

    const { GET } = await import("../[aiceId]/trust-registry/route");
    const res = await GET(makeGetRequest());

    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error).toBe("Forbidden");
  });

  it("releases pool connection even when authorization fails", async () => {
    mockAssertAuthorized.mockRejectedValue(new Error("connection error"));

    const { GET } = await import("../[aiceId]/trust-registry/route");
    await GET(makeGetRequest()).catch(() => {});

    const client = mockConnect.mock.results[0].value;
    expect(client.release).toHaveBeenCalled();
  });

  it("returns empty keys array when none exist", async () => {
    const { GET } = await import("../[aiceId]/trust-registry/route");
    const res = await GET(makeGetRequest());
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.keys).toEqual([]);
  });

  it("returns mapped camelCase key data", async () => {
    mockPoolQuery.mockResolvedValue({
      rows: [
        {
          id: 42,
          aice_id: AICE_ID,
          issuer: "https://issuer.example",
          kid: "key-1",
          public_key: { kty: "RSA" },
          description: "Test key",
          enabled: true,
          created_at: "2026-01-01T00:00:00.000Z",
          updated_at: "2026-01-01T00:00:00.000Z",
        },
      ],
    });

    const { GET } = await import("../[aiceId]/trust-registry/route");
    const res = await GET(makeGetRequest());
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.keys).toHaveLength(1);
    expect(body.keys[0]).toEqual({
      id: 42,
      aiceId: AICE_ID,
      issuer: "https://issuer.example",
      kid: "key-1",
      publicKey: { kty: "RSA" },
      description: "Test key",
      enabled: true,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    });
  });

  it("queries with correct aiceId from URL path", async () => {
    const { GET } = await import("../[aiceId]/trust-registry/route");
    await GET(makeGetRequest());

    const [sql, params] = mockPoolQuery.mock.calls[0];
    expect(sql).toContain("WHERE aice_id = $1");
    expect(params).toEqual([AICE_ID]);
  });
});

// ---------------------------------------------------------------------------
// Tests — POST /api/admin/environments/[aiceId]/trust-registry
// ---------------------------------------------------------------------------

describe("POST /api/admin/environments/[aiceId]/trust-registry", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAssertAuthorized.mockResolvedValue(new Set(["trust-registry:write"]));
    // Default: environment exists, key insert succeeds
    mockPoolQuery
      .mockResolvedValueOnce({ rows: [{ "?column?": 1 }] }) // env check
      .mockResolvedValueOnce({
        rows: [
          {
            id: 10,
            issuer: "https://issuer.example",
            kid: "key-1",
            enabled: true,
          },
        ],
      });
  });

  it("calls assertAuthorized with trust-registry:write", async () => {
    const { POST } = await import("../[aiceId]/trust-registry/route");
    await POST(makePostRequest(VALID_POST_BODY));

    expect(mockAssertAuthorized).toHaveBeenCalledWith(
      expect.anything(),
      "admin",
      SELF_ACCOUNT_ID,
      "trust-registry:write",
    );
  });

  it("returns 403 when assertAuthorized rejects", async () => {
    const { HttpError } = await import("@/lib/auth/errors");
    mockAssertAuthorized.mockRejectedValue(new HttpError("Forbidden", 403));

    const { POST } = await import("../[aiceId]/trust-registry/route");
    const res = await POST(makePostRequest(VALID_POST_BODY));

    expect(res.status).toBe(403);
  });

  it("returns 400 for invalid JSON body", async () => {
    // Need env check to pass before JSON parsing — reset mocks
    mockPoolQuery.mockReset();
    mockPoolQuery.mockResolvedValueOnce({ rows: [{ "?column?": 1 }] });

    const { POST } = await import("../[aiceId]/trust-registry/route");
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
    mockPoolQuery.mockReset();
    mockPoolQuery.mockResolvedValueOnce({ rows: [{ "?column?": 1 }] });

    const { POST } = await import("../[aiceId]/trust-registry/route");
    const res = await POST(makePostRequest("just a string"));

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe("Request body must be a JSON object");
  });

  it("returns 400 when issuer is missing", async () => {
    mockPoolQuery.mockReset();
    mockPoolQuery.mockResolvedValueOnce({ rows: [{ "?column?": 1 }] });

    const { POST } = await import("../[aiceId]/trust-registry/route");
    const res = await POST(
      makePostRequest({ kid: "k", publicKey: { kty: "RSA" } }),
    );

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toContain("issuer");
  });

  it("returns 400 when kid is empty", async () => {
    mockPoolQuery.mockReset();
    mockPoolQuery.mockResolvedValueOnce({ rows: [{ "?column?": 1 }] });

    const { POST } = await import("../[aiceId]/trust-registry/route");
    const res = await POST(
      makePostRequest({
        issuer: "https://iss",
        kid: "  ",
        publicKey: { kty: "RSA" },
      }),
    );

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toContain("issuer and kid");
  });

  it("returns 400 when publicKey is not an object", async () => {
    mockPoolQuery.mockReset();
    mockPoolQuery.mockResolvedValueOnce({ rows: [{ "?column?": 1 }] });

    const { POST } = await import("../[aiceId]/trust-registry/route");
    const res = await POST(
      makePostRequest({
        issuer: "https://iss",
        kid: "k",
        publicKey: "not-an-object",
      }),
    );

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toContain("JWK object");
  });

  it("returns 400 when publicKey is an array", async () => {
    mockPoolQuery.mockReset();
    mockPoolQuery.mockResolvedValueOnce({ rows: [{ "?column?": 1 }] });

    const { POST } = await import("../[aiceId]/trust-registry/route");
    const res = await POST(
      makePostRequest({
        issuer: "https://iss",
        kid: "k",
        publicKey: [1, 2, 3],
      }),
    );

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toContain("JWK object");
  });

  it("returns 400 when description is not a string", async () => {
    mockPoolQuery.mockReset();
    mockPoolQuery.mockResolvedValueOnce({ rows: [{ "?column?": 1 }] });

    const { POST } = await import("../[aiceId]/trust-registry/route");
    const res = await POST(
      makePostRequest({ ...VALID_POST_BODY, description: 123 }),
    );

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toContain("description must be a string");
  });

  it("returns 404 when environment does not exist", async () => {
    mockPoolQuery.mockReset();
    mockPoolQuery.mockResolvedValueOnce({ rows: [] }); // env not found

    const { POST } = await import("../[aiceId]/trust-registry/route");
    const res = await POST(makePostRequest(VALID_POST_BODY));

    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error).toBe("Environment not found");
  });

  it("returns 201 with key data on success", async () => {
    const { POST } = await import("../[aiceId]/trust-registry/route");
    const res = await POST(makePostRequest(VALID_POST_BODY));

    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body).toEqual({
      id: 10,
      aiceId: AICE_ID,
      issuer: "https://issuer.example",
      kid: "key-1",
      enabled: true,
    });
  });

  it("returns 409 on duplicate issuer+kid", async () => {
    mockPoolQuery.mockReset();
    mockPoolQuery
      .mockResolvedValueOnce({ rows: [{ "?column?": 1 }] }) // env exists
      .mockRejectedValueOnce({
        code: "23505",
        constraint: "trust_registry_aice_id_issuer_kid_key",
      });

    const { POST } = await import("../[aiceId]/trust-registry/route");
    const res = await POST(makePostRequest(VALID_POST_BODY));

    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error).toContain("already exists");
  });
});

// ---------------------------------------------------------------------------
// Tests — PATCH /api/admin/environments/[aiceId]/trust-registry/[keyId]
// ---------------------------------------------------------------------------

describe("PATCH /api/admin/environments/[aiceId]/trust-registry/[keyId]", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAssertAuthorized.mockResolvedValue(new Set(["trust-registry:write"]));
    mockPoolQuery.mockResolvedValue({
      rows: [{ id: 42, enabled: false, description: null }],
    });
  });

  it("calls assertAuthorized with trust-registry:write", async () => {
    const { PATCH } = await import("../[aiceId]/trust-registry/[keyId]/route");
    await PATCH(makePatchRequest({ enabled: false }));

    expect(mockAssertAuthorized).toHaveBeenCalledWith(
      expect.anything(),
      "admin",
      SELF_ACCOUNT_ID,
      "trust-registry:write",
    );
  });

  it("returns 403 when assertAuthorized rejects", async () => {
    const { HttpError } = await import("@/lib/auth/errors");
    mockAssertAuthorized.mockRejectedValue(new HttpError("Forbidden", 403));

    const { PATCH } = await import("../[aiceId]/trust-registry/[keyId]/route");
    const res = await PATCH(makePatchRequest({ enabled: false }));

    expect(res.status).toBe(403);
  });

  it("returns 400 for invalid keyId (non-numeric)", async () => {
    const { PATCH } = await import("../[aiceId]/trust-registry/[keyId]/route");
    const res = await PATCH(makePatchRequest({ enabled: false }, "abc"));

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe("Invalid parameters");
  });

  it("returns 400 for invalid JSON body", async () => {
    const { PATCH } = await import("../[aiceId]/trust-registry/[keyId]/route");
    const req = new NextRequest(new URL(`${BASE_URL}/${KEY_ID}`), {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: "not json{",
    });
    const res = await PATCH(req);

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe("Invalid JSON");
  });

  it("returns 400 when no fields to update", async () => {
    const { PATCH } = await import("../[aiceId]/trust-registry/[keyId]/route");
    const res = await PATCH(makePatchRequest({}));

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe("No fields to update");
  });

  it("returns 400 when enabled is not a boolean", async () => {
    const { PATCH } = await import("../[aiceId]/trust-registry/[keyId]/route");
    const res = await PATCH(makePatchRequest({ enabled: "yes" }));

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toContain("enabled must be a boolean");
  });

  it("returns 400 when description is not a string or null", async () => {
    const { PATCH } = await import("../[aiceId]/trust-registry/[keyId]/route");
    const res = await PATCH(makePatchRequest({ description: 123 }));

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toContain("description must be a string or null");
  });

  it("returns 200 with updated key data", async () => {
    const { PATCH } = await import("../[aiceId]/trust-registry/[keyId]/route");
    const res = await PATCH(makePatchRequest({ enabled: false }));

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ id: 42, enabled: false, description: null });
  });

  it("returns 404 when key does not exist", async () => {
    mockPoolQuery.mockResolvedValue({ rows: [] });

    const { PATCH } = await import("../[aiceId]/trust-registry/[keyId]/route");
    const res = await PATCH(makePatchRequest({ enabled: true }));

    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error).toBe("Key not found");
  });

  it("includes both keyId and aiceId in WHERE clause", async () => {
    const { PATCH } = await import("../[aiceId]/trust-registry/[keyId]/route");
    await PATCH(makePatchRequest({ enabled: false }));

    const [sql, params] = mockPoolQuery.mock.calls[0];
    expect(sql).toContain("aice_id");
    expect(params).toContain(Number(KEY_ID));
    expect(params).toContain(AICE_ID);
  });

  it("accepts null description", async () => {
    const { PATCH } = await import("../[aiceId]/trust-registry/[keyId]/route");
    const res = await PATCH(makePatchRequest({ description: null }));

    expect(res.status).toBe(200);
  });
});

// ---------------------------------------------------------------------------
// Tests — DELETE /api/admin/environments/[aiceId]/trust-registry/[keyId]
// ---------------------------------------------------------------------------

describe("DELETE /api/admin/environments/[aiceId]/trust-registry/[keyId]", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAssertAuthorized.mockResolvedValue(new Set(["trust-registry:write"]));
    mockPoolQuery.mockResolvedValue({ rows: [{ id: 42 }] });
  });

  it("calls assertAuthorized with trust-registry:write", async () => {
    const { DELETE } = await import("../[aiceId]/trust-registry/[keyId]/route");
    await DELETE(makeDeleteRequest());

    expect(mockAssertAuthorized).toHaveBeenCalledWith(
      expect.anything(),
      "admin",
      SELF_ACCOUNT_ID,
      "trust-registry:write",
    );
  });

  it("returns 403 when assertAuthorized rejects", async () => {
    const { HttpError } = await import("@/lib/auth/errors");
    mockAssertAuthorized.mockRejectedValue(new HttpError("Forbidden", 403));

    const { DELETE } = await import("../[aiceId]/trust-registry/[keyId]/route");
    const res = await DELETE(makeDeleteRequest());

    expect(res.status).toBe(403);
  });

  it("returns 400 for invalid keyId (non-numeric)", async () => {
    const { DELETE } = await import("../[aiceId]/trust-registry/[keyId]/route");
    const res = await DELETE(makeDeleteRequest("abc"));

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe("Invalid parameters");
  });

  it("returns 204 on successful deletion", async () => {
    const { DELETE } = await import("../[aiceId]/trust-registry/[keyId]/route");
    const res = await DELETE(makeDeleteRequest());

    expect(res.status).toBe(204);
  });

  it("returns 404 when key does not exist", async () => {
    mockPoolQuery.mockResolvedValue({ rows: [] });

    const { DELETE } = await import("../[aiceId]/trust-registry/[keyId]/route");
    const res = await DELETE(makeDeleteRequest());

    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error).toBe("Key not found");
  });

  it("deletes with correct keyId and aiceId parameters", async () => {
    const { DELETE } = await import("../[aiceId]/trust-registry/[keyId]/route");
    await DELETE(makeDeleteRequest());

    const [sql, params] = mockPoolQuery.mock.calls[0];
    expect(sql).toContain("DELETE FROM trust_registry");
    expect(params).toEqual([Number(KEY_ID), AICE_ID]);
  });
});
