import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const mockVerifyContextToken = vi.fn();
const mockVerifyEventsEnvelope = vi.fn();
const mockVerifyAnalyzeParamsToken = vi.fn();
const mockTryLoadSession = vi.fn();
const mockCreatePendingConnection = vi.fn();
const mockCreatePAR = vi.fn();
const mockRunAnalyzeFlow = vi.fn();
const mockAuditLog = vi.fn(async (..._args: unknown[]) => {});
const mockSetConnectionIdCookie = vi.fn();
const mockClearInvitationTokenCookie = vi.fn();

vi.mock("@/lib/auth/context-token", () => ({
  verifyContextToken: (...args: unknown[]) => mockVerifyContextToken(...args),
}));
vi.mock("@/lib/auth/events-envelope", () => ({
  verifyEventsEnvelope: (...args: unknown[]) =>
    mockVerifyEventsEnvelope(...args),
}));
vi.mock("@/lib/auth/analyze-params-token", () => ({
  verifyAnalyzeParamsToken: (...args: unknown[]) =>
    mockVerifyAnalyzeParamsToken(...args),
}));
vi.mock("@/lib/auth/guards", () => ({
  tryLoadGeneralSession: (...args: unknown[]) => mockTryLoadSession(...args),
}));
vi.mock("@/lib/auth/bridge", () => ({
  createPendingConnectionWithClient: (...args: unknown[]) =>
    mockCreatePendingConnection(...args),
}));
vi.mock("@/lib/auth/analyze-bridge", () => ({
  createPendingAnalysisRequestWithClient: (...args: unknown[]) =>
    mockCreatePAR(...args),
}));
vi.mock("@/lib/analysis/run-analyze-flow", () => ({
  runAnalyzeFlow: (...args: unknown[]) => mockRunAnalyzeFlow(...args),
  isSupportedLang: (v: string) => v === "KOREAN" || v === "ENGLISH",
  LANG_VALUES: ["KOREAN", "ENGLISH"],
}));
vi.mock("@/lib/audit", () => ({
  auditLog: (...args: unknown[]) => mockAuditLog(...args),
  UNKNOWN_ACTOR_ID: "unknown",
}));
vi.mock("@/lib/audit/correlation", () => ({
  withCorrelationId: <T>(fn: () => Promise<T>) => fn(),
}));
vi.mock("@/lib/auth/cookies", () => ({
  setConnectionIdCookie: mockSetConnectionIdCookie,
  clearInvitationTokenCookie: mockClearInvitationTokenCookie,
}));
vi.mock("@/lib/db/client", () => ({
  getAuthPool: vi.fn(() => ({})),
  withTransaction: async <T>(_pool: unknown, fn: (c: unknown) => Promise<T>) =>
    fn({}),
}));
vi.mock("@/lib/auth/request-meta", () => ({
  extractRequestMeta: () => ({ ipAddress: "1.2.3.4", userAgent: "ua" }),
}));

const validContext = {
  iss: "https://aice.test",
  aud: "aimer-web",
  sub: "user-001",
  aiceId: "aice-1",
  customerIds: ["cust-ext-1"],
  iat: 1000,
  exp: 2000,
  jti: "jti-1",
};

const validEnvelope = {
  iss: "https://aice.test",
  aiceId: "aice-1",
  customerIds: ["cust-ext-1"],
  contextJti: "jti-1",
  payloadHash: "hash",
  eventCount: 1,
  schemaVersion: "1.0",
};

const validParams = {
  contextJti: "jti-1",
  payloadHash: "hash",
  envelopeHash: "envhash",
  eventKey: "42",
  lang: "KOREAN",
  modelName: "gpt",
  model: "v1",
  force: false,
  externalKey: "cust-ext-1",
};

function makeForm(): FormData {
  const form = new FormData();
  form.append("context_token", "ctx-jwt");
  form.append("events_envelope", "env-jws");
  form.append("events_data", JSON.stringify({ event_key: "42" }));
  form.append("analyze_params_token", "params-jwt");
  return form;
}

function makeRequest(form: FormData): NextRequest {
  return new NextRequest("http://localhost:3000/api/analysis/analyze-bridge", {
    method: "POST",
    body: form,
  });
}

async function callPOST(req: NextRequest) {
  const { POST } = await import("../analyze-bridge/route");
  return POST(req);
}

