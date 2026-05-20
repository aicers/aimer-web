import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { HttpError } from "@/lib/auth/errors";

const mockAssertAuthorized = vi.fn();
const mockClientQuery = vi.fn();
const mockClientRelease = vi.fn();
const mockConnect = vi.fn(() => ({
  query: mockClientQuery,
  release: mockClientRelease,
}));
const mockAuditLog = vi.fn();

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

vi.mock("@/lib/audit", () => ({
  auditLog: (...args: unknown[]) => mockAuditLog(...args),
}));

function makeGetRequest(): NextRequest {
  return new NextRequest(
    new URL(
      `http://localhost:3000/api/admin/customers/${CUSTOMER_ID}/retention`,
    ),
    { method: "GET" },
  );
}

function makePutRequest(body: unknown): NextRequest {
  return new NextRequest(
    new URL(
      `http://localhost:3000/api/admin/customers/${CUSTOMER_ID}/retention`,
    ),
    {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    },
  );
}

describe("retention route", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAssertAuthorized.mockResolvedValue(
      new Set(["customer-retention:read", "customer-retention:write"]),
    );
  });

  it("GET returns the current settings", async () => {
    mockClientQuery.mockResolvedValueOnce({
      rows: [{ ingestion_days: 365, analysis_days: 1095 }],
    });
    const { GET } = await import("../route");
    const res = await GET(makeGetRequest());
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ ingestion_days: 365, analysis_days: 1095 });
  });

  it("GET returns analysis_days: null when unlimited", async () => {
    mockClientQuery.mockResolvedValueOnce({
      rows: [{ ingestion_days: 365, analysis_days: null }],
    });
    const { GET } = await import("../route");
    const body = await (await GET(makeGetRequest())).json();
    expect(body.analysis_days).toBeNull();
  });

  it("PUT rejects ingestion_days < 30 with retention_too_short", async () => {
    const { PUT } = await import("../route");
    const res = await PUT(
      makePutRequest({ ingestion_days: 29, analysis_days: 90 }),
    );
    expect(res.status).toBe(422);
    expect((await res.json()).error).toBe("retention_too_short");
  });

  it("PUT rejects analysis_days = 29 with retention_too_short", async () => {
    const { PUT } = await import("../route");
    const res = await PUT(
      makePutRequest({ ingestion_days: 365, analysis_days: 29 }),
    );
    expect(res.status).toBe(422);
    expect((await res.json()).error).toBe("retention_too_short");
  });

  it("PUT accepts analysis_days = null regardless of prior value", async () => {
    mockClientQuery
      .mockResolvedValueOnce({
        rows: [{ ingestion_days: 365, analysis_days: 30 }],
      })
      .mockResolvedValueOnce({ rows: [] });
    const { PUT } = await import("../route");
    const res = await PUT(
      makePutRequest({ ingestion_days: 365, analysis_days: null }),
    );
    expect(res.status).toBe(200);
    expect(mockAuditLog).toHaveBeenCalled();
  });

  it("PUT accepts analysis_days = 30 (boundary)", async () => {
    mockClientQuery
      .mockResolvedValueOnce({
        rows: [{ ingestion_days: 365, analysis_days: 1095 }],
      })
      .mockResolvedValueOnce({ rows: [] });
    const { PUT } = await import("../route");
    const res = await PUT(
      makePutRequest({ ingestion_days: 365, analysis_days: 30 }),
    );
    expect(res.status).toBe(200);
  });

  it("PUT does NOT emit audit on a no-op write", async () => {
    mockClientQuery.mockResolvedValueOnce({
      rows: [{ ingestion_days: 365, analysis_days: 1095 }],
    });
    const { PUT } = await import("../route");
    const res = await PUT(
      makePutRequest({ ingestion_days: 365, analysis_days: 1095 }),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.changed).toBe(false);
    expect(mockAuditLog).not.toHaveBeenCalled();
  });

  it("PUT emits an audit event on a real change with before/after details", async () => {
    mockClientQuery
      .mockResolvedValueOnce({
        rows: [{ ingestion_days: 365, analysis_days: 1095 }],
      })
      .mockResolvedValueOnce({ rows: [] });
    const { PUT } = await import("../route");
    await PUT(makePutRequest({ ingestion_days: 365, analysis_days: 60 }));
    expect(mockAuditLog).toHaveBeenCalledOnce();
    const call = mockAuditLog.mock.calls[0][0];
    expect(call.action).toBe("customer_retention_policy.updated");
    expect(call.details.before).toEqual({
      ingestion_days: 365,
      analysis_days: 1095,
    });
    expect(call.details.after).toEqual({
      ingestion_days: 365,
      analysis_days: 60,
    });
  });

  it("PUT returns 403 for a read-only caller before validating the body", async () => {
    mockAssertAuthorized.mockRejectedValueOnce(new HttpError("forbidden", 403));
    const { PUT } = await import("../route");
    const res = await PUT(
      // Body that would otherwise fail validation (ingestion_days < 30)
      // must not leak its 422 — the 403 from authorization wins.
      makePutRequest({ ingestion_days: 1, analysis_days: 90 }),
    );
    expect(res.status).toBe(403);
    expect((await res.json()).error).toBe("forbidden");
  });
});
