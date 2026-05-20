import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const mockLoadPAR = vi.fn();
const mockMarkConsumed = vi.fn();
const mockMarkFailed = vi.fn();
const mockRunAnalyzeFlow = vi.fn();
const mockDecryptPayload = vi.fn();
const mockAuditLog = vi.fn(async (..._args: unknown[]) => {});

vi.mock("@/lib/auth/analyze-bridge", () => ({
  loadPendingAnalysisRequest: (...args: unknown[]) => mockLoadPAR(...args),
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
vi.mock("@/lib/db/client", () => ({
  getAuthPool: vi.fn(() => ({})),
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

  it("pending status decrypts + runs flow + marks consumed + 302 to view_url", async () => {
    mockLoadPAR.mockResolvedValue(basePAR);
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
    expect(mockMarkConsumed).toHaveBeenCalledWith(
      expect.anything(),
      "par-1",
      "http://example.com/view",
    );
    expect(mockAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({ action: "ai_analysis.continue_executed" }),
    );
  });
});
