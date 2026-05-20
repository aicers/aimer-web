import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const mockAssertAuthorized = vi.fn();
const mockComputePolicy = vi.fn();
const mockCountStaleRows = vi.fn();

const mockAuthClientQuery = vi.fn();
const mockAuthConnect = vi.fn(() => ({
  query: mockAuthClientQuery,
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
  getAuthPool: () => ({ connect: mockAuthConnect }),
}));

vi.mock("@/lib/redaction/customer-policy", () => ({
  computeCustomerPolicyVersion: (...args: unknown[]) =>
    mockComputePolicy(...args),
}));

vi.mock("@/lib/redaction/stale-scan", () => ({
  countStaleRows: (...args: unknown[]) => mockCountStaleRows(...args),
}));

vi.mock("@/lib/db/customer-runtime-pool", () => ({
  getCustomerRuntimePool: () => ({ query: vi.fn() }),
}));

function makeGetRequest(): NextRequest {
  return new NextRequest(
    new URL(
      `http://localhost:3000/api/admin/customers/${CUSTOMER_ID}/redaction-jobs/preview`,
    ),
    { method: "GET" },
  );
}

describe("GET /redaction-jobs/preview", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAssertAuthorized.mockResolvedValue(
      new Set(["customer-redaction-ranges:read"]),
    );
  });

  it("returns stale_row_count, estimated_duration_seconds, and the composite policy version", async () => {
    mockComputePolicy.mockResolvedValue("engine:1.0.0|ranges:deadbeef");
    mockCountStaleRows.mockResolvedValue(40);
    const { GET } = await import("../route");
    const res = await GET(makeGetRequest());
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.target_policy_version).toBe("engine:1.0.0|ranges:deadbeef");
    expect(body.stale_row_count).toBe(40);
    // estimated_duration_seconds = ceil(stale_row_count * PER_ROW_SECONDS).
    // PER_ROW_SECONDS is 0.05; 40 * 0.05 = 2 → ceil = 2.
    expect(body.estimated_duration_seconds).toBe(2);
  });

  it("rounds up partial seconds", async () => {
    mockComputePolicy.mockResolvedValue("engine:1.0.0|ranges:deadbeef");
    mockCountStaleRows.mockResolvedValue(7); // 7 * 0.05 = 0.35 → ceil = 1
    const { GET } = await import("../route");
    const body = await (await GET(makeGetRequest())).json();
    expect(body.estimated_duration_seconds).toBe(1);
  });

  it("returns 403 when the caller lacks :read", async () => {
    const { HttpError } = await import("@/lib/auth/errors");
    mockAssertAuthorized.mockRejectedValue(new HttpError("Forbidden", 403));
    const { GET } = await import("../route");
    const res = await GET(makeGetRequest());
    expect(res.status).toBe(403);
    expect(mockCountStaleRows).not.toHaveBeenCalled();
  });

  it("returns 400 on a bogus customer id", async () => {
    const { GET } = await import("../route");
    const req = new NextRequest(
      new URL(
        "http://localhost:3000/api/admin/customers/not-a-uuid/redaction-jobs/preview",
      ),
      { method: "GET" },
    );
    const res = await GET(req);
    expect(res.status).toBe(400);
  });

  it("computes the composite version against the same customer id passed in", async () => {
    mockComputePolicy.mockResolvedValue("engine:1.0.0|ranges:abcd");
    mockCountStaleRows.mockResolvedValue(0);
    const { GET } = await import("../route");
    await GET(makeGetRequest());
    expect(mockComputePolicy).toHaveBeenCalledOnce();
    const [, customerId] = mockComputePolicy.mock.calls[0];
    expect(customerId).toBe(CUSTOMER_ID);
  });
});
