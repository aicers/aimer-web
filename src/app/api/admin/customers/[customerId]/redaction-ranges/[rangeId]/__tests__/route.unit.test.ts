import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mockAssertAuthorized = vi.fn();
const mockClientQuery = vi.fn();
const mockClientRelease = vi.fn();
const mockConnect = vi.fn(() => ({
  query: mockClientQuery,
  release: mockClientRelease,
}));

const SELF = "00000000-0000-0000-0000-000000000099";
const CUSTOMER_ID = "c0000000-0000-0000-0000-000000000001";
const RANGE_ID = "11111111-1111-1111-1111-111111111111";

const mockAuditMeta: {
  targetId?: string;
  details?: unknown;
  customerId?: string;
} = {};

vi.mock("@/lib/auth/guards", () => ({
  // biome-ignore lint/complexity/noBannedTypes: test mock
  withAuth: (handler: Function) => (req: NextRequest) => {
    mockAuditMeta.targetId = undefined;
    mockAuditMeta.details = undefined;
    mockAuditMeta.customerId = undefined;
    return handler(req, {
      accountId: SELF,
      sessionId: "sess-1",
      authContext: "general",
      tokenVersion: 1,
      iat: 1000,
      meta: { ipAddress: "127.0.0.1", userAgent: "test" },
      bridgeAiceId: null,
      bridgeCustomerIds: null,
      audit: mockAuditMeta,
    });
  },
  verifyOrigin: () => null,
  verifyCsrf: () => null,
}));

vi.mock("@/lib/auth/authorization", () => ({
  assertAuthorized: (...args: unknown[]) => mockAssertAuthorized(...args),
}));

vi.mock("@/lib/db/client", () => ({
  getAuthPool: () => ({ connect: mockConnect }),
}));

function makeDeleteRequest(): NextRequest {
  return new NextRequest(
    new URL(
      `http://localhost:3000/api/admin/customers/${CUSTOMER_ID}/redaction-ranges/${RANGE_ID}`,
    ),
    { method: "DELETE" },
  );
}

describe("DELETE /redaction-ranges/[rangeId]", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAssertAuthorized.mockResolvedValue(
      new Set(["customer-redaction-ranges:write"]),
    );
  });

  it("returns 204 and stamps audit details on success", async () => {
    // BEGIN, advisory_xact_lock, DELETE … RETURNING, COMMIT.
    mockClientQuery.mockImplementation(async (sql: string) => {
      if (typeof sql === "string" && sql.startsWith("DELETE FROM")) {
        return { rows: [{ cidr: "203.0.113.0/24" }] };
      }
      return { rows: [] };
    });
    const { DELETE } = await import("../route");
    const res = await DELETE(makeDeleteRequest());
    expect(res.status).toBe(204);
    expect(mockAuditMeta.targetId).toBe(RANGE_ID);
    expect(mockAuditMeta.customerId).toBe(CUSTOMER_ID);
    expect(mockAuditMeta.details).toEqual({
      customerId: CUSTOMER_ID,
      cidr: "203.0.113.0/24",
      rangeId: RANGE_ID,
    });
    // Per-customer range-mutation advisory lock acquired inside the
    // DELETE transaction so the lock blocks concurrent POST and the
    // retroactive-redaction worker's materialization window.
    const sqls = mockClientQuery.mock.calls.map((c) => c[0]);
    expect(sqls).toContain("BEGIN");
    expect(sqls).toContain("COMMIT");
    expect(
      sqls.some(
        (s) =>
          typeof s === "string" && s.includes("pg_advisory_xact_lock(hashtext"),
      ),
    ).toBe(true);
    const lockArgs = mockClientQuery.mock.calls.find(
      ([s]) =>
        typeof s === "string" && s.includes("pg_advisory_xact_lock(hashtext"),
    )?.[1] as string[] | undefined;
    expect(lockArgs?.[0]).toBe(`redaction-ranges:${CUSTOMER_ID}`);
  });

  it("returns 404 when the range row does not exist", async () => {
    mockClientQuery.mockImplementation(async (sql: string) => {
      if (typeof sql === "string" && sql.startsWith("DELETE FROM")) {
        return { rows: [] };
      }
      return { rows: [] };
    });
    const { DELETE } = await import("../route");
    const res = await DELETE(makeDeleteRequest());
    expect(res.status).toBe(404);
    expect(mockAuditMeta.targetId).toBeUndefined();
    // The transaction must roll back so a subsequent client reuse does
    // not inherit a half-open BEGIN.
    const sqls = mockClientQuery.mock.calls.map((c) => c[0]);
    expect(sqls).toContain("ROLLBACK");
  });

  it("returns 403 when the caller lacks :write", async () => {
    const { HttpError } = await import("@/lib/auth/errors");
    mockAssertAuthorized.mockRejectedValue(new HttpError("Forbidden", 403));
    const { DELETE } = await import("../route");
    const res = await DELETE(makeDeleteRequest());
    expect(res.status).toBe(403);
    // No DB DELETE issued.
    expect(mockClientQuery).not.toHaveBeenCalled();
  });

  it("returns 400 when the path ids are not UUIDs", async () => {
    const { DELETE } = await import("../route");
    const req = new NextRequest(
      new URL(
        "http://localhost:3000/api/admin/customers/not-a-uuid/redaction-ranges/also-bogus",
      ),
      { method: "DELETE" },
    );
    const res = await DELETE(req);
    expect(res.status).toBe(400);
  });
});