describe("POST /api/analysis/analyze-bridge", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockVerifyContextToken.mockResolvedValue(validContext);
    mockVerifyEventsEnvelope.mockResolvedValue(validEnvelope);
    mockVerifyAnalyzeParamsToken.mockResolvedValue(validParams);
    mockCreatePendingConnection.mockResolvedValue("conn-id-1");
    mockCreatePAR.mockResolvedValue("par-id-1");
    mockTryLoadSession.mockResolvedValue(null);
  });

  it("cross-site path: inserts PAR + connection, sets cookie, 302 to sign-in", async () => {
    const res = await callPOST(makeRequest(makeForm()));
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toContain(
      "/api/auth/sign-in?flow=bridge",
    );
    expect(mockCreatePendingConnection).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ jti: "jti-1", aiceId: "aice-1" }),
    );
    expect(mockCreatePAR).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        connectionId: "conn-id-1",
        eventKey: "42",
        externalKey: "cust-ext-1",
      }),
    );
    expect(mockSetConnectionIdCookie).toHaveBeenCalledWith("conn-id-1");
    expect(mockAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({ action: "ai_analysis.bridge_initiated" }),
    );
  });

  it("short-circuit path: live session runs runAnalyzeFlow and 302s to view_url", async () => {
    mockTryLoadSession.mockResolvedValue({
      accountId: "acc-1",
      sessionId: "sid-1",
      iat: 1000,
      tokenVersion: 1,
      bridgeAiceId: null,
      bridgeCustomerIds: null,
    });
    mockRunAnalyzeFlow.mockResolvedValue({
      kind: "success",
      viewUrl:
        "http://localhost:3000/en/customers/cust/aice/aice-1/events/42/analysis?lang=KOREAN&model_name=gpt&model=v1",
      cached: false,
      customerId: "cust-1",
    });

    const res = await callPOST(makeRequest(makeForm()));
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toContain("/analysis");
    expect(mockCreatePendingConnection).not.toHaveBeenCalled();
    expect(mockCreatePAR).not.toHaveBeenCalled();
    expect(mockAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "ai_analysis.short_circuit_executed",
        details: expect.objectContaining({ outcome: "success" }),
      }),
    );
  });

  it("short-circuit with tampered params still rejects (no session-based bypass)", async () => {
    mockTryLoadSession.mockResolvedValue({
      accountId: "acc-1",
      sessionId: "sid-1",
      iat: 1000,
      tokenVersion: 1,
      bridgeAiceId: null,
      bridgeCustomerIds: null,
    });
    mockVerifyAnalyzeParamsToken.mockRejectedValue(
      new Error("params signature invalid"),
    );

    const res = await callPOST(makeRequest(makeForm()));
    expect(res.status).toBe(400);
    expect(mockRunAnalyzeFlow).not.toHaveBeenCalled();
  });

  it("rejects jti replay with 400 (no PAR inserted)", async () => {
    mockCreatePendingConnection.mockRejectedValue(
      new Error("duplicate key value violates pending_connections_jti_key"),
    );
    const res = await callPOST(makeRequest(makeForm()));
    expect(res.status).toBe(400);
    expect(mockAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "bridge.connection_denied",
        details: expect.objectContaining({ reason: "jti_replay" }),
      }),
    );
  });

  it("rejects when external_key not in context customer_ids", async () => {
    mockVerifyAnalyzeParamsToken.mockResolvedValue({
      ...validParams,
      externalKey: "different-cust",
    });
    const res = await callPOST(makeRequest(makeForm()));
    expect(res.status).toBe(400);
  });

  it("rejects signed non-canonical event_key without inserting a PAR", async () => {
    mockVerifyAnalyzeParamsToken.mockResolvedValue({
      ...validParams,
      eventKey: "01",
    });
    const res = await callPOST(makeRequest(makeForm()));
    expect(res.status).toBe(400);
    const body = await res.text();
    expect(body).toContain("invalid_analyze_params_token");
    expect(mockCreatePendingConnection).not.toHaveBeenCalled();
    expect(mockCreatePAR).not.toHaveBeenCalled();
    expect(mockRunAnalyzeFlow).not.toHaveBeenCalled();
  });

  it("rejects signed non-numeric event_key without inserting a PAR", async () => {
    mockVerifyAnalyzeParamsToken.mockResolvedValue({
      ...validParams,
      eventKey: "abc",
    });
    const res = await callPOST(makeRequest(makeForm()));
    expect(res.status).toBe(400);
    expect(mockCreatePAR).not.toHaveBeenCalled();
  });

  it("oversized events_data surfaces event_data_too_large (413), not invalid_events_envelope (400)", async () => {
    const { PayloadTooLargeError } = await import("@/lib/auth/errors");
    mockVerifyEventsEnvelope.mockRejectedValue(
      new PayloadTooLargeError(2_000_000, 1_048_576),
    );
    const res = await callPOST(makeRequest(makeForm()));
    expect(res.status).toBe(413);
    expect(res.headers.get("content-type")).toContain("text/html");
    const body = await res.text();
    expect(body).toContain("event_data_too_large");
    expect(mockCreatePAR).not.toHaveBeenCalled();
  });
});
