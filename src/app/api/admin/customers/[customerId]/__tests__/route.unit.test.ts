import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

const mockConnect = vi.fn(() => ({
  query: vi.fn(),
  release: vi.fn(),
}));
const mockAssertAuthorized = vi.fn();
const mockUpdateCustomer = vi.fn();
const mockDeleteCustomer = vi.fn();
const mockAuditMeta: {
  targetId?: string;
  details?: unknown;
  customerId?: string;
} = {};

const SELF_ACCOUNT_ID = "00000000-0000-0000-0000-000000000099";
const CUSTOMER_ID = "c0000000-0000-0000-0000-000000000001";

const mockWithAuth = vi.fn(
  // biome-ignore lint/complexity/noBannedTypes: test mock needs generic callable
  (handler: Function) => (req: NextRequest) => {
    mockAuditMeta.targetId = undefined;
    mockAuditMeta.details = undefined;
    mockAuditMeta.customerId = undefined;
    return handler(req, {
      accountId: SELF_ACCOUNT_ID,
      sessionId: "sess-1",
      authContext: "admin",
      tokenVersion: 1,
      iat: 1000,
      meta: { ipAddress: "127.0.0.1", userAgent: "test" },
      bridgeAiceId: null,
      bridgeCustomerIds: null,
      audit: mockAuditMeta,
    });
  },
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
  getAuthPool: vi.fn(() => ({ connect: mockConnect })),
  getMigrationAuditPool: vi.fn(() => ({})),
  withTransaction: vi.fn(
    (_pool: unknown, fn: (client: { query: typeof vi.fn }) => unknown) =>
      fn({ query: vi.fn() }),
  ),
}));

vi.mock("@/lib/auth/customers", async () => {
  const actual = await vi.importActual<typeof import("@/lib/auth/customers")>(
    "@/lib/auth/customers",
  );
  return {
    ...actual,
    updateCustomer: (...args: unknown[]) => mockUpdateCustomer(...args),
  };
});

vi.mock("@/lib/auth/delete-customer", () => ({
  deleteCustomer: (...args: unknown[]) => mockDeleteCustomer(...args),
}));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const URL_BASE = `http://localhost:3000/api/admin/customers/${CUSTOMER_ID}`;

