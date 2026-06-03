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
}));
vi.mock("@/lib/auth/session-policy", () => ({
  getSessionPolicy: (...args: unknown[]) => mockGetSessionPolicy(...args),
}));
vi.mock("@/lib/auth/session-validator", () => ({
  validateSession: (...args: unknown[]) => mockValidateSession(...args),
}));
vi.mock("@/lib/redaction", () => ({
  decryptRedactionMap: vi.fn(),
}));
vi.mock("../mitre-ttp", () => ({ lookupTtpName: () => null }));
vi.mock("../story-token-restore", () => ({
  restoreStoryAnalysisTokens: (s: string) => s,
}));

let stateRows: Array<{ status: string }> = [];
let resultRows: Array<Record<string, unknown>> = [];
// Member-event display rows returned for the `event_analysis_result`
// batch SELECT the loader runs to populate the story's member list (T2).
let eventDisplayRows: Array<Record<string, unknown>> = [];

const authPool = {
  query: vi.fn(async (sql: string) => {
    if (sql.includes("FROM story_analysis_state")) return { rows: stateRows };
    return { rows: [] };
  }),
};

const customerPool = {
  query: vi.fn(async (sql: string, _params?: unknown[]) => {
    if (sql.includes("FROM story_analysis_result")) return { rows: resultRows };
    if (sql.includes("FROM event_analysis_result")) {
      return { rows: eventDisplayRows };
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

async function callLoader(pin?: {
  generation: number;
  lang?: string;
  modelName?: string;
  model?: string;
}) {
  const mod = await import("../story-result-page-loader");
  return mod.loadStoryResultPage({
    customerId: CUSTOMER_ID,
    storyId: STORY_ID,
    pin,
  });
}

beforeEach(() => {
  vi.resetModules();
  authPool.query.mockClear();
  customerPool.query.mockClear();
  stateRows = [{ status: "ready" }];
  resultRows = [];
  eventDisplayRows = [];
  mockGetAuthCookie.mockReset().mockResolvedValue("auth-token");
  mockVerifyJwtFull
    .mockReset()
    .mockResolvedValue({ sub: "acc-1", sid: "sess-1" });
  mockAuthorize.mockReset().mockResolvedValue({ authorized: true });
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
