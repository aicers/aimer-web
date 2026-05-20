import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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

const previousEnv = process.env.NEXT_PUBLIC_REDACTION_RETROACTIVE_ENABLED;

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

  afterEach(() => {
    process.env.NEXT_PUBLIC_REDACTION_RETROACTIVE_ENABLED = previousEnv;
  });

  it("returns 503 feature_disabled when the gate is off", async () => {
    process.env.NEXT_PUBLIC_REDACTION_RETROACTIVE_ENABLED = "";
    const { POST } = await import("../route");
    const res = await POST(makePostRequest());
    expect(res.status).toBe(503);
    expect((await res.json()).error).toBe("feature_disabled");
  });

  it("returns 403 (not 503) for callers without :write even when gate is off", async () => {
    process.env.NEXT_PUBLIC_REDACTION_RETROACTIVE_ENABLED = "";
    const { HttpError } = await import("@/lib/auth/errors");
    mockAssertAuthorized.mockRejectedValue(new HttpError("Forbidden", 403));
    const { POST } = await import("../route");
    const res = await POST(makePostRequest());
    expect(res.status).toBe(403);
  });

  it("inserts a new job row when the gate is on", async () => {
    process.env.NEXT_PUBLIC_REDACTION_RETROACTIVE_ENABLED = "1";
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
    process.env.NEXT_PUBLIC_REDACTION_RETROACTIVE_ENABLED = "1";
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
    process.env.NEXT_PUBLIC_REDACTION_RETROACTIVE_ENABLED = "1";
    const uniqueViolation = Object.assign(
      new Error("duplicate key value violates unique constraint"),
      {
        code: "23505",
        constraint: "redaction_jobs_one_active_per_customer",
      },
    );
    mockClientQuery
      // initial existing-active lookup — sees no active job
      .mockResolvedValueOnce({ rows: [] })
      // computeCustomerPolicyVersion's range query
      .mockResolvedValueOnce({ rows: [] })
      // INSERT — loser of the race, hits the partial unique index
      .mockRejectedValueOnce(uniqueViolation)
      // re-select the winner
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
    process.env.NEXT_PUBLIC_REDACTION_RETROACTIVE_ENABLED = "1";
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
