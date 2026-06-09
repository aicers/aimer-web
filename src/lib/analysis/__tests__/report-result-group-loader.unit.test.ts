// Group-subject path of the periodic report result-page loader (#525):
// subject-aware result-DB selection (via the #523 resolver), all-member
// `reports:read` authorization with existence-hiding (non-member → 404,
// member-without-permission → 403), bridge denial, `customer_groups.tz` +
// global/env default-model fallbacks, the stored-variants-only enqueue policy
// (no customer-keyed on-demand job for a group), and the compare column
// disabled for a group in v1. Token restoration is isolated to the fan-out
// unit test; here the cited refs are empty so the decision logic stands alone.

import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const mockGetAuthCookie = vi.fn();
const mockVerifyJwtFull = vi.fn();
const mockGetSessionPolicy = vi.fn();
const mockValidateSession = vi.fn();
const mockResolveGroupReadOutcome = vi.fn();
const mockResolveSubjectPools = vi.fn();
const mockEnqueue = vi.fn();

vi.mock("@/lib/auth/cookies", () => ({
  getAuthCookie: (...args: unknown[]) => mockGetAuthCookie(...args),
}));
vi.mock("@/lib/auth/jwt", () => ({
  verifyJwtFull: (...args: unknown[]) => mockVerifyJwtFull(...args),
}));
vi.mock("@/lib/auth/authorization", () => ({
  // The group path never calls these (it goes through resolveGroupReadOutcome);
  // stubbed so a regression that reaches them is obvious.
  authorize: vi.fn(async () => ({ authorized: false })),
  isAnalystForCustomer: vi.fn(async () => false),
}));
vi.mock("@/lib/auth/group-authorization", () => ({
  resolveGroupReadOutcome: (...args: unknown[]) =>
    mockResolveGroupReadOutcome(...args),
}));
vi.mock("@/lib/auth/session-policy", () => ({
  getSessionPolicy: (...args: unknown[]) => mockGetSessionPolicy(...args),
}));
vi.mock("@/lib/auth/session-validator", () => ({
  validateSession: (...args: unknown[]) => mockValidateSession(...args),
}));
vi.mock("../report-worker", () => ({
  enqueueOnDemandReportJob: (...args: unknown[]) => mockEnqueue(...args),
}));
vi.mock("../mitre-ttp", () => ({ lookupTtpName: () => null }));
vi.mock("../report-token", () => ({
  buildReportTokenMap: () => ({ refs: [] }),
}));
vi.mock("../report-token-restore", () => ({
  restoreReportAnalysisTokens: (s: string) => s,
}));
vi.mock("@/lib/db/subject-runtime-pool", () => ({
  resolveSubjectPools: (...args: unknown[]) => mockResolveSubjectPools(...args),
}));
vi.mock("@/lib/db/customer-runtime-pool", () => ({
  getCustomerRuntimePool: () => groupPool,
}));

const GROUP_ID = "70000000-0000-0000-0000-000000000001";
const MEMBER_A = "a0000000-0000-0000-0000-000000000001";
const MEMBER_B = "a0000000-0000-0000-0000-000000000002";

let stateRows: Array<{ status: string }> = [];
let availRows: Array<{ lang: string }> = [];
let resultRows: Array<Record<string, unknown>> = [];

const authPool = {
  query: vi.fn(async (sql: string) => {
    if (sql.includes("FROM customer_groups")) {
      return { rows: [{ tz: "Asia/Seoul" }] };
    }
    if (sql.includes("FROM periodic_report_state")) {
      return { rows: stateRows };
    }
    // system_settings / customer_default_model fall through to env default.
    return { rows: [] };
  }),
};

const groupPool = {
  query: vi.fn(async (sql: string) => {
    if (sql.includes("SELECT DISTINCT lang")) return { rows: availRows };
    if (sql.includes("model_actual_version")) return { rows: resultRows };
    return { rows: [] };
  }),
};

const memberPool = { query: vi.fn(async () => ({ rows: [] })) };

