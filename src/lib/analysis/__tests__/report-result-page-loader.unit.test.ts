// Unit test for the periodic report result-page loader's L2 language logic
// (#388): viewer-locale default, `?lang ∈ {en, ko}` validation, the
// requested → English → any-available fallback chain, the per-bucket
// available-language set, and the phase-2 on-demand enqueue + job-status
// mapping. Token restoration (the redaction replay) is exercised by the
// report-token / db tests; here the cited-leaf refs are empty so the loader's
// decision logic is isolated from the decrypt path.

import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const mockGetAuthCookie = vi.fn();
const mockVerifyJwtFull = vi.fn();
const mockAuthorize = vi.fn();
const mockIsAnalyst = vi.fn();
const mockGetSessionPolicy = vi.fn();
const mockValidateSession = vi.fn();
const mockEnqueue = vi.fn();

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
vi.mock("../report-worker", () => ({
  enqueueOnDemandReportJob: (...args: unknown[]) => mockEnqueue(...args),
}));
vi.mock("../mitre-ttp", () => ({ lookupTtpName: () => null }));
// Keep restoration a no-op identity: the refs are empty so nothing is
// actually replayed, but stubbing avoids pulling the redaction modules in.
vi.mock("../report-token", () => ({
  buildReportTokenMap: () => ({ refs: [] }),
}));
vi.mock("../report-token-restore", () => ({
  restoreReportAnalysisTokens: (s: string) => s,
}));

// --- pool stubs (auth + customer DB), routed by SQL fragment ------------
let stateRows: Array<{ status: string }> = [];
let availRows: Array<{ lang: string }> = [];
let resultRows: Array<Record<string, unknown>> = [];
// Per-leaf rows returned for the cited-source display-field SELECTs.
let storyLeafRows: Array<Record<string, unknown>> = [];
let eventLeafRows: Array<Record<string, unknown>> = [];

const authPool = {
  query: vi.fn(async (sql: string) => {
    if (sql.includes("FROM customers")) {
      return { rows: [{ timezone: "Asia/Seoul" }] };
    }
    if (sql.includes("FROM periodic_report_state")) {
      return { rows: stateRows };
    }
    return { rows: [] };
  }),
};

// The compare model used by the #458 compare tests. Routing the result SELECT
// by its `model` bind param ($7) lets one mock serve both the primary and the
// compare lookup distinctly; existing tests never use this value.
const COMPARE_MODEL = "claude-compare";
let compareResultRows: Array<Record<string, unknown>> = [];

