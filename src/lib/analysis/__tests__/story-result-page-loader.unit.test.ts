// Unit test for the story analysis result-page loader's generation/variant
// pin (T1 prerequisite, #395). A pinned generation resolves the EXACT
// pinned row at `(lang, model_name, model, generation)`; a missing or
// superseded pinned row reports `pin_unavailable` with no silent fallback
// to the latest generation. The unpinned path keeps latest-non-superseded
// behavior. Token restoration is stubbed to identity (no leaf refs needed).

import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const mockGetAuthCookie = vi.fn();
const mockVerifyJwtFull = vi.fn();
const mockAuthorize = vi.fn();
const mockIsAnalyst = vi.fn();
const mockGetSessionPolicy = vi.fn();
const mockValidateSession = vi.fn();

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
const mockDecryptRedactionMap = vi.fn();
vi.mock("@/lib/redaction", () => ({
  decryptRedactionMap: (...args: unknown[]) => mockDecryptRedactionMap(...args),
}));
vi.mock("../mitre-ttp", () => ({ lookupTtpName: () => null }));
// `restoreStoryAnalysisTokens` (the `E{i}` hop) is stubbed to a recognizable
// transform so a test can assert factors run through the SAME restore as the
// narrative body. `restoreStoryFactTokens` (the `F{k}` hop) is intentionally
// NOT mocked — its real implementation runs against the decrypted fact map.
vi.mock("../story-token-restore", () => ({
  restoreStoryAnalysisTokens: (s: string) =>
    s.replaceAll("<<REDACTED_IP_E1_001>>", "203.0.113.7"),
}));

let stateRows: Array<{ status: string }> = [];
let resultRows: Array<Record<string, unknown>> = [];
// Member-event display rows returned for the `event_analysis_result`
// batch SELECT the loader runs to populate the story's member list (T2).
let eventDisplayRows: Array<Record<string, unknown>> = [];
// Rows returned for the `enrichment_redaction_map` SELECT (the `F{k}`
// render-demap two-hop). Empty unless a test exercises fact restoration.
let factMapRows: Array<Record<string, unknown>> = [];

const authPool = {
  query: vi.fn(async (sql: string) => {
    if (sql.includes("FROM story_analysis_state")) return { rows: stateRows };
    return { rows: [] };
  }),
};

// The compare model used by the #458 compare tests. Routing the result
// SELECT by its `model` bind param lets one mock serve both the primary
// (default model) and the compare lookup distinctly; existing tests never use
// this value, so they keep returning `resultRows`.
const COMPARE_MODEL = "claude-compare";
let compareResultRows: Array<Record<string, unknown>> = [];