vi.mock("@/lib/db/client", () => ({
  getAuthPool: () => authPool,
  withTransaction: async (_pool: unknown, fn: (client: unknown) => unknown) =>
    fn({ query: vi.fn() }),
}));

function resultRow(lang: string): Record<string, unknown> {
  return {
    model_actual_version: "2026-01",
    prompt_version: "v1",
    generation: 2,
    lang,
    restoration_lang: null,
    model_name: "openai",
    model: "gpt-4o",
    priority_tier: "HIGH",
    aggregate_severity_score: 0.5,
    aggregate_likelihood_score: 0.5,
    aggregate_ttp_tags: [],
    sections_jsonb: {
      executive_summary: [{ text: "x" }],
      story_highlights: [],
      notable_events: [],
      baseline_observations: [],
      period_outlook: "y",
    },
    input_story_refs: [],
    input_event_refs: [],
    requested_by: null,
    requested_at: new Date("2026-05-27T12:00:00Z"),
  };
}

async function callLoader(input: {
  locale: string;
  variant?: { tz?: string; lang?: string };
  compare?: { model_name: string; model: string };
}) {
  const mod = await import("../report-result-page-loader");
  return mod.loadReportResultPage({
    customerId: GROUP_ID,
    subject: { kind: "group", id: GROUP_ID },
    period: "DAILY",
    bucketDate: "2026-05-26",
    locale: input.locale,
    variant: input.variant,
    compare: input.compare,
  });
}

beforeEach(() => {
  vi.resetModules();
  authPool.query.mockClear();
  groupPool.query.mockClear();
  memberPool.query.mockClear();
  stateRows = [{ status: "ready" }];
  availRows = [];
  resultRows = [];
  mockGetAuthCookie.mockReset().mockResolvedValue("auth-token");
  mockVerifyJwtFull
    .mockReset()
    .mockResolvedValue({ sub: "acc-1", sid: "sess-1" });
  mockGetSessionPolicy.mockReset().mockResolvedValue({ general: {} });
  mockValidateSession
    .mockReset()
    .mockResolvedValue({ bridgeAiceId: null, bridgeCustomerIds: null });
  mockResolveGroupReadOutcome.mockReset().mockResolvedValue("authorized");
  mockResolveSubjectPools.mockReset().mockResolvedValue({
    kind: "group",
    resultPool: groupPool,
    memberPools: [
      { customerId: MEMBER_A, pool: memberPool },
      { customerId: MEMBER_B, pool: memberPool },
    ],
  });
  mockEnqueue.mockReset().mockResolvedValue({ action: "seeded" });
});

describe("loadReportResultPage — group authorization (#525)", () => {
  it("non-member → not_found (existence-hiding)", async () => {
    mockResolveGroupReadOutcome.mockResolvedValue("not_found");
    const outcome = await callLoader({ locale: "en" });
    expect(outcome.kind).toBe("not_found");
  });

  it("member without reports:read → forbidden", async () => {
    mockResolveGroupReadOutcome.mockResolvedValue("forbidden");
    const outcome = await callLoader({ locale: "en" });
    expect(outcome.kind).toBe("forbidden");
  });

  it("bridge session → forbidden (allowInBridge not loosened for groups)", async () => {
    mockValidateSession.mockResolvedValue({
      bridgeAiceId: "aice-1",
      bridgeCustomerIds: [MEMBER_A, MEMBER_B],
    });
    const outcome = await callLoader({ locale: "en" });
    expect(outcome.kind).toBe("forbidden");
    // The all-member predicate is short-circuited by the bridge denial.
    expect(mockResolveGroupReadOutcome).not.toHaveBeenCalled();
  });

  it("checks reports:read on every member via the all-member helper", async () => {
    availRows = [{ lang: "ENGLISH" }];
    resultRows = [resultRow("ENGLISH")];
    await callLoader({ locale: "en" });
    expect(mockResolveGroupReadOutcome).toHaveBeenCalledWith(
      expect.anything(),
      "acc-1",
      [MEMBER_A, MEMBER_B],
      "reports:read",
    );
  });

  it("an unresolvable subject degrades to not_found", async () => {
    mockResolveSubjectPools.mockRejectedValue(new Error("unknown subject"));
    const outcome = await callLoader({ locale: "en" });
    expect(outcome.kind).toBe("not_found");
  });
});