const customerPool = {
  query: vi.fn(async (sql: string, params?: unknown[]) => {
    if (sql.includes("SELECT DISTINCT lang")) return { rows: availRows };
    if (sql.includes("model_actual_version")) {
      // Primary/compare result params: [customerId, period, bucketDate, tz,
      // lang, modelName, model]; the compare lookup binds the compare model.
      if (params?.[6] === COMPARE_MODEL) return { rows: compareResultRows };
      return { rows: resultRows };
    }
    // Order matters: the main result SELECT also names story/event tables
    // in passing, but it is matched above via `model_actual_version`. These
    // are the per-leaf display-field SELECTs in `buildReportTokenPlaintext`.
    if (sql.includes("FROM story_analysis_result")) {
      return { rows: storyLeafRows };
    }
    if (sql.includes("FROM event_analysis_result")) {
      return { rows: eventLeafRows };
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

function resultRow(lang: string): Record<string, unknown> {
  return {
    model_actual_version: "2026-01",
    prompt_version: "v1",
    generation: 3,
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
    customerId: CUSTOMER_ID,
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
  customerPool.query.mockClear();
  stateRows = [{ status: "ready" }];
  availRows = [];
  resultRows = [];
  compareResultRows = [];
  storyLeafRows = [];
  eventLeafRows = [];
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
  mockEnqueue.mockReset().mockResolvedValue({ action: "seeded" });
});

describe("loadReportResultPage — L2 language resolution", () => {
  it("defaults to the viewer's locale and shows it when available", async () => {
    availRows = [{ lang: "ENGLISH" }, { lang: "KOREAN" }];
    resultRows = [resultRow("KOREAN")];

    const outcome = await callLoader({ locale: "ko" });
    expect(outcome.kind).toBe("ok");
    if (outcome.kind !== "ok") return;
    expect(outcome.data.lang).toBe("KOREAN");
    expect(outcome.data.requestedLocale).toBe("ko");
    expect(outcome.data.availableLocales.sort()).toEqual(["en", "ko"]);
    expect(outcome.data.languageFallback).toBeNull();
    // The requested variant exists, so no on-demand job is enqueued.
    expect(mockEnqueue).not.toHaveBeenCalled();
  });

  it("falls back to English and enqueues the requested language on-demand", async () => {
    // Korean viewer, only English generated → English shown with a fallback
    // notice + a queued on-demand job for Korean.
    availRows = [{ lang: "ENGLISH" }];
    resultRows = [resultRow("ENGLISH")];
    mockEnqueue.mockResolvedValue({ action: "seeded" });

    const outcome = await callLoader({ locale: "ko" });
    expect(outcome.kind).toBe("ok");
    if (outcome.kind !== "ok") return;
    expect(outcome.data.lang).toBe("ENGLISH");
    expect(outcome.data.languageFallback).toEqual({
      requestedLocale: "ko",
      shownLocale: "en",
      jobStatus: "queued",
    });
    // The enqueue targets the KOREAN enum mapped from the `ko` locale.
    expect(mockEnqueue).toHaveBeenCalledTimes(1);
    expect(mockEnqueue.mock.calls[0][1]).toMatchObject({ lang: "KOREAN" });
  });

  it("reflects a coalesced job's existing status in the fallback", async () => {
    availRows = [{ lang: "ENGLISH" }];
    resultRows = [resultRow("ENGLISH")];
    mockEnqueue.mockResolvedValue({
      action: "coalesced",
      status: "processing",
    });

    const outcome = await callLoader({ locale: "ko" });
    if (outcome.kind !== "ok") throw new Error("expected ok");
    expect(outcome.data.languageFallback?.jobStatus).toBe("processing");
  });

  it("maps source_pending to a no-job pending status (no spinner)", async () => {
    availRows = [{ lang: "ENGLISH" }];
    resultRows = [resultRow("ENGLISH")];
    mockEnqueue.mockResolvedValue({ action: "source_pending" });

    const outcome = await callLoader({ locale: "ko" });
    if (outcome.kind !== "ok") throw new Error("expected ok");
    expect(outcome.data.languageFallback?.jobStatus).toBe("source_pending");
  });

  it("degrades to a notice without job status when the enqueue throws", async () => {
    // A transient enqueue failure must not 500 the page: the English fallback
    // still renders, just without the on-demand progress banner (jobStatus
    // null), and the read-only poller retries on the next view.
    availRows = [{ lang: "ENGLISH" }];
    resultRows = [resultRow("ENGLISH")];
    mockEnqueue.mockRejectedValue(new Error("db down"));

    const outcome = await callLoader({ locale: "ko" });
    if (outcome.kind !== "ok") throw new Error("expected ok");
    expect(outcome.data.lang).toBe("ENGLISH");
    expect(outcome.data.languageFallback).toEqual({
      requestedLocale: "ko",
      shownLocale: "en",
      jobStatus: null,
    });
  });

  it("honors a pinned ?lang=ko even when the viewer locale is en", async () => {
    availRows = [{ lang: "ENGLISH" }, { lang: "KOREAN" }];
    resultRows = [resultRow("KOREAN")];

    const outcome = await callLoader({ locale: "en", variant: { lang: "ko" } });
    if (outcome.kind !== "ok") throw new Error("expected ok");
    expect(outcome.data.requestedLocale).toBe("ko");
    expect(outcome.data.lang).toBe("KOREAN");
    expect(outcome.data.languageFallback).toBeNull();
  });

  it("treats a legacy enum-shaped ?lang=KOREAN as unpinned (viewer default)", async () => {
    // Only `en`/`ko` are valid `?lang` values; `KOREAN` is dropped and the
    // viewer-locale default (`en`) is used, so no fallback occurs and no
    // job is enqueued — the regression the validate-before-map guard avoids.
    availRows = [{ lang: "ENGLISH" }];
    resultRows = [resultRow("ENGLISH")];

    const outcome = await callLoader({
      locale: "en",
      variant: { lang: "KOREAN" },
    });
    if (outcome.kind !== "ok") throw new Error("expected ok");
    expect(outcome.data.requestedLocale).toBe("en");
    expect(outcome.data.lang).toBe("ENGLISH");
    expect(outcome.data.languageFallback).toBeNull();
    expect(mockEnqueue).not.toHaveBeenCalled();
  });

  it("returns pending when no variant exists for the bucket yet", async () => {
    availRows = [];
    resultRows = [];

    const outcome = await callLoader({ locale: "ko" });
    expect(outcome.kind).toBe("pending");
    // No per-language job is enqueued while the bucket's first generation is
    // still in flight (the pending case, not a spinner).
    expect(mockEnqueue).not.toHaveBeenCalled();
  });

  it("returns not_found for an archived bucket", async () => {
    stateRows = [{ status: "archived" }];
    const outcome = await callLoader({ locale: "ko" });
    expect(outcome.kind).toBe("not_found");
  });

  it("returns unauthorized when the auth cookie is missing", async () => {
    mockGetAuthCookie.mockResolvedValue(null);
    const outcome = await callLoader({ locale: "ko" });
    expect(outcome.kind).toBe("unauthorized");
  });
});

describe("loadReportResultPage — cited sources (T1)", () => {
  // The batched leaf read (#525) re-associates each row with its ref by
  // `(story_id|aice_id+event_key, generation, model_name, model)`, so the
  // stub rows carry those key columns matching the refs the tests cite
  // (story 555 / event aice-9:777, generation 2 / 4, model openai/gpt-4o).
  function storyLeaf(extras: Record<string, unknown> = {}) {
    return {
      analysis_text: "",
      severity_factors: [],
      likelihood_factors: [],
      input_event_refs: [],
      priority_tier: "HIGH",
      severity_score: 0.6,
      likelihood_score: 0.7,
      ttp_tags: ["T1078"],
      superseded_at: null,
      story_id: "555",
      generation: 2,
      model_name: "openai",
      model: "gpt-4o",
      ...extras,
    };
  }
  function eventLeaf(extras: Record<string, unknown> = {}) {
    return {
      analysis_text: "",
      severity_factors: [],
      likelihood_factors: [],
      priority_tier: "MEDIUM",
      severity_score: 0.4,
      likelihood_score: 0.5,
      ttp_tags: [],
      superseded_at: null,
      aice_id: "aice-9",
      event_key: "777",
      event_time: new Date("2026-05-20T00:00:00Z"),
      kind: "HttpThreat",
      generation: 4,
      model_name: "openai",
      model: "gpt-4o",
      ...extras,
    };
  }

  it("exposes story/event refs + display fields fetched at the pinned variant", async () => {
    availRows = [{ lang: "ENGLISH" }];
    resultRows = [
      {
        ...resultRow("ENGLISH"),
        input_story_refs: [
          {
            story_id: "555",
            generation: 2,
            model_name: "openai",
            model: "gpt-4o",
            customer_id: CUSTOMER_ID,
          },
        ],
        input_event_refs: [
          {
            aice_id: "aice-9",
            event_key: "777",
            generation: 4,
            model_name: "openai",
            model: "gpt-4o",
            customer_id: CUSTOMER_ID,
          },
        ],
      },
    ];
    storyLeafRows = [storyLeaf()];
    eventLeafRows = [eventLeaf()];

    const outcome = await callLoader({ locale: "en" });
    if (outcome.kind !== "ok") throw new Error("expected ok");
    expect(outcome.data.citedSources.stories).toEqual([
      {
        storyId: "555",
        customerId: CUSTOMER_ID,
        variant: {
          generation: 2,
          lang: "ENGLISH",
          modelName: "openai",
          model: "gpt-4o",
        },
        display: {
          priorityTier: "HIGH",
          severityScore: 0.6,
          likelihoodScore: 0.7,
          // lookupTtpName is stubbed to null in this suite.
          ttpTags: [{ id: "T1078", name: null }],
        },
      },
    ]);
    expect(outcome.data.citedSources.events).toEqual([
      {
        aiceId: "aice-9",
        eventKey: "777",
        customerId: CUSTOMER_ID,
        variant: {
          generation: 4,
          lang: "ENGLISH",
          modelName: "openai",
          model: "gpt-4o",
        },
        // Event-level fields read off the resolved leaf row (#552).
        eventTime: new Date("2026-05-20T00:00:00Z"),
        kind: "HttpThreat",
        display: {
          priorityTier: "MEDIUM",
          severityScore: 0.4,
          likelihoodScore: 0.5,
        },
      },
    ]);
  });

  it("degrades a card to ID/generation when the pinned leaf row is superseded", async () => {
    availRows = [{ lang: "ENGLISH" }];
    resultRows = [
      {
        ...resultRow("ENGLISH"),
        input_story_refs: [
          {
            story_id: "555",
            generation: 2,
            model_name: "openai",
            model: "gpt-4o",
            customer_id: CUSTOMER_ID,
          },
        ],
        input_event_refs: [],
      },
    ];
    storyLeafRows = [storyLeaf({ superseded_at: new Date() })];

    const outcome = await callLoader({ locale: "en" });
    if (outcome.kind !== "ok") throw new Error("expected ok");
    const story = outcome.data.citedSources.stories[0];
    // The ID + pinned generation survive; the display fields do not.
    expect(story.storyId).toBe("555");
    expect(story.variant.generation).toBe(2);
    expect(story.display).toBeNull();
  });

  it("degrades a card to ID/generation when the pinned leaf row is missing", async () => {
    availRows = [{ lang: "ENGLISH" }];
    resultRows = [
      {
        ...resultRow("ENGLISH"),
        input_story_refs: [
          {
            story_id: "555",
            generation: 9,
            model_name: "openai",
            model: "gpt-4o",
            customer_id: CUSTOMER_ID,
          },
        ],
        input_event_refs: [],
      },
    ];
    storyLeafRows = []; // no row at the pinned variant

    const outcome = await callLoader({ locale: "en" });
    if (outcome.kind !== "ok") throw new Error("expected ok");
    expect(outcome.data.citedSources.stories[0].display).toBeNull();
    expect(outcome.data.citedSources.stories[0].variant.generation).toBe(9);
  });

  it("resolves cited leaves via restoration_lang for a translated report", async () => {
    // Korean translated row carries restoration_lang=ENGLISH and points at
    // the English canonical's leaves; the display fetch + link variant must
    // use ENGLISH, not the row's own KOREAN lang (#395 translated path).
    availRows = [{ lang: "KOREAN" }];
    resultRows = [
      {
        ...resultRow("KOREAN"),
        restoration_lang: "ENGLISH",
        input_story_refs: [
          {
            story_id: "555",
            generation: 2,
            model_name: "openai",
            model: "gpt-4o",
            customer_id: CUSTOMER_ID,
          },
        ],
        input_event_refs: [],
      },
    ];
    storyLeafRows = [storyLeaf()];

    const outcome = await callLoader({ locale: "ko" });
    if (outcome.kind !== "ok") throw new Error("expected ok");
    // The Sources link variant resolves to the canonical English leaf.
    expect(outcome.data.citedSources.stories[0].variant.lang).toBe("ENGLISH");
    // And the batched leaf SELECT was issued with lang=ENGLISH. The story read
    // binds `[customer_id, lang, ...tuples]` (#525), so the language is $2.
    const leafCall = customerPool.query.mock.calls.find((c) =>
      String(c[0]).includes("FROM story_analysis_result"),
    );
    expect(leafCall?.[1]?.[1]).toBe("ENGLISH");
  });
});

describe("loadReportResultPage — sentence-level citations (#449)", () => {
  it("decodes story/event unit sources and pins them to the leaf variant", async () => {
    availRows = [{ lang: "ENGLISH" }];
    resultRows = [
      {
        ...resultRow("ENGLISH"),
        input_story_refs: [
          {
            story_id: "555",
            generation: 2,
            model_name: "openai",
            model: "gpt-4o",
            customer_id: CUSTOMER_ID,
          },
        ],
        input_event_refs: [
          {
            aice_id: "aice-9",
            event_key: "777",
            generation: 4,
            model_name: "openai",
            model: "gpt-4o",
            customer_id: CUSTOMER_ID,
          },
        ],
        sections_jsonb: {
          executive_summary: [
            {
              text: "story claim",
              source: { type: "story", story_id: "555" },
            },
            { text: "uncited synthesis" },
          ],
          story_highlights: [],
          notable_events: [
            {
              text: "event claim",
              source: { type: "event", event_ref: "aice-9:777" },
            },
          ],
          baseline_observations: [],
          period_outlook: "y",
        },
      },
    ];

    const outcome = await callLoader({ locale: "en" });
    if (outcome.kind !== "ok") throw new Error("expected ok");
    const exec = outcome.data.sections.executive_summary;
    expect(exec).toHaveLength(2);
    expect(exec[0]).toEqual({
      text: "story claim",
      source: {
        sourceType: "story",
        storyId: "555",
        customerId: CUSTOMER_ID,
        variant: {
          generation: 2,
          lang: "ENGLISH",
          modelName: "openai",
          model: "gpt-4o",
        },
      },
    });
    // The uncited unit keeps its text but carries no source.
    expect(exec[1]).toEqual({ text: "uncited synthesis" });

    const events = outcome.data.sections.notable_events;
    expect(events[0]).toEqual({
      text: "event claim",
      source: {
        sourceType: "event",
        aiceId: "aice-9",
        eventKey: "777",
        customerId: CUSTOMER_ID,
        variant: {
          generation: 4,
          lang: "ENGLISH",
          modelName: "openai",
          model: "gpt-4o",
        },
      },
    });
  });

  it("drops a citation whose source is not in the input refs (no dangling link)", async () => {
    availRows = [{ lang: "ENGLISH" }];
    resultRows = [
      {
        ...resultRow("ENGLISH"),
        input_story_refs: [
          {
            story_id: "555",
            generation: 2,
            model_name: "openai",
            model: "gpt-4o",
            customer_id: CUSTOMER_ID,
          },
        ],
        input_event_refs: [],
        sections_jsonb: {
          executive_summary: [
            // story 999 is not in the refs → the citation is dropped, the
            // text still renders.
            {
              text: "claim with stale source",
              source: { type: "story", story_id: "999" },
            },
          ],
          story_highlights: [],
          notable_events: [],
          baseline_observations: [],
          period_outlook: "y",
        },
      },
    ];

    const outcome = await callLoader({ locale: "en" });
    if (outcome.kind !== "ok") throw new Error("expected ok");
    expect(outcome.data.sections.executive_summary).toEqual([
      { text: "claim with stale source" },
    ]);
  });

  it("pins a translated report's citation to the canonical (restoration_lang) variant", async () => {
    availRows = [{ lang: "KOREAN" }];
    resultRows = [
      {
        ...resultRow("KOREAN"),
        restoration_lang: "ENGLISH",
        input_story_refs: [
          {
            story_id: "555",
            generation: 2,
            model_name: "openai",
            model: "gpt-4o",
            customer_id: CUSTOMER_ID,
          },
        ],
        input_event_refs: [],
        sections_jsonb: {
          executive_summary: [
            { text: "번역된 주장", source: { type: "story", story_id: "555" } },
          ],
          story_highlights: [],
          notable_events: [],
          baseline_observations: [],
          period_outlook: "y",
        },
      },
    ];

    const outcome = await callLoader({ locale: "ko" });
    if (outcome.kind !== "ok") throw new Error("expected ok");
    const source = outcome.data.sections.executive_summary[0].source;
    expect(source?.variant.lang).toBe("ENGLISH");
  });

  it("yields no units for a malformed (non-citation-unit) leaf-derived section", async () => {
    // Strict prompt-v5 shape: a leaf-derived section is an array of
    // `{ text, source? }` units. A non-array value or a non-object entry is
    // malformed and yields no units — it is not reconstructed into prose.
    availRows = [{ lang: "ENGLISH" }];
    resultRows = [
      {
        ...resultRow("ENGLISH"),
        sections_jsonb: {
          executive_summary: "plain prose",
          story_highlights: ["plain entry"],
          notable_events: [],
          baseline_observations: [],
          period_outlook: "y",
        },
      },
    ];

    const outcome = await callLoader({ locale: "en" });
    if (outcome.kind !== "ok") throw new Error("expected ok");
    expect(outcome.data.sections.executive_summary).toEqual([]);
    expect(outcome.data.sections.story_highlights).toEqual([]);
  });
});

describe("loadReportResultPage — generation pin (T2 cited-by)", () => {
  async function callPinned(opts: {
    locale: string;
    lang?: string;
    generation: number;
  }) {
    const mod = await import("../report-result-page-loader");
    return mod.loadReportResultPage({
      customerId: CUSTOMER_ID,
      period: "DAILY",
      bucketDate: "2026-05-26",
      locale: opts.locale,
      variant: { lang: opts.lang },
      generation: opts.generation,
    });
  }

  it("resolves the exact pinned generation, no fallback / no enqueue", async () => {
    availRows = [{ lang: "ENGLISH" }];
    resultRows = [
      { ...resultRow("ENGLISH"), generation: 2, superseded_at: null },
    ];
    const outcome = await callPinned({
      locale: "ko",
      lang: "en",
      generation: 2,
    });
    if (outcome.kind !== "ok") throw new Error("expected ok");
    expect(outcome.data.generation).toBe(2);
    expect(outcome.data.languageFallback).toBeNull();
    // The pin must not trigger the on-demand enqueue even though the
    // viewer's locale (ko) differs from the pinned language (en).
    expect(mockEnqueue).not.toHaveBeenCalled();
    // The pinned query carries the generation as its 8th positional param.
    const pinnedCall = customerPool.query.mock.calls.find((c) =>
      String(c[0]).includes("AND generation = $8"),
    );
    expect(pinnedCall?.[1]?.[7]).toBe(2);
  });

  it("returns pin_unavailable when the pinned generation row is missing", async () => {
    availRows = [{ lang: "ENGLISH" }];
    resultRows = [];
    const outcome = await callPinned({ locale: "en", generation: 9 });
    expect(outcome.kind).toBe("pin_unavailable");
    if (outcome.kind === "pin_unavailable") expect(outcome.generation).toBe(9);
  });

  it("returns pin_unavailable when the pinned generation row is superseded", async () => {
    availRows = [{ lang: "ENGLISH" }];
    resultRows = [
      { ...resultRow("ENGLISH"), generation: 2, superseded_at: new Date() },
    ];
    const outcome = await callPinned({ locale: "en", generation: 2 });
    expect(outcome.kind).toBe("pin_unavailable");
  });
});

describe("loadReportResultPage — analyst compare column (#458)", () => {
  it("resolves the compare variant at the shown language for an analyst", async () => {
    mockIsAnalyst.mockResolvedValue(true);
    availRows = [{ lang: "ENGLISH" }];
    resultRows = [resultRow("ENGLISH")];
    compareResultRows = [
      {
        ...resultRow("ENGLISH"),
        model_name: "anthropic",
        model: COMPARE_MODEL,
        generation: 7,
      },
    ];

    const outcome = await callLoader({
      locale: "en",
      compare: { model_name: "anthropic", model: COMPARE_MODEL },
    });
    expect(outcome.kind).toBe("ok");
    if (outcome.kind !== "ok") return;
    expect(outcome.data.compare?.kind).toBe("ok");
    if (outcome.data.compare?.kind !== "ok") return;
    expect(outcome.data.compare.data.model).toBe(COMPARE_MODEL);
    expect(outcome.data.compare.data.generation).toBe(7);
    // The compare lookup must be a read-only EXACT SELECT — never an enqueue.
    expect(mockEnqueue).not.toHaveBeenCalled();
    const compareCall = customerPool.query.mock.calls.find(
      (c) =>
        String(c[0]).includes("model_actual_version") &&
        (c[1] as unknown[])?.[6] === COMPARE_MODEL,
    );
    expect(String(compareCall?.[0])).toContain("superseded_at IS NULL");
  });

  it("returns not_generated for an unstored compare variant and does NOT enqueue", async () => {
    mockIsAnalyst.mockResolvedValue(true);
    availRows = [{ lang: "ENGLISH" }];
    resultRows = [resultRow("ENGLISH")];
    compareResultRows = []; // compare model has no stored row

    const outcome = await callLoader({
      locale: "en",
      compare: { model_name: "anthropic", model: COMPARE_MODEL },
    });
    expect(outcome.kind).toBe("ok");
    if (outcome.kind !== "ok") return;
    expect(outcome.data.compare).toEqual({
      kind: "not_generated",
      modelName: "anthropic",
      model: COMPARE_MODEL,
    });
    // Regression guard: the read-only compare path must never enqueue a job,
    // unlike the primary loader's language-fallback path.
    expect(mockEnqueue).not.toHaveBeenCalled();
  });

  it("degrades a compare ref naming a foreign customer_id to an empty leaf", async () => {
    mockIsAnalyst.mockResolvedValue(true);
    availRows = [{ lang: "ENGLISH" }];
    resultRows = [resultRow("ENGLISH")];
    // Two compare event refs: one carrying the customer's own id, one naming
    // a foreign id — a malformed persisted ref on the customer-only compare
    // path, where every ref carries the subject's own id.
    compareResultRows = [
      {
        ...resultRow("ENGLISH"),
        model_name: "anthropic",
        model: COMPARE_MODEL,
        generation: 7,
        input_event_refs: [
          {
            aice_id: "aice-9",
            event_key: "777",
            generation: 4,
            model_name: "anthropic",
            model: COMPARE_MODEL,
            customer_id: CUSTOMER_ID,
          },
          {
            aice_id: "aice-9",
            event_key: "888",
            generation: 4,
            model_name: "anthropic",
            model: COMPARE_MODEL,
            customer_id: "b0000000-0000-0000-0000-000000000002",
          },
        ],
      },
    ];

    const outcome = await callLoader({
      locale: "en",
      compare: { model_name: "anthropic", model: COMPARE_MODEL },
    });
    expect(outcome.kind).toBe("ok");
    if (outcome.kind !== "ok") return;
    expect(outcome.data.compare?.kind).toBe("ok");
    // Exactly one batched event-leaf read: the own-id group. The foreign-id
    // ref must resolve no pool and degrade to an empty leaf — the primary
    // path's contract — never reach the event leaf query, which carries no
    // customer_id predicate (the member identity IS the pool).
    const leafCalls = customerPool.query.mock.calls.filter((c) =>
      String(c[0]).includes("FROM event_analysis_result"),
    );
    expect(leafCalls).toHaveLength(1);
    expect(leafCalls[0]?.[1]).toContain("777");
    expect(leafCalls[0]?.[1]).not.toContain("888");
  });

  it("ignores the compare variant for a non-analyst viewer", async () => {
    mockIsAnalyst.mockResolvedValue(false);
    availRows = [{ lang: "ENGLISH" }];
    resultRows = [resultRow("ENGLISH")];
    compareResultRows = [
      { ...resultRow("ENGLISH"), model: COMPARE_MODEL, generation: 7 },
    ];

    const outcome = await callLoader({
      locale: "en",
      compare: { model_name: "anthropic", model: COMPARE_MODEL },
    });
    expect(outcome.kind).toBe("ok");
    if (outcome.kind !== "ok") return;
    expect(outcome.data.compare).toBeUndefined();
    const compareCall = customerPool.query.mock.calls.find(
      (c) => (c[1] as unknown[])?.[6] === COMPARE_MODEL,
    );
    expect(compareCall).toBeUndefined();
  });
});
