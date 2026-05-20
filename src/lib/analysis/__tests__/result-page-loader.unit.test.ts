// Unit test for the analysis result-page loader.
//
// Covers the documented outcomes per RFC 0001 §"UI — analysis result
// page":
//   - happy path: result row + map row both present → analysis text is
//     token-restored and sourceEventPresent=true
//   - cascade-edge state: source `detection_events` row swept by
//     retention, but result + map rows survive → loader still renders
//     restored text and reports sourceEventPresent=false
//   - missing result row → kind:"not_found" (the route returns 404)
//   - unauthorized (no cookie / authorize denies) → kind:"unauthorized"

import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const mockGetAuthCookie = vi.fn();
const mockVerifyJwtFull = vi.fn();
const mockAuthorize = vi.fn();
const mockDecryptRedactionMap = vi.fn();

vi.mock("@/lib/auth/cookies", () => ({
  getAuthCookie: (...args: unknown[]) => mockGetAuthCookie(...args),
}));
vi.mock("@/lib/auth/jwt", () => ({
  verifyJwtFull: (...args: unknown[]) => mockVerifyJwtFull(...args),
}));
vi.mock("@/lib/auth/authorization", () => ({
  authorize: (...args: unknown[]) => mockAuthorize(...args),
}));
vi.mock("@/lib/redaction", () => ({
  decryptRedactionMap: (...args: unknown[]) => mockDecryptRedactionMap(...args),
}));

interface QueryStub {
  match: (sql: string) => boolean;
  rows?: Record<string, unknown>[];
}

let queryQueue: QueryStub[] = [];

function pushStub(stub: QueryStub) {
  queryQueue.push(stub);
}

const authPool = {
  query: vi.fn(async () => ({ rows: [], rowCount: 0 })),
};

const customerPool = {
  query: vi.fn(async (sql: string) => {
    const idx = queryQueue.findIndex((s) => s.match(sql));
    if (idx === -1) return { rows: [], rowCount: 0 };
    const [stub] = queryQueue.splice(idx, 1);
    return { rows: stub.rows ?? [], rowCount: stub.rows?.length ?? 0 };
  }),
};

vi.mock("@/lib/db/client", () => ({
  getAuthPool: () => authPool,
  withTransaction: async (_pool: unknown, fn: (client: unknown) => unknown) =>
    fn({ query: vi.fn() }),
}));

vi.mock("@/lib/db/customer-runtime-pool", () => ({
  getCustomerRuntimePool: () => customerPool,
}));

const CUSTOMER_ID = "a0000000-0000-0000-0000-000000000001";
const AICE_ID = "aice-1";
const EVENT_KEY = "1001";

const baseInput = {
  customerId: CUSTOMER_ID,
  aiceId: AICE_ID,
  eventKey: EVENT_KEY,
  lang: "ENGLISH",
  modelName: "openai",
  model: "gpt-4o",
};

function pushResultRow(extras: Record<string, unknown> = {}) {
  pushStub({
    match: (s) => s.includes("FROM event_analysis_result"),
    rows: [
      {
        threat_score: 0.42,
        analysis_text: "attacker <<REDACTED_IP_001>> reached us",
        model_actual_version: null,
        prompt_version: null,
        requested_by: "acc-1",
        requested_at: new Date("2026-05-20T00:00:00Z"),
        ...extras,
      },
    ],
  });
}

function pushMapRow() {
  pushStub({
    match: (s) => s.includes("FROM event_redaction_map"),
    rows: [{ ciphertext: Buffer.from("ct"), wrapped_dek: "dek" }],
  });
}

function pushSourcePresent(exists: boolean) {
  pushStub({
    match: (s) => s.includes("FROM detection_events"),
    rows: [{ exists }],
  });
}

async function callLoader() {
  const mod = await import("../result-page-loader");
  return mod.loadAnalysisResultPage(baseInput);
}

beforeEach(() => {
  vi.resetModules();
  queryQueue = [];
  authPool.query.mockClear();
  customerPool.query.mockClear();
  mockGetAuthCookie.mockReset().mockResolvedValue("auth-token");
  mockVerifyJwtFull.mockReset().mockResolvedValue({ sub: "acc-1" });
  mockAuthorize.mockReset().mockResolvedValue({ authorized: true });
  mockDecryptRedactionMap.mockReset().mockResolvedValue({
    "<<REDACTED_IP_001>>": { kind: "ip", value: "10.0.0.1" },
  });
});

describe("loadAnalysisResultPage", () => {
  it("happy path: restores tokens and reports sourceEventPresent=true", async () => {
    pushResultRow();
    pushMapRow();
    pushSourcePresent(true);

    const outcome = await callLoader();
    expect(outcome.kind).toBe("ok");
    if (outcome.kind !== "ok") return;
    expect(outcome.data.analysisText).toBe("attacker 10.0.0.1 reached us");
    expect(outcome.data.sourceEventPresent).toBe(true);
    expect(outcome.data.threatScore).toBe(0.42);
  });

  it("cascade-edge: source detection_events swept, analysis + map survive", async () => {
    pushResultRow();
    pushMapRow();
    pushSourcePresent(false);

    const outcome = await callLoader();
    expect(outcome.kind).toBe("ok");
    if (outcome.kind !== "ok") return;
    // Tokens are still restored because the map row outlives the source
    // event per the RFC 0001 §"Retention" cascade rule.
    expect(outcome.data.analysisText).toBe("attacker 10.0.0.1 reached us");
    expect(outcome.data.sourceEventPresent).toBe(false);
  });

  it("returns not_found when the result row is missing", async () => {
    pushStub({
      match: (s) => s.includes("FROM event_analysis_result"),
      rows: [],
    });

    const outcome = await callLoader();
    expect(outcome.kind).toBe("not_found");
    expect(mockDecryptRedactionMap).not.toHaveBeenCalled();
  });

  it("returns unauthorized when the auth cookie is missing", async () => {
    mockGetAuthCookie.mockResolvedValue(null);
    const outcome = await callLoader();
    expect(outcome.kind).toBe("unauthorized");
    expect(customerPool.query).not.toHaveBeenCalled();
  });

  it("returns unauthorized when authorize() denies the caller", async () => {
    mockAuthorize.mockResolvedValue({ authorized: false });
    const outcome = await callLoader();
    expect(outcome.kind).toBe("unauthorized");
    // Loader must not query the customer DB if authorize denies — saves
    // a round-trip and avoids leaking row existence to a denied caller.
    expect(customerPool.query).not.toHaveBeenCalled();
  });

  it("falls back to raw token text when the map decrypt step fails", async () => {
    pushResultRow();
    pushMapRow();
    pushSourcePresent(true);
    mockDecryptRedactionMap.mockRejectedValue(new Error("KEK rotation race"));

    const outcome = await callLoader();
    expect(outcome.kind).toBe("ok");
    if (outcome.kind !== "ok") return;
    // No crash; the analysis renders with raw tokens. The operator can
    // retry once the vault outage / KEK rotation settles.
    expect(outcome.data.analysisText).toContain("<<REDACTED_IP_001>>");
  });

  it("passes through analysis text when there is no map row at all", async () => {
    pushResultRow({ analysis_text: "no entities here" });
    pushStub({
      match: (s) => s.includes("FROM event_redaction_map"),
      rows: [],
    });
    pushSourcePresent(true);

    const outcome = await callLoader();
    expect(outcome.kind).toBe("ok");
    if (outcome.kind !== "ok") return;
    expect(outcome.data.analysisText).toBe("no entities here");
    expect(mockDecryptRedactionMap).not.toHaveBeenCalled();
  });
});