const customerPool = {
  query: vi.fn(async (sql: string, params?: unknown[]) => {
    if (sql.includes("FROM story_analysis_result")) {
      // Primary result params: [customerId, storyId, lang, modelName, model];
      // compare lookup binds the compare model at the same position.
      if (params?.[4] === COMPARE_MODEL) return { rows: compareResultRows };
      return { rows: resultRows };
    }
    if (sql.includes("FROM event_analysis_result")) {
      return { rows: eventDisplayRows };
    }
    if (sql.includes("FROM enrichment_redaction_map")) {
      return { rows: factMapRows };
    }
    return { rows: [] };
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
const STORY_ID = "12345";

function resultRow(extras: Record<string, unknown> = {}) {
  return {
    severity_score: 0.5,
    likelihood_score: 0.5,
    priority_tier: "HIGH",
    severity_factors: [],
    likelihood_factors: [],
    ttp_tags: [],
    analysis_text: "Narrative.",
    input_event_refs: [],
    model_actual_version: "2026-01",
    prompt_version: "v1",
    generation: 3,
    superseded_at: null,
    requested_by: null,
    requested_at: new Date("2026-05-27T12:00:00Z"),
    ...extras,
  };
}

async function callLoader(
  pin?: {
    generation: number;
    lang?: string;
    modelName?: string;
    model?: string;
  },
  variant?: { lang?: string; modelName?: string; model?: string },
) {
  const mod = await import("../story-result-page-loader");
  return mod.loadStoryResultPage({
    customerId: CUSTOMER_ID,
    storyId: STORY_ID,
    pin,
    variant,
  });
}

beforeEach(() => {
  vi.resetModules();
  authPool.query.mockClear();
  customerPool.query.mockClear();
  stateRows = [{ status: "ready" }];
  resultRows = [];
  compareResultRows = [];
  eventDisplayRows = [];
  factMapRows = [];
  mockDecryptRedactionMap.mockReset();
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
});

describe("loadStoryResultPage — generation/variant pin", () => {
  it("unpinned: loads the latest non-superseded row (existing behavior)", async () => {
    resultRows = [resultRow({ generation: 3 })];
    const outcome = await callLoader();
    expect(outcome.kind).toBe("ok");
    if (outcome.kind !== "ok") return;
    expect(outcome.data.generation).toBe(3);
  });

  it("pin: resolves the pinned variant and reports its generation/lang", async () => {
    resultRows = [resultRow({ generation: 2 })];
    const outcome = await callLoader({
      generation: 2,
      lang: "KOREAN",
      modelName: "openai",
      model: "gpt-4o",
    });
    expect(outcome.kind).toBe("ok");
    if (outcome.kind !== "ok") return;
    expect(outcome.data.generation).toBe(2);
    expect(outcome.data.lang).toBe("KOREAN");
    // The exact pinned generation was bound as a query param (not ORDER BY).
    const call = customerPool.query.mock.calls.find((c) =>
      String(c[0]).includes("FROM story_analysis_result"),
    );
    expect(String(call?.[0])).toContain("generation = $6");
    expect(call?.[1]).toEqual([
      CUSTOMER_ID,
      STORY_ID,
      "KOREAN",
      "openai",
      "gpt-4o",
      2,
    ]);
  });

  it("pin: missing pinned generation → pin_unavailable (no fallback to latest)", async () => {
    resultRows = []; // nothing at the pinned variant
    const outcome = await callLoader({ generation: 9 });
    expect(outcome.kind).toBe("pin_unavailable");
    if (outcome.kind !== "pin_unavailable") return;
    expect(outcome.generation).toBe(9);
  });

  it("pin: superseded pinned row → pin_unavailable", async () => {
    resultRows = [resultRow({ generation: 2, superseded_at: new Date() })];
    const outcome = await callLoader({ generation: 2 });
    expect(outcome.kind).toBe("pin_unavailable");
  });

  it("unpinned variant: opens the model selected by `?model_name=&model=` as the primary (#458)", async () => {
    // A model-only link (no generation) must open that model as the primary
    // column — latest non-superseded for `(lang, modelName, model)` — not the
    // env default. This is the gap the compare view depends on.
    resultRows = [resultRow({ generation: 4 })];
    const outcome = await callLoader(undefined, {
      lang: "KOREAN",
      modelName: "anthropic",
      model: "claude-3-5",
    });
    expect(outcome.kind).toBe("ok");
    if (outcome.kind !== "ok") return;
    expect(outcome.data.modelName).toBe("anthropic");
    expect(outcome.data.model).toBe("claude-3-5");
    expect(outcome.data.lang).toBe("KOREAN");
    // The primary SELECT bound the variant's model and ran unpinned (latest
    // non-superseded), with no `generation =` bind.
    const call = customerPool.query.mock.calls.find((c) =>
      String(c[0]).includes("FROM story_analysis_result"),
    );
    expect(call?.[1]).toEqual([
      CUSTOMER_ID,
      STORY_ID,
      "KOREAN",
      "anthropic",
      "claude-3-5",
    ]);
    expect(String(call?.[0])).toContain("superseded_at IS NULL");
    expect(String(call?.[0])).not.toContain("generation = $");
  });

  it("pin wins over an unpinned variant when both are present", async () => {
    // A generation pin already carries its own variant fields, so it takes
    // precedence over a stray `variant`.
    resultRows = [resultRow({ generation: 2 })];
    const outcome = await callLoader(
      { generation: 2, lang: "ENGLISH", modelName: "openai", model: "gpt-4o" },
      { lang: "KOREAN", modelName: "anthropic", model: "claude-3-5" },
    );
    expect(outcome.kind).toBe("ok");
    if (outcome.kind !== "ok") return;
    expect(outcome.data.modelName).toBe("openai");
    expect(outcome.data.lang).toBe("ENGLISH");
  });
});

describe("loadStoryResultPage — analyst gating (#457)", () => {
  it("exposes isViewerAnalyst from the analyst predicate", async () => {
    resultRows = [resultRow({ generation: 3 })];
    mockIsAnalyst.mockResolvedValue(true);
    const outcome = await callLoader();
    if (outcome.kind !== "ok") throw new Error("expected ok");
    expect(outcome.data.isViewerAnalyst).toBe(true);
    expect(outcome.data.canRegenerate).toBe(true);
  });

  it("canRegenerate=false for a bridge-session analyst (write-blocked)", async () => {
    // A bridge session passes the read authorize() but the regenerate
    // endpoint authorizes `operationKind: "write"`, which a bridge session
    // can never pass. So even an analyst account gets canRegenerate=false.
    resultRows = [resultRow({ generation: 3 })];
    mockIsAnalyst.mockResolvedValue(true);
    mockValidateSession.mockResolvedValue({
      bridgeAiceId: "aice-1",
      bridgeCustomerIds: [CUSTOMER_ID],
    });
    const outcome = await callLoader();
    if (outcome.kind !== "ok") throw new Error("expected ok");
    expect(outcome.data.isViewerAnalyst).toBe(true);
    expect(outcome.data.canRegenerate).toBe(false);
  });
});

describe("loadStoryResultPage — member events (T2 #396)", () => {
  it("returns members in ordinal order with display fields", async () => {
    // Refs arrive out of order; the loader must sort by member ordinal
    // (`index`), not array position, before rendering.
    resultRows = [
      resultRow({
        input_event_refs: [
          { index: 2, aiceId: "aice-b", eventKey: "20" },
          { index: 1, aiceId: "aice-a", eventKey: "10" },
        ],
      }),
    ];
    eventDisplayRows = [
      {
        aice_id: "aice-a",
        event_key: "10",
        priority_tier: "HIGH",
        severity_score: 0.6,
        likelihood_score: 0.7,
      },
      {
        aice_id: "aice-b",
        event_key: "20",
        priority_tier: "LOW",
        severity_score: 0.1,
        likelihood_score: 0.2,
      },
    ];
    const outcome = await callLoader();
    if (outcome.kind !== "ok") throw new Error("expected ok");
    expect(outcome.data.memberEvents.map((m) => m.index)).toEqual([1, 2]);
    expect(outcome.data.memberEvents[0]).toEqual({
      index: 1,
      aiceId: "aice-a",
      eventKey: "10",
      display: {
        priorityTier: "HIGH",
        severityScore: 0.6,
        likelihoodScore: 0.7,
      },
    });
    expect(outcome.data.memberEventVariant).toEqual({
      lang: "ENGLISH",
      modelName: "openai",
      model: "gpt-4o",
    });
  });

  it("degrades a member with no canonical event row to display: null", async () => {
    resultRows = [
      resultRow({
        input_event_refs: [{ index: 1, aiceId: "aice-a", eventKey: "10" }],
      }),
    ];
    eventDisplayRows = []; // no event row at the canonical variant
    const outcome = await callLoader();
    if (outcome.kind !== "ok") throw new Error("expected ok");
    expect(outcome.data.memberEvents).toEqual([
      { index: 1, aiceId: "aice-a", eventKey: "10", display: null },
    ]);
  });

  it("returns an empty member list when the story has no recorded members", async () => {
    resultRows = [resultRow({ input_event_refs: [] })];
    const outcome = await callLoader();
    if (outcome.kind !== "ok") throw new Error("expected ok");
    expect(outcome.data.memberEvents).toEqual([]);
  });
});

describe("loadStoryResultPage — score-factor token demap (#440)", () => {
  it("restores E{i} and F{k} tokens in factors, mirroring the narrative body", async () => {
    // A `fact_id`-keyed encrypted map for the single injected fact, decrypted
    // to the self-scoped entry the `F{k}` restore resolves against.
    factMapRows = [
      { fact_id: "7", ciphertext: Buffer.from("ct"), wrapped_dek: "dek" },
    ];
    mockDecryptRedactionMap.mockResolvedValue({
      "<<REDACTED_IP_001>>": { kind: "IP", value: "198.51.100.4" },
    });
    resultRows = [
      resultRow({
        // E-scope token in a severity factor → resolved by the (stubbed)
        // narrative `E{i}` restore, proving factors share that hop.
        severity_factors: ["beacon from <<REDACTED_IP_E1_001>>"],
        // F-scope token in a likelihood factor → resolved by the real
        // `F{k}` restore against the decrypted fact map.
        likelihood_factors: ["<<REDACTED_IP_F1_001>> flagged by feed"],
        input_fact_refs: [{ factId: "7", index: 1 }],
      }),
    ];

    const outcome = await callLoader();
    expect(outcome.kind).toBe("ok");
    if (outcome.kind !== "ok") return;
    expect(outcome.data.severityFactors).toEqual(["beacon from 203.0.113.7"]);
    expect(outcome.data.likelihoodFactors).toEqual([
      "198.51.100.4 flagged by feed",
    ]);
  });
});

describe("loadStoryResultPage — analyst compare column (#458)", () => {
  it("resolves an unpinned model-only compare variant for an analyst", async () => {
    mockIsAnalyst.mockResolvedValue(true);
    resultRows = [resultRow({ generation: 3 })];
    compareResultRows = [
      resultRow({ generation: 5, analysis_text: "Compared narrative." }),
    ];
    const mod = await import("../story-result-page-loader");
    const outcome = await mod.loadStoryResultPage({
      customerId: CUSTOMER_ID,
      storyId: STORY_ID,
      compare: { modelName: "anthropic", model: COMPARE_MODEL },
    });
    expect(outcome.kind).toBe("ok");
    if (outcome.kind !== "ok") return;
    expect(outcome.data.compare?.kind).toBe("ok");
    if (outcome.data.compare?.kind !== "ok") return;
    expect(outcome.data.compare.data.generation).toBe(5);
    expect(outcome.data.compare.data.model).toBe(COMPARE_MODEL);
    expect(outcome.data.compare.data.analysisText).toBe("Compared narrative.");
    // The compare lookup is an unpinned, latest-non-superseded SELECT — no
    // `generation =` bind, ordered by generation DESC.
    const compareCall = customerPool.query.mock.calls.find(
      (c) =>
        String(c[0]).includes("FROM story_analysis_result") &&
        (c[1] as unknown[])?.[4] === COMPARE_MODEL,
    );
    expect(String(compareCall?.[0])).toContain("superseded_at IS NULL");
    expect(String(compareCall?.[0])).not.toContain("generation = $");
  });

  it("returns not_generated when the compare variant has no stored row", async () => {
    mockIsAnalyst.mockResolvedValue(true);
    resultRows = [resultRow({ generation: 3 })];
    compareResultRows = [];
    const mod = await import("../story-result-page-loader");
    const outcome = await mod.loadStoryResultPage({
      customerId: CUSTOMER_ID,
      storyId: STORY_ID,
      compare: { modelName: "anthropic", model: COMPARE_MODEL },
    });
    expect(outcome.kind).toBe("ok");
    if (outcome.kind !== "ok") return;
    expect(outcome.data.compare).toEqual({
      kind: "not_generated",
      modelName: "anthropic",
      model: COMPARE_MODEL,
    });
  });

  it("ignores the compare variant for a non-analyst viewer", async () => {
    mockIsAnalyst.mockResolvedValue(false);
    resultRows = [resultRow({ generation: 3 })];
    compareResultRows = [resultRow({ generation: 5 })];
    const mod = await import("../story-result-page-loader");
    const outcome = await mod.loadStoryResultPage({
      customerId: CUSTOMER_ID,
      storyId: STORY_ID,
      compare: { modelName: "anthropic", model: COMPARE_MODEL },
    });
    expect(outcome.kind).toBe("ok");
    if (outcome.kind !== "ok") return;
    expect(outcome.data.compare).toBeUndefined();
    // The compare model was never queried.
    const compareCall = customerPool.query.mock.calls.find(
      (c) => (c[1] as unknown[])?.[4] === COMPARE_MODEL,
    );
    expect(compareCall).toBeUndefined();
  });
});