describe("loadReportResultPage — group variant defaults (#525)", () => {
  it("uses customer_groups.tz and selects the group result DB", async () => {
    availRows = [{ lang: "ENGLISH" }];
    resultRows = [resultRow("ENGLISH")];
    const outcome = await callLoader({ locale: "en" });
    expect(outcome.kind).toBe("ok");
    if (outcome.kind !== "ok") return;
    expect(outcome.data.tz).toBe("Asia/Seoul");
    // The result-DB read goes to the resolver-selected group pool.
    expect(groupPool.query).toHaveBeenCalled();
    // The subject id (group id) is surfaced as `customerId` and the result row
    // was read for that subject.
    expect(outcome.data.customerId).toBe(GROUP_ID);
    // No single-customer analyst signal applies → compare gate stays closed.
    expect(outcome.data.isViewerAnalyst).toBe(false);
  });

  it("does NOT enqueue an on-demand job on language fallback (stored-only)", async () => {
    // Korean requested, only English stored → fallback, but a group must not
    // call the customer-keyed enqueue (policy (a)).
    availRows = [{ lang: "ENGLISH" }];
    resultRows = [resultRow("ENGLISH")];
    const outcome = await callLoader({ locale: "ko" });
    expect(outcome.kind).toBe("ok");
    if (outcome.kind !== "ok") return;
    expect(outcome.data.languageFallback).not.toBeNull();
    expect(outcome.data.languageFallback?.jobStatus).toBeNull();
    expect(mockEnqueue).not.toHaveBeenCalled();
  });

  it("disables the analyst compare column for a group in v1", async () => {
    availRows = [{ lang: "ENGLISH" }];
    resultRows = [resultRow("ENGLISH")];
    const outcome = await callLoader({
      locale: "en",
      compare: { model_name: "anthropic", model: "claude" },
    });
    expect(outcome.kind).toBe("ok");
    if (outcome.kind !== "ok") return;
    expect(outcome.data.compare).toBeUndefined();
  });
});

describe("loadReportResultPage — group citation member-disambiguation (#525)", () => {
  it("decodes a citation source to the OWNING member's ref (not a same-story_id collision)", async () => {
    // Two cited stories with the IDENTICAL story_id but different owning
    // members — the whole reason refs gained `customer_id` (#523). The citation
    // points at member A's story (generation 7), which is listed FIRST, so a
    // bare-key ref map (last-write-wins on "555") would wrongly resolve it to
    // member B's generation 9. The member-qualified key must route by
    // `customer_id` and recover A's generation 7.
    availRows = [{ lang: "ENGLISH" }];
    const row = resultRow("ENGLISH");
    row.input_story_refs = [
      { story_id: "555", generation: 7, customer_id: MEMBER_A },
      { story_id: "555", generation: 9, customer_id: MEMBER_B },
    ];
    row.sections_jsonb = {
      executive_summary: [
        {
          text: "claim citing member A's story",
          source: { type: "story", story_id: "555", customer_id: MEMBER_A },
        },
      ],
      story_highlights: [],
      notable_events: [],
      baseline_observations: [],
      period_outlook: "y",
    };
    resultRows = [row];

    const outcome = await callLoader({ locale: "en" });
    expect(outcome.kind).toBe("ok");
    if (outcome.kind !== "ok") return;
    const source = outcome.data.sections.executive_summary[0]?.source;
    expect(source?.sourceType).toBe("story");
    if (source?.sourceType !== "story") return;
    // Member A's ref is generation 7 — a bare-key collision would have picked
    // B's shadowing generation 9.
    expect(source.storyId).toBe("555");
    expect(source.variant.generation).toBe(7);
  });
});
