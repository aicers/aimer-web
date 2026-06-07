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
const mockIsAnalyst = vi.fn();
const mockGetSessionPolicy = vi.fn();
const mockValidateSession = vi.fn();
const mockDecryptRedactionMap = vi.fn();

vi.mock("@/lib/auth/cookies", () => ({
  getAuthCookie: (...args: unknown[]) => mockGetAuthCookie(...args),
}));
vi.mock("@/lib/auth/jwt", () => ({
  verifyJwtFull: (...args: unknown[]) => mockVerifyJwtFull(...args),
}));
vi.mock("@/lib/auth/authorization", () => ({
  authorize: (...args: unknown[]) => mockAuthorize(...args),
  isAnalystForCustomer: (...args: unknown[]) => mockIsAnalyst(...args),
}));
vi.mock("@/lib/auth/session-policy", () => ({
  getSessionPolicy: (...args: unknown[]) => mockGetSessionPolicy(...args),
}));
vi.mock("@/lib/auth/session-validator", () => ({
  validateSession: (...args: unknown[]) => mockValidateSession(...args),
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
  query: vi.fn(async (sql: string, _params?: unknown[]) => {
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
        generation: 1,
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
  mockVerifyJwtFull
    .mockReset()
    .mockResolvedValue({ sub: "acc-1", sid: "sess-1" });
  mockAuthorize.mockReset().mockResolvedValue({ authorized: true });
  mockIsAnalyst.mockReset().mockResolvedValue(false);
  mockGetSessionPolicy.mockReset().mockResolvedValue({ general: {} });
  mockValidateSession
    .mockReset()
    .mockResolvedValue({ bridgeAiceId: null, bridgeCustomerIds: null });
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

  it("surfaces parent stories (event→story backlink), newest-first", async () => {
    pushResultRow();
    pushMapRow();
    pushSourcePresent(true);
    pushStub({
      match: (s) => s.includes("FROM story_analysis_result"),
      rows: [
        {
          story_id: "300",
          generation: 4,
          priority_tier: "LOW",
          requested_at: new Date("2026-05-21T00:00:00Z"),
        },
        {
          story_id: "200",
          generation: 7,
          priority_tier: "HIGH",
          requested_at: new Date("2026-05-25T00:00:00Z"),
        },
      ],
    });

    const outcome = await callLoader();
    if (outcome.kind !== "ok") throw new Error("expected ok");
    // Newest-first by the kept row's requested_at (story 200 > 300). Each
    // carries the membership-matching generation the backlink pins.
    expect(outcome.data.parentStories).toEqual([
      { storyId: "200", generation: 7, priorityTier: "HIGH" },
      { storyId: "300", generation: 4, priorityTier: "LOW" },
    ]);
    // The reverse probe uses the story refs' camelCase keys, and the
    // lookup is scoped to the story page's default variant so the pinned
    // generation is one that variant can render.
    const call = customerPool.query.mock.calls.find((c) =>
      String(c[0]).includes("FROM story_analysis_result"),
    );
    expect(String(call?.[0])).toContain("lang = $3 AND model_name = $4");
    expect(JSON.parse(String(call?.[1]?.[1]))).toEqual([
      { aiceId: AICE_ID, eventKey: EVENT_KEY },
    ]);
    expect(call?.[1]?.slice(2)).toEqual(["ENGLISH", "openai", "gpt-4o"]);
  });

  it("reports no parent stories when the event is not a story member", async () => {
    pushResultRow();
    pushMapRow();
    pushSourcePresent(true);
    // No story_analysis_result stub → the default empty result.
    const outcome = await callLoader();
    if (outcome.kind !== "ok") throw new Error("expected ok");
    expect(outcome.data.parentStories).toEqual([]);
  });

  it("defaults isViewerAnalyst=false / canRegenerate=false for a non-analyst", async () => {
    pushResultRow();
    pushMapRow();
    pushSourcePresent(true);
    const outcome = await callLoader();
    if (outcome.kind !== "ok") throw new Error("expected ok");
    expect(outcome.data.isViewerAnalyst).toBe(false);
    expect(outcome.data.canRegenerate).toBe(false);
  });

  it("exposes isViewerAnalyst and canRegenerate for an analyst (no bridge)", async () => {
    mockIsAnalyst.mockResolvedValue(true);
    pushResultRow();
    pushMapRow();
    pushSourcePresent(true);
    const outcome = await callLoader();
    if (outcome.kind !== "ok") throw new Error("expected ok");
    expect(outcome.data.isViewerAnalyst).toBe(true);
    expect(outcome.data.canRegenerate).toBe(true);
  });

  it("canRegenerate=false for a bridge-session analyst (write-blocked)", async () => {
    // The event read loader allows bridge sessions, but the regenerate
    // endpoint authorizes a write, which a bridge session can never pass.
    // So even an analyst account gets canRegenerate=false (#463).
    mockIsAnalyst.mockResolvedValue(true);
    mockValidateSession.mockResolvedValue({
      bridgeAiceId: AICE_ID,
      bridgeCustomerIds: [CUSTOMER_ID],
    });
    pushResultRow();
    pushMapRow();
    pushSourcePresent(true);
    const outcome = await callLoader();
    if (outcome.kind !== "ok") throw new Error("expected ok");
    expect(outcome.data.isViewerAnalyst).toBe(true);
    expect(outcome.data.canRegenerate).toBe(false);
  });

  it("forwards the bridge scope to authorize for a bridge session", async () => {
    mockValidateSession.mockResolvedValue({
      bridgeAiceId: AICE_ID,
      bridgeCustomerIds: [CUSTOMER_ID],
    });
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
        bridgeScope: { aiceId: AICE_ID, customerIds: [CUSTOMER_ID] },
      }),
    );
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
