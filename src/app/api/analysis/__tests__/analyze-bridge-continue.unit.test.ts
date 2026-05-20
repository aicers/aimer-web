import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const mockLoadPAR = vi.fn();
const mockClaimPAR = vi.fn();
const mockMarkConsumed = vi.fn();
const mockMarkFailed = vi.fn();
const mockRunAnalyzeFlow = vi.fn();
const mockDecryptPayload = vi.fn();
const mockAuditLog = vi.fn(async (..._args: unknown[]) => {});
const mockAuthorize = vi.fn();
const mockGetCustomerByExternalKey = vi.fn();

vi.mock("@/lib/auth/analyze-bridge", () => ({
  loadPendingAnalysisRequest: (...args: unknown[]) => mockLoadPAR(...args),
  claimPAR: (...args: unknown[]) => mockClaimPAR(...args),
  markPARConsumed: (...args: unknown[]) => mockMarkConsumed(...args),
  markPARFailed: (...args: unknown[]) => mockMarkFailed(...args),
}));
vi.mock("@/lib/analysis/run-analyze-flow", () => ({
  runAnalyzeFlow: (...args: unknown[]) => mockRunAnalyzeFlow(...args),
  isSupportedLang: (v: string) => v === "KOREAN" || v === "ENGLISH",
}));
vi.mock("@/lib/crypto/envelope", () => ({
  decryptPayload: (...args: unknown[]) => mockDecryptPayload(...args),
}));
vi.mock("@/lib/audit", () => ({
  auditLog: (...args: unknown[]) => mockAuditLog(...args),
  UNKNOWN_ACTOR_ID: "unknown",
}));
vi.mock("@/lib/audit/correlation", () => ({
  withCorrelationId: <T>(fn: () => Promise<T>) => fn(),
}));
vi.mock("@/lib/auth/authorization", () => ({
  authorize: (...args: unknown[]) => mockAuthorize(...args),
}));
vi.mock("@/lib/auth/customers", () => ({
  getCustomerByExternalKey: (...args: unknown[]) =>
    mockGetCustomerByExternalKey(...args),
}));
vi.mock("@/lib/db/client", () => ({
  getAuthPool: vi.fn(() => ({})),
  withTransaction: async <T>(_pool: unknown, fn: (c: unknown) => Promise<T>) =>
    fn({}),
}));

// Bypass withAuth — inject a fake authenticated request through the
// handler.
vi.mock("@/lib/auth/guards", () => ({
  withAuth: (
    handler: (
      req: NextRequest,
      auth: Record<string, unknown>,
    ) => Promise<Response>,
  ) => {
    return async (req: NextRequest) => {
      return handler(req, {
        accountId: "acc-1",
        sessionId: "sid-1",
        authContext: "general",
        tokenVersion: 1,
        iat: 1000,
        meta: { ipAddress: "1.2.3.4", userAgent: "ua" },
        bridgeAiceId: null,
        bridgeCustomerIds: null,
        audit: {},
      });
    };
  },
}));

function makeRequest(id: string | null): NextRequest {
  const url = id
    ? `http://localhost:3000/api/analysis/analyze-bridge/continue?id=${id}`
    : "http://localhost:3000/api/analysis/analyze-bridge/continue";
  return new NextRequest(url);
}

async function callGET(req: NextRequest): Promise<Response> {
  const { GET } = await import("../analyze-bridge/continue/route");
  return GET(req);
}

const basePAR = {
  id: "par-1",
  connectionId: "conn-1",
  aiceId: "aice-1",
  externalKey: "cust-ext-1",
  eventKey: "42",
  lang: "KOREAN",
  modelName: "gpt",
  model: "v1",
  force: false,
  payload: Buffer.from("ignored"),
  wrappedDek: "dek",
  payloadHash: "hash",
  status: "pending" as const,
  createdAt: new Date(),
  expiresAt: new Date(Date.now() + 60_000),
  consumedAt: null,
  viewUrl: null,
  failureCode: null,
  failureAt: null,
};