function makePatchRequest(body: unknown, url: string = URL_BASE): NextRequest {
  return new NextRequest(new URL(url), {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

// ---------------------------------------------------------------------------
// Tests — PATCH /api/admin/customers/[customerId]
// ---------------------------------------------------------------------------

describe("PATCH /api/admin/customers/[customerId]", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAssertAuthorized.mockResolvedValue(new Set(["customers:write"]));
    mockUpdateCustomer.mockResolvedValue({
      id: CUSTOMER_ID,
      name: "Acme Corp",
      externalKey: "acme-002",
      description: "x",
      status: "active",
      databaseStatus: "active",
      changedFields: ["external_key"],
      previous: { external_key: "acme-001" },
      next: { external_key: "acme-002" },
    });
  });

  it("calls assertAuthorized with customers:write", async () => {
    const { PATCH } = await import("../route");
    await PATCH(makePatchRequest({ name: "x" }));

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

    const { PATCH } = await import("../route");
    const res = await PATCH(makePatchRequest({ name: "x" }));

    expect(res.status).toBe(403);
  });

  it("returns 400 for invalid customer ID", async () => {
    const { PATCH } = await import("../route");
    const res = await PATCH(
      makePatchRequest(
        { name: "x" },
        "http://localhost:3000/api/admin/customers/not-uuid",
      ),
    );

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe("Invalid customer ID");
  });

  it("returns 400 for invalid JSON body", async () => {
    const { PATCH } = await import("../route");
    const req = new NextRequest(new URL(URL_BASE), {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: "not json{",
    });
    const res = await PATCH(req);

    expect(res.status).toBe(400);
  });

  it("returns 400 when no fields provided", async () => {
    const { PATCH } = await import("../route");
    const res = await PATCH(makePatchRequest({}));

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe("no_fields_to_update");
  });

  it("returns 400 when externalKey is empty/whitespace", async () => {
    const { PATCH } = await import("../route");
    const res = await PATCH(makePatchRequest({ externalKey: "  " }));

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe("external_key_required");
  });

  it("returns 400 when externalKey exceeds 256 chars", async () => {
    const { PATCH } = await import("../route");
    const res = await PATCH(makePatchRequest({ externalKey: "x".repeat(257) }));

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe("external_key_too_long");
  });

  it("returns 400 when externalKey contains control characters", async () => {
    const { PATCH } = await import("../route");
    const res = await PATCH(makePatchRequest({ externalKey: "abcdef" }));

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe("external_key_invalid_characters");
  });

  it("returns 400 when name is empty", async () => {
    const { PATCH } = await import("../route");
    const res = await PATCH(makePatchRequest({ name: "  " }));

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe("name_required");
  });

  it("trims fields before passing to updateCustomer", async () => {
    const { PATCH } = await import("../route");
    await PATCH(
      makePatchRequest({ name: "  Acme  ", externalKey: "  acme-002  " }),
    );

    expect(mockUpdateCustomer).toHaveBeenCalledWith(
      expect.anything(),
      CUSTOMER_ID,
      expect.objectContaining({ name: "Acme", externalKey: "acme-002" }),
    );
  });

  it("returns 200 with updated customer on success", async () => {
    const { PATCH } = await import("../route");
    const res = await PATCH(makePatchRequest({ externalKey: "acme-002" }));

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({
      id: CUSTOMER_ID,
      externalKey: "acme-002",
      changedFields: ["external_key"],
    });
  });

  it("populates audit details with changedFields/previous/next on external_key change", async () => {
    const { PATCH } = await import("../route");
    await PATCH(makePatchRequest({ externalKey: "acme-002" }));

    expect(mockAuditMeta.targetId).toBe(CUSTOMER_ID);
    expect(mockAuditMeta.customerId).toBe(CUSTOMER_ID);
    expect(mockAuditMeta.details).toMatchObject({
      changedFields: ["external_key"],
      previous: { external_key: "acme-001" },
      next: { external_key: "acme-002" },
      customerId: CUSTOMER_ID,
      customerName: "Acme Corp",
    });
  });

  it("audit details for name-only change do not include external_key", async () => {
    mockUpdateCustomer.mockResolvedValue({
      id: CUSTOMER_ID,
      name: "Renamed",
      externalKey: "acme-001",
      description: null,
      status: "active",
      databaseStatus: "active",
      changedFields: ["name"],
      previous: { name: "Acme Corp" },
      next: { name: "Renamed" },
    });

    const { PATCH } = await import("../route");
    await PATCH(makePatchRequest({ name: "Renamed" }));

    const details = mockAuditMeta.details as {
      changedFields: string[];
      previous: Record<string, unknown>;
      next: Record<string, unknown>;
    };
    expect(details.changedFields).toEqual(["name"]);
    expect(details.previous).not.toHaveProperty("external_key");
    expect(details.next).not.toHaveProperty("external_key");
  });

  it("returns 409 on external_key conflict from updateCustomer", async () => {
    const { HttpError } = await import("@/lib/auth/errors");
    mockUpdateCustomer.mockRejectedValue(
      new HttpError("external_key_conflict", 409),
    );

    const { PATCH } = await import("../route");
    const res = await PATCH(makePatchRequest({ externalKey: "dup" }));

    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error).toBe("external_key_conflict");
  });

  it("returns 404 when customer not found", async () => {
    const { HttpError } = await import("@/lib/auth/errors");
    mockUpdateCustomer.mockRejectedValue(
      new HttpError("Customer not found", 404),
    );

    const { PATCH } = await import("../route");
    const res = await PATCH(makePatchRequest({ name: "x" }));

    expect(res.status).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// Tests — DELETE /api/admin/customers/[customerId]
// (sanity, since file exports both)
// ---------------------------------------------------------------------------

describe("DELETE /api/admin/customers/[customerId]", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockDeleteCustomer.mockResolvedValue(undefined);
  });

  it("returns 204 on success", async () => {
    const { DELETE } = await import("../route");
    const req = new NextRequest(new URL(URL_BASE), { method: "DELETE" });
    const res = await DELETE(req);

    expect(res.status).toBe(204);
  });

  it("returns 400 for invalid customer ID", async () => {
    const { DELETE } = await import("../route");
    const req = new NextRequest(
      new URL("http://localhost:3000/api/admin/customers/not-uuid"),
      { method: "DELETE" },
    );
    const res = await DELETE(req);

    expect(res.status).toBe(400);
  });
});
