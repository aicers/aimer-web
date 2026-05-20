import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mockAssertAuthorized = vi.fn();
const mockClientQuery = vi.fn();
const mockConnect = vi.fn(() => ({
  query: mockClientQuery,
  release: vi.fn(),
}));

const SELF = "00000000-0000-0000-0000-000000000099";
const CUSTOMER_ID = "c0000000-0000-0000-0000-000000000001";

vi.mock("@/lib/auth/guards", () => ({
  // biome-ignore lint/complexity/noBannedTypes: test mock
  withAuth: (handler: Function) => (req: NextRequest) =>
    handler(req, {
      accountId: SELF,
      sessionId: "sess-1",
      authContext: "general",
      tokenVersion: 1,
      iat: 1000,
      meta: { ipAddress: "127.0.0.1", userAgent: "test" },
      bridgeAiceId: null,
      bridgeCustomerIds: null,
      audit: {},
    }),
  verifyOrigin: () => null,
  verifyCsrf: () => null,
}));

vi.mock("@/lib/auth/authorization", () => ({
  assertAuthorized: (...args: unknown[]) => mockAssertAuthorized(...args),
}));

vi.mock("@/lib/db/client", () => ({
  getAuthPool: () => ({ connect: mockConnect }),
}));

function makePostRequest(): NextRequest {
  return new NextRequest(
    new URL(
      `http://localhost:3000/api/admin/customers/${CUSTOMER_ID}/redaction-jobs`,
    ),
    { method: "POST" },
  );
}

describe("redaction-jobs POST", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.resetModules();
    mockAssertAuthorized.mockResolvedValue(
      new Set([
        "customer-redaction-ranges:read",
        "customer-redaction-ranges:write",
      ]),
    );
  });

  it("returns 403 for callers without :write", async () => {
    const { HttpError } = await import("@/lib/auth/errors");
    mockAssertAuthorized.mockRejectedValue(new HttpError("Forbidden", 403));
    const { POST } = await import("../route");
    const res = await POST(makePostRequest());
    expect(res.status).toBe(403);
  });

  it("inserts a new job row on the happy path", async () => {
    mockClientQuery
      // existing-active lookup
      .mockResolvedValueOnce({ rows: [] })
      // computeCustomerPolicyVersion's range query
      .mockResolvedValueOnce({ rows: [] })
      // INSERT redaction_jobs RETURNING
      .mockResolvedValueOnce({
        rows: [
          {
            id: "j-new",
            status: "queued",
            target_policy_version: "engine:1.0.0|ranges:empty",
          },
        ],
      });
    const { POST } = await import("../route");
    const res = await POST(makePostRequest());
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.job_id).toBe("j-new");
    expect(body.status).toBe("queued");
    expect(body.target_policy_version).toBe("engine:1.0.0|ranges:empty");
  });

  it("returns the existing active job when one is queued/running", async () => {
    mockClientQuery.mockResolvedValueOnce({
      rows: [
        {
          id: "j-existing",
          status: "running",
          target_policy_version: "engine:1.0.0|ranges:abcd",
        },
      ],
    });
    const { POST } = await import("../route");
    const res = await POST(makePostRequest());
    expect(res.status).toBe(200);
    expect((await res.json()).job_id).toBe("j-existing");
  });

  it("returns the winning job when a concurrent insert raced and hit the partial unique index", async () => {
    const uniqueViolation = Object.assign(
      new Error("duplicate key value violates unique constraint"),
      {
        code: "23505",
        constraint: "redaction_jobs_one_active_per_customer",
      },
    );
    mockClientQuery
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockRejectedValueOnce(uniqueViolation)
      .mockResolvedValueOnce({
        rows: [
          {
            id: "j-winner",
            status: "queued",
            target_policy_version: "engine:1.0.0|ranges:beef",
          },
        ],
      });
    const { POST } = await import("../route");
    const res = await POST(makePostRequest());
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.job_id).toBe("j-winner");
    expect(body.status).toBe("queued");
    expect(body.target_policy_version).toBe("engine:1.0.0|ranges:beef");
  });

  it("propagates other 23505 violations rather than re-selecting", async () => {
    const wrongViolation = Object.assign(
      new Error("duplicate key value violates unique constraint"),
      { code: "23505", constraint: "redaction_jobs_pkey" },
    );
    mockClientQuery
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockRejectedValueOnce(wrongViolation);
    const { POST } = await import("../route");
    await expect(POST(makePostRequest())).rejects.toThrow();
  });
});
