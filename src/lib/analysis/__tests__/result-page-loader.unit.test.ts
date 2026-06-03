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

const mockLookupTtpName = vi.fn();
vi.mock("../mitre-ttp", () => ({
  lookupTtpName: (...args: unknown[]) => mockLookupTtpName(...args),
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
        severity_score: 0.42,
        likelihood_score: 0.81,
        priority_tier: "HIGH",
        severity_factors: ["broad blast radius"],
        likelihood_factors: ["lateral movement potential"],
        ttp_tags: ["T1078", "T9999"],
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

async function callLoaderPinned(generation: number) {
  const mod = await import("../result-page-loader");
  return mod.loadAnalysisResultPage({ ...baseInput, generation });
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
  mockLookupTtpName.mockReset().mockImplementation((id: string) => {
    if (id === "T1078") return "Valid Accounts";
    return null;
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
    expect(outcome.data.severityScore).toBe(0.42);
    expect(outcome.data.likelihoodScore).toBe(0.81);
    expect(outcome.data.priorityTier).toBe("HIGH");
    expect(outcome.data.severityFactors).toEqual(["broad blast radius"]);
    expect(outcome.data.likelihoodFactors).toEqual([
      "lateral movement potential",
    ]);
    // TTP IDs resolve via lookupTtpName — known IDs carry their name,
    // unknown IDs (legacy / vendor-rev drift) fall back to name=null.
    expect(outcome.data.ttpTags).toEqual([
      { id: "T1078", name: "Valid Accounts" },
      { id: "T9999", name: null },
    ]);
  });

  it("authorizes the read-only result page with the analyses:read permission key", async () => {
    // RFC 0001 + role seed split: viewing an existing analysis result is
    // a pure read, so it must gate on `analyses:read` rather than
    // `analyses:create`. Custom read-only roles that only carry the read
    // permission would otherwise be locked out of the result page even
    // though built-in roles happen to grant both keys today.
    pushResultRow();
    pushMapRow();
    pushSourcePresent(true);
    await callLoader();
    expect(mockAuthorize).toHaveBeenCalledWith(
      expect.anything(),
      "general",
      "acc-1",
      "analyses:read",
      expect.objectContaining({
        customerId: CUSTOMER_ID,
        aiceId: AICE_ID,
        operationKind: "read",
      }),
    );
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

  it("pin: loads the pinned generation and restores tokens", async () => {
    pushResultRow({ generation: 2, superseded_at: null });
    pushMapRow();
    pushSourcePresent(true);

    const outcome = await callLoaderPinned(2);
    expect(outcome.kind).toBe("ok");
    if (outcome.kind !== "ok") return;
    expect(outcome.data.analysisText).toBe("attacker 10.0.0.1 reached us");
  });

  it("pin: missing pinned generation → pin_unavailable (no fallback to latest)", async () => {
    // No row at the pinned generation. The loader must NOT fall back to the
    // latest generation — the card linked to an exact cited variant.
    pushStub({
      match: (s) => s.includes("FROM event_analysis_result"),
      rows: [],
    });

    const outcome = await callLoaderPinned(9);
    expect(outcome.kind).toBe("pin_unavailable");
    if (outcome.kind !== "pin_unavailable") return;
    expect(outcome.generation).toBe(9);
    // No token decrypt is attempted for an unavailable pin.
    expect(mockDecryptRedactionMap).not.toHaveBeenCalled();
  });

  it("pin: superseded pinned row → pin_unavailable", async () => {
    pushResultRow({ generation: 2, superseded_at: new Date() });

    const outcome = await callLoaderPinned(2);
    expect(outcome.kind).toBe("pin_unavailable");
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
