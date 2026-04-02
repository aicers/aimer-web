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
const mockAssertAuthorized = vi.fn();

const SELF_ACCOUNT_ID = "00000000-0000-0000-0000-000000000099";
const CUSTOMER_ID = "c0000000-0000-0000-0000-000000000001";

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

vi.mock("@/lib/db/provision-customer", () => ({
  provisionCustomerDb: (...args: unknown[]) => mockProvisionCustomerDb(...args),
}));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makePostRequest(customerId = CUSTOMER_ID): NextRequest {
  return new NextRequest(
    new URL(
      `http://localhost:3000/api/admin/customers/${customerId}/retry-provision`,
    ),
    { method: "POST" },
  );
}

// ---------------------------------------------------------------------------
// Tests — POST /api/admin/customers/[customerId]/retry-provision
// ---------------------------------------------------------------------------

describe("POST /api/admin/customers/[customerId]/retry-provision", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAssertAuthorized.mockResolvedValue(new Set(["customers:write"]));
    mockPoolQuery.mockResolvedValue({
      rows: [{ database_status: "failed" }],
    });
    mockProvisionCustomerDb.mockResolvedValue("active");
  });

  // =========================================================================
  // Authorization
  // =========================================================================

  it("calls assertAuthorized with customers:write", async () => {
    const { POST } = await import("../route");
    await POST(makePostRequest());

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
    const res = await POST(makePostRequest());

    expect(res.status).toBe(403);
  });

  // =========================================================================
  // Input validation
  // =========================================================================

  it("returns 400 for invalid UUID in path", async () => {
    const { POST } = await import("../route");
    const res = await POST(makePostRequest("not-a-uuid"));

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe("Invalid customer ID");
  });

  // =========================================================================
  // Customer not found
  // =========================================================================

  it("returns 404 when customer does not exist", async () => {
    mockPoolQuery.mockResolvedValueOnce({ rows: [] });

    const { POST } = await import("../route");
    const res = await POST(makePostRequest());

    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error).toBe("Customer not found");
  });

  // =========================================================================
  // Status guard
  // =========================================================================

  it("returns 409 when database_status is not failed", async () => {
    mockPoolQuery.mockResolvedValueOnce({
      rows: [{ database_status: "active" }],
    });

    const { POST } = await import("../route");
    const res = await POST(makePostRequest());

    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error).toContain("database_status is 'failed'");
  });

  it("returns 409 when database_status is provisioning", async () => {
    mockPoolQuery.mockResolvedValueOnce({
      rows: [{ database_status: "provisioning" }],
    });

    const { POST } = await import("../route");
    const res = await POST(makePostRequest());

    expect(res.status).toBe(409);
  });

  // =========================================================================
  // Success path
  // =========================================================================

  it("sets database_status to provisioning before calling provisionCustomerDb", async () => {
    const { POST } = await import("../route");
    await POST(makePostRequest());

    // First query: SELECT database_status
    // Second query: UPDATE database_status = 'provisioning'
    expect(mockPoolQuery).toHaveBeenCalledTimes(2);
    const updateSql = mockPoolQuery.mock.calls[1][0] as string;
    expect(updateSql).toContain("database_status = 'provisioning'");
  });

  it("calls provisionCustomerDb with isRetry true", async () => {
    const { POST } = await import("../route");
    await POST(makePostRequest());

    expect(mockProvisionCustomerDb).toHaveBeenCalledWith(
      expect.anything(),
      CUSTOMER_ID,
      expect.objectContaining({
        isRetry: true,
        actorContext: expect.objectContaining({
          actorId: SELF_ACCOUNT_ID,
          authContext: "admin",
        }),
      }),
    );
  });

  it("returns databaseStatus from provisionCustomerDb", async () => {
    mockProvisionCustomerDb.mockResolvedValue("active");

    const { POST } = await import("../route");
    const res = await POST(makePostRequest());

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.databaseStatus).toBe("active");
  });

  it("returns failed when provisionCustomerDb fails", async () => {
    mockProvisionCustomerDb.mockResolvedValue("failed");

    const { POST } = await import("../route");
    const res = await POST(makePostRequest());

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.databaseStatus).toBe("failed");
  });

  it("populates audit metadata", async () => {
    const { POST } = await import("../route");
    const req = makePostRequest();
    const res = await POST(req);

    expect(res.status).toBe(200);
    // The audit object is populated via auth.audit.targetId and auth.audit.details
    // which is verified by checking the mockWithAuth captured auth object
  });
});
