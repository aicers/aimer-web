import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mockAssertAuthorized = vi.fn();
const mockAuditLog = vi.fn();
const mockClientQuery = vi.fn();
const mockConnect = vi.fn(() => ({
  query: mockClientQuery,
  release: vi.fn(),
}));

const SELF = "00000000-0000-0000-0000-000000000099";
const CUSTOMER_ID = "c0000000-0000-0000-0000-000000000001";
const JOB_ID = "00000000-0000-0000-0000-00000000abcd";

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

function makeGetReq(): NextRequest {
  return new NextRequest(
    new URL(
      `http://localhost:3000/api/admin/customers/${CUSTOMER_ID}/redaction-jobs/${JOB_ID}`,
    ),
    { method: "GET" },
  );
}

function makeDeleteReq(body?: object): NextRequest {
  return new NextRequest(
    new URL(
      `http://localhost:3000/api/admin/customers/${CUSTOMER_ID}/redaction-jobs/${JOB_ID}`,
    ),
    {
      method: "DELETE",
      body: body == null ? undefined : JSON.stringify(body),
    },
  );
}

describe("redaction-jobs [jobId] GET", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.resetModules();
    mockAssertAuthorized.mockResolvedValue(
      new Set(["customer-redaction-ranges:read"]),
    );
  });

  it("returns 404 when the job belongs to a different customer", async () => {
    mockClientQuery.mockResolvedValueOnce({ rows: [] });
    const { GET } = await import("../route");
    const res = await GET(makeGetReq());
    expect(res.status).toBe(404);
    expect((await res.json()).error).toBe("not_found");
  });

  it("returns the serialized row on the happy path", async () => {
    const started = new Date("2026-05-20T10:00:00.000Z");
    mockClientQuery.mockResolvedValueOnce({
      rows: [
        {
          job_id: JOB_ID,
          customer_id: CUSTOMER_ID,
          status: "running",
          target_policy_version: "engine:1.0.0|ranges:abcd",
          total_rows: "42",
          processed_rows: "10",
          failed_rows: "1",
          started_at: started,
          running_started_at: started,
          completed_at: null,
          last_progress_at: started,
          error_message: null,
          triggered_by: SELF,
          cancelled_by: null,
          cancellation_reason: null,
        },
      ],
    });
    const { GET } = await import("../route");
    const res = await GET(makeGetReq());
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.job_id).toBe(JOB_ID);
    expect(body.total_rows).toBe(42);
    expect(body.processed_rows).toBe(10);
    expect(body.failed_rows).toBe(1);
    expect(body.completed_at).toBeNull();
    expect(body.running_started_at).toBe(started.toISOString());
  });

  it("returns 400 on bogus identifiers", async () => {
    const { GET } = await import("../route");
    const res = await GET(
      new NextRequest(
        new URL(
          "http://localhost:3000/api/admin/customers/not-a-uuid/redaction-jobs/also-not",
        ),
        { method: "GET" },
      ),
    );
    expect(res.status).toBe(400);
  });
});

describe("redaction-jobs [jobId] DELETE", () => {
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

  it("returns 404 when the job does not exist for this customer", async () => {
    mockClientQuery.mockResolvedValueOnce({ rows: [] });
    const { DELETE } = await import("../route");
    const res = await DELETE(makeDeleteReq());
    expect(res.status).toBe(404);
  });

  it("returns 409 for terminal jobs without flipping status", async () => {
    mockClientQuery.mockResolvedValueOnce({ rows: [{ status: "completed" }] });
    const { DELETE } = await import("../route");
    const res = await DELETE(makeDeleteReq());
    expect(res.status).toBe(409);
    expect((await res.json()).error).toBe("job_terminal");
  });

  it("cancels a queued job and emits the cancellation audit from the endpoint", async () => {
    // queued jobs cannot be observed by a worker before our COMMIT, so
    // the endpoint owns the audit. (Counters are zero by construction.)
    mockClientQuery
      // status check
      .mockResolvedValueOnce({ rows: [{ status: "queued" }] })
      // UPDATE ... RETURNING
      .mockResolvedValueOnce({
        rows: [
          {
            prev_status: "queued",
            processed_rows: "0",
            failed_rows: "0",
            target_policy_version: "engine:1.0.0|ranges:abcd",
          },
        ],
      });
    const { DELETE } = await import("../route");
    const res = await DELETE(makeDeleteReq({ reason: "operator requested" }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.job_id).toBe(JOB_ID);
    expect(body.status).toBe("cancelled");
    expect(mockAuditLog).toHaveBeenCalledOnce();
    const auditCall = mockAuditLog.mock.calls[0][0];
    expect(auditCall.action).toBe(
      "customer_redaction_ranges.retroactive_cancelled",
    );
    expect(auditCall.details.cancellationReason).toBe("operator requested");
    expect(auditCall.details.processedRows).toBe(0);
  });

  it("defers the audit to the worker when cancelling a running job", async () => {
    // For running jobs the worker is still draining its batch and will
    // emit the cancellation audit after its final checkpoint, with the
    // row's final counters. The endpoint must NOT emit; otherwise the
    // audit trail would show a stale processed_rows / failed_rows.
    mockClientQuery
      .mockResolvedValueOnce({ rows: [{ status: "running" }] })
      .mockResolvedValueOnce({
        rows: [
          {
            prev_status: "running",
            processed_rows: "5",
            failed_rows: "0",
            target_policy_version: "engine:1.0.0|ranges:abcd",
          },
        ],
      });
    const { DELETE } = await import("../route");
    const res = await DELETE(makeDeleteReq({ reason: "operator requested" }));
    expect(res.status).toBe(200);
    expect(mockAuditLog).not.toHaveBeenCalled();
  });

  it("returns 409 when the cancellation UPDATE races a terminal flip", async () => {
    mockClientQuery
      .mockResolvedValueOnce({ rows: [{ status: "queued" }] })
      .mockResolvedValueOnce({ rows: [] });
    const { DELETE } = await import("../route");
    const res = await DELETE(makeDeleteReq());
    expect(res.status).toBe(409);
  });
});

describe("redaction-jobs (list) GET", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.resetModules();
    mockAssertAuthorized.mockResolvedValue(
      new Set(["customer-redaction-ranges:read"]),
    );
  });

  it("returns the page + next_cursor when an extra row signals more results", async () => {
    const t = new Date("2026-05-19T10:00:00.000Z");
    const rows = Array.from({ length: 21 }, (_, i) => ({
      job_id: `00000000-0000-0000-0000-0000000000${i.toString().padStart(2, "0")}`,
      status: "completed",
      target_policy_version: "engine:1.0.0|ranges:abcd",
      total_rows: "10",
      processed_rows: "10",
      failed_rows: "0",
      started_at: t,
      running_started_at: t,
      completed_at: t,
      last_progress_at: t,
      error_message: null,
      triggered_by: SELF,
      cancelled_by: null,
      cancellation_reason: null,
    }));
    mockClientQuery.mockResolvedValueOnce({ rows });
    const req = new NextRequest(
      new URL(
        `http://localhost:3000/api/admin/customers/${CUSTOMER_ID}/redaction-jobs`,
      ),
      { method: "GET" },
    );
    const { GET } = await import("../../route");
    const res = await GET(req);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.jobs.length).toBe(20);
    expect(body.next_cursor).toBe(body.jobs[19].job_id);
  });
});