describe("GET /api/analysis/analyze-bridge/continue", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetCustomerByExternalKey.mockResolvedValue({
      id: "cust-1",
      externalKey: "cust-ext-1",
      databaseStatus: "active",
      status: "active",
    });
    mockAuthorize.mockResolvedValue({ authorized: true });
    mockClaimPAR.mockResolvedValue(true);
    mockMarkConsumed.mockResolvedValue(true);
    mockMarkFailed.mockResolvedValue(true);
  });

  it("returns 404 when id is missing", async () => {
    const res = await callGET(makeRequest(null));
    expect(res.status).toBe(404);
    expect(mockLoadPAR).not.toHaveBeenCalled();
  });

  it("returns 404 when PAR row does not exist", async () => {
    mockLoadPAR.mockResolvedValue(null);
    const res = await callGET(makeRequest("par-missing"));
    expect(res.status).toBe(404);
  });

  it("denies access when authorize() rejects — does NOT dispatch consumed viewUrl", async () => {
    mockLoadPAR.mockResolvedValue({
      ...basePAR,
      status: "consumed",
      viewUrl: "http://example.com/leak",
    });
    mockAuthorize.mockResolvedValue({ authorized: false });
    const res = await callGET(makeRequest("par-1"));
    expect(res.status).toBe(403);
    expect(res.headers.get("location")).toBeNull();
    expect(mockAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "ai_analysis.continue_failed",
        details: expect.objectContaining({ stage: "authorize" }),
      }),
    );
  });

  it("denies access when customer cannot be resolved", async () => {
    mockLoadPAR.mockResolvedValue({
      ...basePAR,
      status: "failed",
      failureCode: "aimer_unavailable",
    });
    mockGetCustomerByExternalKey.mockResolvedValue(null);
    const res = await callGET(makeRequest("par-1"));
    expect(res.status).toBe(403);
    expect(mockRunAnalyzeFlow).not.toHaveBeenCalled();
  });

  it("consumed status redirects to stored view_url (replay path)", async () => {
    mockLoadPAR.mockResolvedValue({
      ...basePAR,
      status: "consumed",
      viewUrl:
        "http://localhost:3000/en/customers/c/aice/aice-1/events/42/analysis",
    });
    const res = await callGET(makeRequest("par-1"));
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toContain("/analysis");
    expect(mockAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({ action: "ai_analysis.continue_replayed" }),
    );
    expect(mockRunAnalyzeFlow).not.toHaveBeenCalled();
  });

  it("failed status renders styled error page", async () => {
    mockLoadPAR.mockResolvedValue({
      ...basePAR,
      status: "failed",
      failureCode: "aimer_unavailable",
    });
    const res = await callGET(makeRequest("par-1"));
    expect(res.status).toBe(503);
    expect(res.headers.get("content-type")).toContain("text/html");
    expect(mockRunAnalyzeFlow).not.toHaveBeenCalled();
  });

  it("expired status renders session-expired page", async () => {
    mockLoadPAR.mockResolvedValue({ ...basePAR, status: "expired" });
    const res = await callGET(makeRequest("par-1"));
    expect(res.status).toBe(410);
    expect(res.headers.get("content-type")).toContain("text/html");
  });

  it("processing status renders in-progress page (no flow run)", async () => {
    mockLoadPAR.mockResolvedValue({ ...basePAR, status: "processing" });
    const res = await callGET(makeRequest("par-1"));
    expect(res.status).toBe(202);
    expect(res.headers.get("content-type")).toContain("text/html");
    expect(mockClaimPAR).not.toHaveBeenCalled();
    expect(mockRunAnalyzeFlow).not.toHaveBeenCalled();
  });

  it("pending status decrypts + runs flow + marks consumed + 302 to view_url", async () => {
    const eventDataJson = JSON.stringify({ event_key: "42" });
    const plaintext = Buffer.from(eventDataJson, "utf8");
    const { createHash } = await import("node:crypto");
    const computedHash = createHash("sha256")
      .update(plaintext)
      .digest("base64url");
    mockLoadPAR.mockResolvedValue({ ...basePAR, payloadHash: computedHash });
    mockDecryptPayload.mockResolvedValue(plaintext);
    mockRunAnalyzeFlow.mockResolvedValue({
      kind: "success",
      viewUrl: "http://example.com/view",
      cached: true,
      customerId: "cust-1",
    });

    const res = await callGET(makeRequest("par-1"));
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("http://example.com/view");
    expect(mockClaimPAR).toHaveBeenCalledWith(expect.anything(), "par-1");
    expect(mockMarkConsumed).toHaveBeenCalledWith(
      expect.anything(),
      "par-1",
      "http://example.com/view",
    );
    expect(mockAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({ action: "ai_analysis.continue_executed" }),
    );
  });

  it("failed claim re-reads PAR; second concurrent /continue does NOT run flow", async () => {
    mockLoadPAR
      // First load — observed pending.
      .mockResolvedValueOnce(basePAR)
      // Reload after failed claim — now consumed by the other tick.
      .mockResolvedValueOnce({
        ...basePAR,
        status: "consumed",
        viewUrl: "http://example.com/winner",
      });
    mockClaimPAR.mockResolvedValue(false);

    const res = await callGET(makeRequest("par-1"));
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("http://example.com/winner");
    expect(mockRunAnalyzeFlow).not.toHaveBeenCalled();
    expect(mockDecryptPayload).not.toHaveBeenCalled();
  });

  it("failed claim with row still pending falls back to in-progress page", async () => {
    mockLoadPAR.mockResolvedValueOnce(basePAR).mockResolvedValueOnce(basePAR); // reload also returns pending
    mockClaimPAR.mockResolvedValue(false);

    const res = await callGET(makeRequest("par-1"));
    expect(res.status).toBe(202);
    expect(mockRunAnalyzeFlow).not.toHaveBeenCalled();
  });

  it("markPARConsumed=false (cleanup expired row during flow) → re-reads PAR and renders session-expired, not success", async () => {
    const eventDataJson = JSON.stringify({ event_key: "42" });
    const plaintext = Buffer.from(eventDataJson, "utf8");
    const { createHash } = await import("node:crypto");
    const computedHash = createHash("sha256")
      .update(plaintext)
      .digest("base64url");
    mockLoadPAR
      // Initial load — claim took processing.
      .mockResolvedValueOnce({ ...basePAR, payloadHash: computedHash })
      // Reload after markPARConsumed=false — cleanup flipped it to expired.
      .mockResolvedValueOnce({
        ...basePAR,
        payloadHash: computedHash,
        status: "expired",
      });
    mockDecryptPayload.mockResolvedValue(plaintext);
    mockRunAnalyzeFlow.mockResolvedValue({
      kind: "success",
      viewUrl: "http://example.com/view",
      cached: false,
      customerId: "cust-1",
    });
    mockMarkConsumed.mockResolvedValue(false);

    const res = await callGET(makeRequest("par-1"));
    expect(res.status).toBe(410);
    expect(res.headers.get("location")).toBeNull();
    expect(mockAuditLog).not.toHaveBeenCalledWith(
      expect.objectContaining({ action: "ai_analysis.continue_executed" }),
    );
  });

  it("markPARFailed=false (cleanup expired row during flow) → re-reads PAR and renders session-expired", async () => {
    const eventDataJson = JSON.stringify({ event_key: "42" });
    const plaintext = Buffer.from(eventDataJson, "utf8");
    const { createHash } = await import("node:crypto");
    const computedHash = createHash("sha256")
      .update(plaintext)
      .digest("base64url");
    mockLoadPAR
      .mockResolvedValueOnce({ ...basePAR, payloadHash: computedHash })
      .mockResolvedValueOnce({
        ...basePAR,
        payloadHash: computedHash,
        status: "expired",
      });
    mockDecryptPayload.mockResolvedValue(plaintext);
    mockRunAnalyzeFlow.mockResolvedValue({
      kind: "error",
      errorCode: "aimer_unavailable",
      message: "down",
    });
    mockMarkFailed.mockResolvedValue(false);

    const res = await callGET(makeRequest("par-1"));
    expect(res.status).toBe(410);
    expect(mockAuditLog).not.toHaveBeenCalledWith(
      expect.objectContaining({ action: "ai_analysis.continue_failed" }),
    );
  });
});
