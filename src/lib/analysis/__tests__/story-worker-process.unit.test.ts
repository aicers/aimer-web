// RFC 0002 Phase 1 (#296) — focused tests for `processStoryJob`.
//
// Drives the worker via dependency injection (no real Pool). Locks in:
//   - happy-path commit ordering (customer-DB INSERT then auth-DB finalize)
//   - pickup-time result-row probe skips the LLM and finalizes
//   - precondition splits: missing vs mismatched redaction_policy_version
//   - hallucination scan blocks storage and fails the job
//   - retryable aimer error requeues with attempts++ and stamps last_error
//   - retry-cap exhaustion flips to failed without re-queue
//   - fatal 4xx fails the job immediately

import { ClientError } from "graphql-request";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("@/lib/audit", () => ({ auditLog: vi.fn(async () => {}) }));
vi.mock("@/lib/db/customer-db", () => ({
  customerLockId: () => 1,
}));
vi.mock("@/lib/db/customer-runtime-pool", () => ({
  getCustomerRuntimePool: () => ({ query: vi.fn(), connect: vi.fn() }),
}));
vi.mock("@/lib/graphql/client", () => ({
  graphqlRequest: vi.fn(),
}));

import { processStoryJob } from "../story-worker";

interface QueryCall {
  sql: string;
  params?: readonly unknown[];
}

interface MockPool {
  query: ReturnType<typeof vi.fn>;
  connect: ReturnType<typeof vi.fn>;
  __calls: QueryCall[];
}

type QueryFn = (sql: string, params?: readonly unknown[]) => Promise<unknown>;

function recordingQuery(plan: Array<unknown>): QueryFn {
  let i = 0;
  return async (_sql, _params) => {
    const next = plan[i++];
    if (next instanceof Error) throw next;
    if (next === undefined) return { rows: [] };
    return next;
  };
}

function makePool(opts: {
  queryPlan: Array<unknown>;
  clientQueryPlan?: Array<unknown>;
}): MockPool {
  const calls: QueryCall[] = [];
  const wrappedQuery = recordingQuery(opts.queryPlan);
  const query = vi.fn(async (sql: string, params?: readonly unknown[]) => {
    calls.push({ sql, params });
    return wrappedQuery(sql, params);
  });
  const clientQuery = opts.clientQueryPlan
    ? recordingQuery(opts.clientQueryPlan)
    : vi.fn(async () => ({ rows: [] }));
  const client = {
    query: vi.fn(async (sql: string, params?: readonly unknown[]) => {
      calls.push({ sql, params });
      return clientQuery(sql, params);
    }),
    release: vi.fn(),
  };
  const connect = vi.fn(async () => client);
  const pool: MockPool = {
    query,
    connect,
    __calls: calls,
  };
  return pool;
}

function baseJob() {
  return {
    customer_id: "c0000000-0000-0000-0000-000000000001",
    story_id: "12345",
    lang: "ENGLISH",
    model_name: "openai",
    model: "gpt-4o",
    generation: 1,
    attempts: 0,
    force_requested_at: null,
    force_requested_by: null,
  };
}

function goodMembersQuery(
  opts: { knownIocHit?: boolean } = {},
): Array<unknown> {
  const knownIocHit = opts.knownIocHit ?? false;
  return [
    {
      rows: [
        {
          story_version: "v1",
          source_aice_id: "aice-1",
          known_ioc_hit: knownIocHit,
          time_window_start: new Date("2026-05-01T00:00:00.000Z"),
          time_window_end: new Date("2026-05-01T02:00:00.000Z"),
        },
      ],
    },
    {
      rows: [
        {
          story_id: "12345",
          story_version: "v1",
          member_event_key: "1001",
          source_aice_id: "aice-1",
          role: "primary",
          event: { ip: "<<REDACTED_IP_001>>" },
          redaction_policy_version: "engine:1.0|ranges:abc",
          event_time: new Date("2026-05-01T00:30:00.000Z"),
        },
        {
          story_id: "12345",
          story_version: "v1",
          member_event_key: "1002",
          source_aice_id: "aice-1",
          role: "context",
          event: { ip: "<<REDACTED_IP_002>>" },
          redaction_policy_version: "engine:1.0|ranges:abc",
          event_time: new Date("2026-05-01T01:30:00.000Z"),
        },
      ],
    },
  ];
}

function goodAimerResponse() {
  return {
    severityScore: 0.7,
    likelihoodScore: 0.5,
    severityFactors: ["lateral movement signals", "privileged account use"],
    likelihoodFactors: ["multiple correlated events"],
    ttpTags: ["T1078"],
    analysis: "Suspicious lateral movement involving <<REDACTED_IP_E1_001>>.",
    promptVersion: "story-v3",
    modelActualVersion: "gpt-4o-2024-08-06",
  };
}

// A live English-canonical `story_analysis_result` row, as
// `loadStoryEnglishCanonical` reads it (#580). Scores/tier/TTP/refs are copied
// verbatim onto the translated row; `analysis_text` + factors are the
// translate-mutation input.
function canonicalResultRow() {
  return {
    analysis_text:
      "Suspicious lateral movement involving <<REDACTED_IP_E1_001>>.",
    severity_factors: ["lateral movement signals", "privileged account use"],
    likelihood_factors: ["multiple correlated events"],
    severity_score: 0.7,
    likelihood_score: 0.5,
    ttp_tags: ["T1078"],
    priority_tier: "MEDIUM",
    input_event_refs: [{ index: 1, aiceId: "aice-1", eventKey: "1001" }],
    input_fact_refs: [],
    model_actual_version: "gpt-4o-2024-08-06",
    prompt_version: "story-v3",
    input_hash: "deadbeef",
    redaction_policy_version: "engine:1.0|ranges:abc",
  };
}

function sqlIncludes(pool: MockPool, fragment: string): QueryCall | undefined {
  return pool.__calls.find((c) => c.sql.includes(fragment));
}

// Default test stub for the customer redaction-range loader. The
// production path queries the auth pool, but the unit tests treat the
// auth pool as a script of expected statements, so we short-circuit
// the load and return an empty `RangeSet`. The hallucination-scan
// behavior under non-empty ranges has dedicated tests below.
const emptyRangesLoader = async () => ({
  normalisedCidrs: [],
  ranges: [],
});

// Default test stub for the owned-domain loader (RFC 0001 Amendment
// A.2). Same rationale as `emptyRangesLoader`: the scripted auth pool
// must not see the production `customer_owned_domains` SELECT. Owned-
// domain leak behaviour has dedicated coverage in story-token.unit.test.
const emptyDomainsLoader = async () => ({ normalisedSuffixes: [] });

describe("processStoryJob — happy path", () => {
  beforeEach(() => vi.clearAllMocks());

  it("marks processing, probes, calls aimer, writes result, and finalizes", async () => {
    const authPool = makePool({
      queryPlan: [
        { rows: [], rowCount: 1 }, // UPDATE → processing
        { rows: [], rowCount: 1 }, // UPDATE → done (finalize)
      ],
    });
    const customerPool = makePool({
      queryPlan: [
        { rows: [] }, // probe — no existing result row
        ...goodMembersQuery(),
      ],
      clientQueryPlan: [
        { rows: [] }, // BEGIN
        { rows: [] }, // INSERT result
        { rows: [] }, // UPDATE supersede
        { rows: [] }, // COMMIT
      ],
    });
    interface LlmArgs {
      members: Array<{
        ordinal: number;
        role: string;
        eventTime: string;
        event: string;
      }>;
      storyMetadata: {
        storyId: string;
        firstSeenAt: string;
        lastSeenAt: string;
        memberCount: number;
        roleDistribution: Array<{ role: string; count: number }>;
      };
    }
    const llmCalls: LlmArgs[] = [];
    const callAnalyzeStory = async (args: LlmArgs) => {
      llmCalls.push(args);
      return goodAimerResponse();
    };

    await processStoryJob(baseJob(), {
      authPool: authPool as never,
      checkEnrichmentReady: async () => ({ ready: true, knownIocHit: false }),
      callAnalyzeStory: callAnalyzeStory as never,
      resolveCustomerPool: () => customerPool as never,
      loadRanges: emptyRangesLoader as never,
      loadOwnedDomains: emptyDomainsLoader as never,
    });

    expect(llmCalls).toHaveLength(1);
    const sent = llmCalls[0];
    // Structured members with 1-based ordinals that match the embedded
    // `E{i}` tokens (RFC 0002 #344).
    expect(sent.members.map((m) => m.ordinal)).toEqual([1, 2]);
    // Tokens must be rewritten to story-scope before the LLM sees them.
    expect(sent.members[0].event).toContain("<<REDACTED_IP_E1_001>>");
    expect(sent.members[1].event).toContain("<<REDACTED_IP_E2_002>>");
    expect(sent.members[0].event).not.toMatch(/<<REDACTED_IP_001>>/);
    // Per-member metadata + structured storyMetadata satisfy aimer's
    // `validate_story_inputs` invariants.
    expect(sent.members.map((m) => m.role)).toEqual(["primary", "context"]);
    expect(sent.members[0].eventTime).toBe("2026-05-01T00:30:00.000Z");
    expect(sent.storyMetadata.storyId).toBe("12345");
    expect(sent.storyMetadata.memberCount).toBe(2);
    expect(sent.storyMetadata.firstSeenAt).toBe("2026-05-01T00:00:00.000Z");
    expect(sent.storyMetadata.lastSeenAt).toBe("2026-05-01T02:00:00.000Z");
    expect(sent.storyMetadata.roleDistribution).toEqual([
      { role: "primary", count: 1 },
      { role: "context", count: 1 },
    ]);

    // Finalize must target the captured generation, not a re-queue.
    const finalize = authPool.__calls.find((c) =>
      c.sql.includes("status = 'done'"),
    );
    expect(finalize).toBeDefined();

    // Result INSERT runs before finalize (commit-ordering invariant).
    const insertCall = customerPool.__calls.find((c) =>
      c.sql.includes("INSERT INTO story_analysis_result"),
    );
    expect(insertCall).toBeDefined();
    // priority_tier from severity=0.7, likelihood=0.5 → MEDIUM. With
    // 2 members the floor doesn't fire (default N=5).
    const tierParam = insertCall?.params?.[13];
    expect(tierParam).toBe("MEDIUM");

    // WS3 (#392): finalize also denormalizes the canonical variant's
    // priority + raw scores onto `story_analysis_state` (the default
    // variant in baseJob()). priority_tier=MEDIUM, severity=0.7,
    // likelihood=0.5 (raw, floor inactive at 2 members).
    const stateUpdate = authPool.__calls.find((c) =>
      c.sql.includes("UPDATE story_analysis_state"),
    );
    expect(stateUpdate).toBeDefined();
    expect(stateUpdate?.params?.[2]).toBe("MEDIUM");
    expect(stateUpdate?.params?.[3]).toBe(0.7);
    expect(stateUpdate?.params?.[4]).toBe(0.5);
  });

  it("translates a user-language (KOREAN) variant from the English canonical without mirroring (WS3 #392 / #580)", async () => {
    // A user-language variant is ALWAYS translated from the English canonical
    // (#580): it copies the canonical's numeric scores / tier / TTP / refs
    // verbatim and translates only the narrative + factor phrases. It is never
    // the canonical, so it must NOT write the `story_analysis_state` mirror —
    // otherwise a secondary variant's scores would clobber the canonical row.
    const authPool = makePool({
      queryPlan: [
        {
          rows: [{ processing_started_at: "2026-06-13T00:00:00.000Z" }],
          rowCount: 1,
        }, // claim
        { rows: [], rowCount: 1 }, // recordStoryTranslationAudit
        { rows: [], rowCount: 1 }, // finalizeTranslatedJob → done
      ],
    });
    const customerPool = makePool({
      queryPlan: [
        { rows: [] }, // probe — no existing translated row
        { rows: [canonicalResultRow()] }, // loadStoryEnglishCanonical
        ...goodMembersQuery(), // loadCanonicalMembers (story + members)
      ],
      clientQueryPlan: [
        { rows: [] }, // BEGIN
        { rows: [] }, // INSERT translated result
        { rows: [] }, // UPDATE supersede
        { rows: [] }, // COMMIT
      ],
    });
    const translateCalls: Array<{
      analysis: string;
      severityFactors: string[];
      likelihoodFactors: string[];
      targetLang: string;
    }> = [];
    const callTranslateAnalysisNarrative = async (args: {
      analysis: string;
      severityFactors: string[];
      likelihoodFactors: string[];
      targetLang: string;
    }) => {
      translateCalls.push(args);
      return {
        analysis: "한국어 분석 <<REDACTED_IP_E1_001>>.",
        severityFactors: ["측면 이동 신호", "권한 계정 사용"],
        likelihoodFactors: ["상관된 다수 이벤트"],
        promptVersion: "translate-v1",
        modelActualVersion: "gpt-4o-2024-08-06",
      };
    };

    await processStoryJob(
      { ...baseJob(), lang: "KOREAN" },
      {
        authPool: authPool as never,
        callTranslateAnalysisNarrative: callTranslateAnalysisNarrative as never,
        resolveCustomerPool: () => customerPool as never,
        loadRanges: emptyRangesLoader as never,
        loadOwnedDomains: emptyDomainsLoader as never,
        loadEnrichmentFacts: async () => [],
      },
    );

    // The canonical's English narrative + factors were sent to the translate
    // mutation (scores are language-invariant and not sent).
    expect(translateCalls).toHaveLength(1);
    expect(translateCalls[0].targetLang).toBe("KOREAN");
    expect(translateCalls[0].severityFactors).toEqual([
      "lateral movement signals",
      "privileged account use",
    ]);

    // The job still finalizes (status='done' on the job table)...
    const finalize = authPool.__calls.find((c) =>
      c.sql.includes("status = 'done'"),
    );
    expect(finalize).toBeDefined();
    // ...but the denormalization mirror update never fires for KOREAN.
    const stateUpdate = authPool.__calls.find((c) =>
      c.sql.includes("UPDATE story_analysis_state"),
    );
    expect(stateUpdate).toBeUndefined();

    // The translated row copies the canonical's scores/tier verbatim and pins
    // restoration_lang = ENGLISH, storing the translated narrative + factors.
    const insertCall = customerPool.__calls.find((c) =>
      c.sql.includes("INSERT INTO story_analysis_result"),
    );
    expect(insertCall).toBeDefined();
    // Column order: $4 restoration_lang, $10 severity_score, $11 likelihood,
    // $12 severity_factors, $15 priority_tier, $16 analysis_text.
    expect(insertCall?.params?.[3]).toBe("ENGLISH");
    expect(insertCall?.params?.[9]).toBe(0.7); // canonical severity
    expect(insertCall?.params?.[10]).toBe(0.5); // canonical likelihood
    expect(insertCall?.params?.[14]).toBe("MEDIUM"); // canonical tier
    expect(JSON.parse(insertCall?.params?.[11] as string)).toEqual([
      "측면 이동 신호",
      "권한 계정 사용",
    ]);
    expect(insertCall?.params?.[15]).toContain("한국어 분석");
  });

  it("does NOT mirror priority when the finalize matched zero rows (regenerate race, WS3 #392)", async () => {
    // The finalize UPDATE is guarded on `generation = $captured AND status =
    // 'processing'`. If a force-regenerate raced ahead while the LLM call was
    // in flight, the auth row is already a newer generation, so the guarded
    // update matches zero rows. This generation's result is therefore already
    // (or about to be) superseded — publishing its priority/scores would show
    // a stale, superseded generation as the canonical denormalized priority on
    // the Threat Stories list until the newer job finishes. The mirror write
    // must be skipped; the newer generation mirrors its own values.
    const authPool = makePool({
      queryPlan: [
        { rows: [], rowCount: 1 }, // UPDATE → processing
        { rows: [], rowCount: 0 }, // finalize → zero rows (regenerate raced)
      ],
    });
    const customerPool = makePool({
      queryPlan: [
        { rows: [] }, // probe — no existing result row
        ...goodMembersQuery(),
      ],
      clientQueryPlan: [
        { rows: [] }, // BEGIN
        { rows: [] }, // INSERT result
        { rows: [] }, // UPDATE supersede
        { rows: [] }, // COMMIT
      ],
    });
    const callAnalyzeStory = async () => goodAimerResponse();

    await processStoryJob(baseJob(), {
      authPool: authPool as never,
      checkEnrichmentReady: async () => ({ ready: true, knownIocHit: false }),
      callAnalyzeStory: callAnalyzeStory as never,
      resolveCustomerPool: () => customerPool as never,
      loadRanges: emptyRangesLoader as never,
      loadOwnedDomains: emptyDomainsLoader as never,
    });

    // The customer-DB result INSERT still ran (the work was done)...
    const insertCall = customerPool.__calls.find((c) =>
      c.sql.includes("INSERT INTO story_analysis_result"),
    );
    expect(insertCall).toBeDefined();
    // ...and the finalize was attempted (it just matched no row)...
    const finalize = authPool.__calls.find((c) =>
      c.sql.includes("status = 'done'"),
    );
    expect(finalize).toBeDefined();
    // ...but for this default variant the mirror update must NOT fire, since
    // the captured generation lost the finalize race.
    const stateUpdate = authPool.__calls.find((c) =>
      c.sql.includes("UPDATE story_analysis_state"),
    );
    expect(stateUpdate).toBeUndefined();
  });
});

describe("processStoryJob — cross-language supersede on canonical re-gen (#580)", () => {
  beforeEach(() => vi.clearAllMocks());

  it("supersedes lower-generation rows of ANY language when the new English canonical lands", async () => {
    // Stale-user-language-row invariant (#580). A force/dirty regeneration
    // produces a new English canonical at a higher generation, but the matching
    // user-language translation may still be in flight — or fail permanently on
    // a 4xx / factor-shape / leak. If the native English write superseded only
    // its OWN language (the prior contract), the previous Korean row would stay
    // `superseded_at IS NULL` and both the reader and the report input builder
    // would keep serving stale generation-N Korean scores instead of falling
    // back to the new canonical. The native write must therefore supersede
    // EVERY lower-generation row of this `(customer, story, model)` variant,
    // regardless of language, so the stale translated row is gone the moment the
    // canonical lands — independent of whether the replacement translation ever
    // succeeds.
    const authPool = makePool({
      queryPlan: [
        { rows: [], rowCount: 1 }, // UPDATE → processing
        { rows: [], rowCount: 1 }, // UPDATE → done (finalize)
      ],
    });
    const customerPool = makePool({
      queryPlan: [
        { rows: [] }, // probe — no existing result row at this generation
        ...goodMembersQuery(),
      ],
      clientQueryPlan: [
        { rows: [] }, // BEGIN
        { rows: [] }, // INSERT result
        { rows: [] }, // UPDATE supersede
        { rows: [] }, // COMMIT
      ],
    });
    const callAnalyzeStory = async () => goodAimerResponse();

    // Force-regenerate to a higher generation (the new English canonical).
    await processStoryJob(
      {
        ...baseJob(),
        generation: 2,
        force_requested_at: new Date("2026-06-13T00:00:00.000Z"),
        force_requested_by: "00000000-0000-0000-0000-0000000000ff",
      },
      {
        authPool: authPool as never,
        checkEnrichmentReady: async () => ({ ready: true, knownIocHit: false }),
        callAnalyzeStory: callAnalyzeStory as never,
        resolveCustomerPool: () => customerPool as never,
        loadRanges: emptyRangesLoader as never,
        loadOwnedDomains: emptyDomainsLoader as never,
      },
    );

    const supersede = sqlIncludes(customerPool, "SET superseded_at");
    expect(supersede).toBeDefined();
    // The WHERE clause must NOT scope by language — that is the whole fix.
    expect(supersede?.sql).not.toMatch(/lang\s*=/);
    // It still scopes by the model variant and bumps only LOWER generations
    // (the same-generation translated row, derived from this canonical, is
    // written afterward and must not be touched).
    expect(supersede?.sql).toContain("model_name = $3 AND model = $4");
    expect(supersede?.sql).toContain("generation < $5");
    expect(supersede?.params?.[4]).toBe(2);
  });
});

describe("processStoryJob — input_hash canonical bundle (#344)", () => {
  beforeEach(() => vi.clearAllMocks());

  // RFC 0002 defines `input_hash` as the sha256 of the canonical LLM
  // input — "members + metadata + refs". A member's `event_time` is part
  // of that input (it becomes `members[].eventTime`) but does NOT appear
  // in `rewrittenMembers` (which holds only token-rewritten event bodies).
  // Hashing `rewrittenMembers` alone would collide two runs that differ
  // only in event-time/role/metadata and defeat drift attribution, so the
  // hash must cover the structured payload. This locks that in: a run
  // whose only change is a member `event_time` must produce a different
  // `input_hash`.
  async function runAndCaptureInputHash(secondEventTime: string) {
    const authPool = makePool({
      queryPlan: [
        { rows: [], rowCount: 1 }, // UPDATE → processing
        { rows: [], rowCount: 1 }, // UPDATE → done (finalize)
      ],
    });
    const members = goodMembersQuery();
    // Override only the second member's event_time. The event bodies (and
    // thus `rewrittenMembers`) are untouched.
    (members[1] as { rows: Array<{ event_time: Date }> }).rows[1].event_time =
      new Date(secondEventTime);
    const customerPool = makePool({
      queryPlan: [{ rows: [] }, ...members],
      clientQueryPlan: [
        { rows: [] }, // BEGIN
        { rows: [] }, // INSERT result
        { rows: [] }, // UPDATE supersede
        { rows: [] }, // COMMIT
      ],
    });
    await processStoryJob(baseJob(), {
      authPool: authPool as never,
      checkEnrichmentReady: async () => ({ ready: true, knownIocHit: false }),
      callAnalyzeStory: (async () => goodAimerResponse()) as never,
      resolveCustomerPool: () => customerPool as never,
      loadRanges: emptyRangesLoader as never,
      loadOwnedDomains: emptyDomainsLoader as never,
    });
    const insertCall = customerPool.__calls.find((c) =>
      c.sql.includes("INSERT INTO story_analysis_result"),
    );
    // input_hash is param 17 after `input_fact_refs` (#440) was inserted
    // between `input_event_refs` (15) and `input_hash`.
    return insertCall?.params?.[17] as string;
  }

  it("changes input_hash when only a member event_time differs", async () => {
    const hashA = await runAndCaptureInputHash("2026-05-01T01:30:00.000Z");
    const hashB = await runAndCaptureInputHash("2026-05-01T01:45:00.000Z");
    expect(hashA).toBeTruthy();
    expect(hashB).toBeTruthy();
    expect(hashA).not.toBe(hashB);
  });

  // RFC 0003 C1 (#440) — the redacted enrichment-fact text is folded into
  // `input_hash`. Two runs with identical members/refs but different fact
  // wording/classification feed the LLM different input and MUST hash
  // differently — refs alone are insufficient (same fact_ids, different
  // bodies).
  async function runAndCaptureFactHashAndRefs(
    facts: Array<{ factId: string; text: string }>,
  ): Promise<{ hash: string; factRefs: string }> {
    const authPool = makePool({
      queryPlan: [
        { rows: [], rowCount: 1 },
        { rows: [], rowCount: 1 },
      ],
    });
    const customerPool = makePool({
      queryPlan: [{ rows: [] }, ...goodMembersQuery()],
      clientQueryPlan: [{ rows: [] }, { rows: [] }, { rows: [] }, { rows: [] }],
    });
    await processStoryJob(baseJob(), {
      authPool: authPool as never,
      checkEnrichmentReady: async () => ({ ready: true, knownIocHit: false }),
      callAnalyzeStory: (async () => goodAimerResponse()) as never,
      resolveCustomerPool: () => customerPool as never,
      loadRanges: emptyRangesLoader as never,
      loadOwnedDomains: emptyDomainsLoader as never,
      loadEnrichmentFacts: async () => facts,
    });
    const insertCall = customerPool.__calls.find((c) =>
      c.sql.includes("INSERT INTO story_analysis_result"),
    );
    return {
      hash: insertCall?.params?.[17] as string,
      factRefs: insertCall?.params?.[16] as string,
    };
  }

  it("folds enrichmentFacts into input_hash and writes input_fact_refs", async () => {
    const a = await runAndCaptureFactHashAndRefs([
      { factId: "100", text: "1.2.3.4 is listed by abuse.ch/feodo as c2" },
    ]);
    // Same fact_id (so same refs), different wording/classification.
    const b = await runAndCaptureFactHashAndRefs([
      {
        factId: "100",
        text: "1.2.3.4 is listed by abuse.ch/feodo as botnet",
      },
    ]);
    expect(a.hash).not.toBe(b.hash);
    // input_fact_refs is persisted (the ordered k -> fact_id mapping).
    expect(JSON.parse(a.factRefs)).toEqual([{ index: 1, factId: "100" }]);
  });

  it("input_hash is identical across runs with the same members and facts", async () => {
    const a = await runAndCaptureFactHashAndRefs([
      { factId: "100", text: "1.2.3.4 is listed by abuse.ch/feodo as c2" },
    ]);
    const b = await runAndCaptureFactHashAndRefs([
      { factId: "100", text: "1.2.3.4 is listed by abuse.ch/feodo as c2" },
    ]);
    expect(a.hash).toBe(b.hash);
  });
});

describe("processStoryJob — known_ioc_hit floor wiring (#330)", () => {
  beforeEach(() => vi.clearAllMocks());

  // Score pair chosen so the floor crosses a 2-tier boundary:
  //   severity=0.85, raw likelihood=0.3 → buckets (3, 0) → MEDIUM
  //   floored likelihood=0.95            → buckets (3, 3) → CRITICAL
  // The on-disk `likelihood_score` always holds the raw value (0.3),
  // never the floored one — that is the calibration-preserving
  // invariant from RFC 0002 §"Priority tiering".
  const SEVERITY = 0.85;
  const RAW_LIKELIHOOD = 0.3;

  it("known_ioc_hit=false: floor does not fire, tier=MEDIUM, raw likelihood stored", async () => {
    const authPool = makePool({
      queryPlan: [
        { rows: [], rowCount: 1 },
        { rows: [], rowCount: 1 },
      ],
    });
    const customerPool = makePool({
      queryPlan: [{ rows: [] }, ...goodMembersQuery({ knownIocHit: false })],
      clientQueryPlan: [{ rows: [] }, { rows: [] }, { rows: [] }, { rows: [] }],
    });
    const callAnalyzeStory = async () => ({
      ...goodAimerResponse(),
      severityScore: SEVERITY,
      likelihoodScore: RAW_LIKELIHOOD,
    });

    await processStoryJob(baseJob(), {
      authPool: authPool as never,
      checkEnrichmentReady: async () => ({ ready: true, knownIocHit: false }),
      callAnalyzeStory: callAnalyzeStory as never,
      resolveCustomerPool: () => customerPool as never,
      loadRanges: emptyRangesLoader as never,
      loadOwnedDomains: emptyDomainsLoader as never,
    });

    const insertCall = customerPool.__calls.find((c) =>
      c.sql.includes("INSERT INTO story_analysis_result"),
    );
    expect(insertCall).toBeDefined();
    // params: ..., $9 severity_score, $10 likelihood_score, ..., $14 priority_tier
    expect(insertCall?.params?.[8]).toBe(SEVERITY);
    expect(insertCall?.params?.[9]).toBe(RAW_LIKELIHOOD);
    expect(insertCall?.params?.[13]).toBe("MEDIUM");
  });

  it("known_ioc_hit=true: floor raises likelihood to 0.95, tier=CRITICAL, raw likelihood still stored", async () => {
    const authPool = makePool({
      queryPlan: [
        { rows: [], rowCount: 1 },
        { rows: [], rowCount: 1 },
      ],
    });
    // Interleaving regression (#361): `loadCanonicalMembers` reads
    // `known_ioc_hit = false` (the value at load time), but enrichment
    // commits `true` before the readiness gate. The floor must use the
    // value the readiness check returns (read with the marker), NOT the
    // stale member-load value — otherwise this would floor on `false`.
    const customerPool = makePool({
      queryPlan: [{ rows: [] }, ...goodMembersQuery({ knownIocHit: false })],
      clientQueryPlan: [{ rows: [] }, { rows: [] }, { rows: [] }, { rows: [] }],
    });
    const callAnalyzeStory = async () => ({
      ...goodAimerResponse(),
      severityScore: SEVERITY,
      likelihoodScore: RAW_LIKELIHOOD,
    });

    await processStoryJob(baseJob(), {
      authPool: authPool as never,
      checkEnrichmentReady: async () => ({ ready: true, knownIocHit: true }),
      callAnalyzeStory: callAnalyzeStory as never,
      resolveCustomerPool: () => customerPool as never,
      loadRanges: emptyRangesLoader as never,
      loadOwnedDomains: emptyDomainsLoader as never,
    });

    const insertCall = customerPool.__calls.find((c) =>
      c.sql.includes("INSERT INTO story_analysis_result"),
    );
    expect(insertCall).toBeDefined();
    // The floor is matrix-lookup-only; the on-disk likelihood_score
    // remains the raw LLM value (0.3), never the floored 0.95.
    expect(insertCall?.params?.[8]).toBe(SEVERITY);
    expect(insertCall?.params?.[9]).toBe(RAW_LIKELIHOOD);
    expect(insertCall?.params?.[13]).toBe("CRITICAL");
  });
});

describe("processStoryJob — result-row probe", () => {
  beforeEach(() => vi.clearAllMocks());

  it("skips the LLM call when a result row already exists at the PK", async () => {
    const authPool = makePool({
      queryPlan: [
        { rows: [], rowCount: 1 }, // UPDATE → processing
        { rows: [], rowCount: 1 }, // finalize
      ],
    });
    const customerPool = makePool({
      queryPlan: [
        { rows: [{ priority_tier: "HIGH" }] }, // probe — existing row
      ],
    });
    const callAnalyzeStory = vi.fn();

    await processStoryJob(baseJob(), {
      authPool: authPool as never,
      checkEnrichmentReady: async () => ({ ready: true, knownIocHit: false }),
      callAnalyzeStory: callAnalyzeStory as never,
      resolveCustomerPool: () => customerPool as never,
    });

    expect(callAnalyzeStory).not.toHaveBeenCalled();
    // No member SELECTs after the probe.
    expect(customerPool.query).toHaveBeenCalledTimes(1);
    // No INSERT on the customer pool — only the finalize on auth pool.
    expect(customerPool.connect).not.toHaveBeenCalled();
    expect(sqlIncludes(authPool, "status = 'done'")).toBeDefined();
  });
});

describe("processStoryJob — lost pickup race", () => {
  beforeEach(() => vi.clearAllMocks());

  it("bails before calling the LLM when the claim UPDATE matches zero rows", async () => {
    // Simulates: another worker picked the same queued row from a
    // parallel pickup tick and already transitioned it (e.g. requeued
    // with bumped attempts, or finalized to done/failed). The claim
    // UPDATE here returns rowCount=0 and the worker must abort before
    // calling aimer.
    const authPool = makePool({
      queryPlan: [
        { rows: [], rowCount: 0 }, // claim UPDATE — race lost
      ],
    });
    const customerPool = makePool({ queryPlan: [] });
    const callAnalyzeStory = vi.fn();

    await processStoryJob(baseJob(), {
      authPool: authPool as never,
      checkEnrichmentReady: async () => ({ ready: true, knownIocHit: false }),
      callAnalyzeStory: callAnalyzeStory as never,
      resolveCustomerPool: () => customerPool as never,
    });

    expect(callAnalyzeStory).not.toHaveBeenCalled();
    // No customer-DB work at all — not even the probe.
    expect(customerPool.query).not.toHaveBeenCalled();
    // No follow-up auth-DB writes (no requeue, no finalize, no failJob).
    expect(authPool.__calls).toHaveLength(1);
  });
});

describe("processStoryJob — redaction-policy precondition", () => {
  beforeEach(() => vi.clearAllMocks());

  it("fails the job with missing_redaction_policy_version on empty string", async () => {
    const authPool = makePool({
      queryPlan: [
        { rows: [], rowCount: 1 }, // processing
        { rows: [], rowCount: 1 }, // failJob
      ],
    });
    const customerPool = makePool({
      queryPlan: [
        { rows: [] }, // probe
        {
          rows: [
            {
              story_version: "v1",
              source_aice_id: "aice-1",
              known_ioc_hit: false,
            },
          ],
        },
        {
          rows: [
            {
              story_id: "12345",
              story_version: "v1",
              member_event_key: "1001",
              source_aice_id: "aice-1",
              event: { ip: "<<REDACTED_IP_001>>" },
              redaction_policy_version: "",
            },
          ],
        },
      ],
    });
    const callAnalyzeStory = vi.fn();

    await processStoryJob(baseJob(), {
      authPool: authPool as never,
      checkEnrichmentReady: async () => ({ ready: true, knownIocHit: false }),
      callAnalyzeStory: callAnalyzeStory as never,
      resolveCustomerPool: () => customerPool as never,
    });

    expect(callAnalyzeStory).not.toHaveBeenCalled();
    const failCall = authPool.__calls.find((c) =>
      c.sql.includes("status = 'failed'"),
    );
    expect(failCall?.params?.[6]).toBe(0); // attempts unchanged (no LLM call)
    expect(failCall?.params?.[7]).toBe("missing_redaction_policy_version");
  });

  it("fails the job with mismatched_redaction_policy_version when members disagree", async () => {
    const authPool = makePool({
      queryPlan: [
        { rows: [], rowCount: 1 },
        { rows: [], rowCount: 1 },
      ],
    });
    const customerPool = makePool({
      queryPlan: [
        { rows: [] },
        {
          rows: [
            {
              story_version: "v1",
              source_aice_id: "aice-1",
              known_ioc_hit: false,
            },
          ],
        },
        {
          rows: [
            {
              story_id: "12345",
              story_version: "v1",
              member_event_key: "1001",
              source_aice_id: "aice-1",
              event: { ip: "<<REDACTED_IP_001>>" },
              redaction_policy_version: "engine:1.0|ranges:abc",
            },
            {
              story_id: "12345",
              story_version: "v1",
              member_event_key: "1002",
              source_aice_id: "aice-1",
              event: { ip: "<<REDACTED_IP_002>>" },
              redaction_policy_version: "engine:1.0|ranges:xyz",
            },
          ],
        },
      ],
    });
    const callAnalyzeStory = vi.fn();

    await processStoryJob(baseJob(), {
      authPool: authPool as never,
      checkEnrichmentReady: async () => ({ ready: true, knownIocHit: false }),
      callAnalyzeStory: callAnalyzeStory as never,
      resolveCustomerPool: () => customerPool as never,
    });

    expect(callAnalyzeStory).not.toHaveBeenCalled();
    const failCall = authPool.__calls.find((c) =>
      c.sql.includes("status = 'failed'"),
    );
    expect(failCall?.params?.[6]).toBe(0); // attempts unchanged
    expect(failCall?.params?.[7]).toBe("mismatched_redaction_policy_version");
  });
});

describe("processStoryJob — enrichment precondition", () => {
  beforeEach(() => vi.clearAllMocks());

  it("consumes an attempt on a hard enrichment failure and re-queues with backoff (#531)", async () => {
    // A persisted `failed` marker is a job failure, not an ordering wait, so
    // it must be bounded: route through `requeueWithBackoff` so each requeue
    // consumes one attempt instead of spinning forever. At attempts=0 the
    // first failure re-queues with attempts=1 and last_error=enrichment_failed.
    const authPool = makePool({
      queryPlan: [
        { rows: [], rowCount: 1 }, // UPDATE → processing
        { rows: [], rowCount: 1 }, // requeueWithBackoff UPDATE → queued
      ],
    });
    const customerPool = makePool({
      queryPlan: [{ rows: [] }, ...goodMembersQuery()],
    });
    const callAnalyzeStory = vi.fn();
    const error = vi.spyOn(console, "error").mockImplementation(() => {});

    await processStoryJob(baseJob(), {
      authPool: authPool as never,
      checkEnrichmentReady: async () => ({
        ready: false,
        knownIocHit: false,
        status: "failed",
        lastError: "enrichment: failed to load redaction policy",
      }),
      callAnalyzeStory: callAnalyzeStory as never,
      resolveCustomerPool: () => customerPool as never,
      loadRanges: emptyRangesLoader as never,
      loadOwnedDomains: emptyDomainsLoader as never,
    });

    // Not ready → no LLM call; re-queued (not yet failed) but an attempt is
    // now consumed with a descriptive last_error.
    expect(callAnalyzeStory).not.toHaveBeenCalled();
    const requeue = authPool.__calls.find((c) =>
      c.sql.includes("SET status = 'queued'"),
    );
    expect(requeue).toBeDefined();
    expect(requeue?.params?.[6]).toBe(1); // attempts = 0 + 1
    expect(requeue?.params?.[7]).toBe("enrichment_failed");
    expect(sqlIncludes(authPool, "status = 'failed'")).toBeUndefined();

    // The bounded retry is logged distinctly, carrying last_error — so it is
    // diagnosable and not a silent spin.
    const log = error.mock.calls.map((c) => String(c[0])).join("\n");
    expect(log).toContain("analysis.story_enrichment_failed_requeued");
    expect(log).not.toContain("analysis.story_enrichment_failed_exhausted");
    expect(log).toContain("failed to load redaction policy");
    error.mockRestore();
  });

  it("flips to terminal failed at the cap on a persistent enrichment failure (#531)", async () => {
    // A persistently `failed` enrichment marker must not requeue forever: at
    // MAX_ATTEMPTS the analysis job becomes terminal `failed` with a
    // descriptive last_error, since it cannot floor without a completed
    // marker (the stale-floor hazard #361 guards).
    const authPool = makePool({
      queryPlan: [
        { rows: [], rowCount: 1 }, // processing
        { rows: [], rowCount: 1 }, // failed (cap)
      ],
    });
    const customerPool = makePool({
      queryPlan: [{ rows: [] }, ...goodMembersQuery()],
    });
    const callAnalyzeStory = vi.fn();
    const error = vi.spyOn(console, "error").mockImplementation(() => {});

    // Job already at attempts=4; next failure brings it to 5 (default MAX).
    await processStoryJob(
      { ...baseJob(), attempts: 4 },
      {
        authPool: authPool as never,
        checkEnrichmentReady: async () => ({
          ready: false,
          knownIocHit: false,
          status: "failed",
          lastError: "enrichment: failed to load redaction policy",
        }),
        callAnalyzeStory: callAnalyzeStory as never,
        resolveCustomerPool: () => customerPool as never,
        loadRanges: emptyRangesLoader as never,
        loadOwnedDomains: emptyDomainsLoader as never,
      },
    );

    expect(callAnalyzeStory).not.toHaveBeenCalled();
    const failCall = authPool.__calls.find((c) =>
      c.sql.includes("status = 'failed'"),
    );
    expect(failCall).toBeDefined();
    expect(failCall?.params?.[6]).toBe(5); // attempts at the cap
    expect(failCall?.params?.[7]).toBe("enrichment_failed");
    // No re-queue was issued at the cap.
    expect(sqlIncludes(authPool, "SET status = 'queued'")).toBeUndefined();

    // The terminal failure switches to the `_exhausted` event, not requeued.
    const log = error.mock.calls.map((c) => String(c[0])).join("\n");
    expect(log).toContain("analysis.story_enrichment_failed_exhausted");
    expect(log).not.toContain("analysis.story_enrichment_failed_requeued");
    error.mockRestore();
  });

  it("requeues a still-pending enrichment as the (non-error) incomplete state", async () => {
    const authPool = makePool({
      queryPlan: [
        { rows: [], rowCount: 1 },
        { rows: [], rowCount: 1 },
      ],
    });
    const customerPool = makePool({
      queryPlan: [{ rows: [] }, ...goodMembersQuery()],
    });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    await processStoryJob(baseJob(), {
      authPool: authPool as never,
      // No marker yet (status null) → pending, not a hard failure.
      checkEnrichmentReady: async () => ({
        ready: false,
        knownIocHit: false,
        status: null,
      }),
      resolveCustomerPool: () => customerPool as never,
      loadRanges: emptyRangesLoader as never,
      loadOwnedDomains: emptyDomainsLoader as never,
    });

    // The latency path is untouched: requeued WITHOUT consuming an attempt
    // and still writing last_error = 'awaiting_enrichment' (regression #531).
    expect(
      sqlIncludes(authPool, "last_error = 'awaiting_enrichment'"),
    ).toBeDefined();
    expect(sqlIncludes(authPool, "status = 'failed'")).toBeUndefined();
    // The requeue itself does not touch `attempts` (the only `attempts = $7`
    // reference is the pickup guard, not the requeue UPDATE).
    const incompleteRequeue = sqlIncludes(authPool, "SET status = 'queued'");
    expect(incompleteRequeue?.sql.includes("attempts =")).toBe(false);

    const log = warn.mock.calls.map((c) => String(c[0])).join("\n");
    expect(log).toContain("analysis.story_enrichment_incomplete_requeued");
    expect(log).not.toContain("analysis.story_enrichment_failed_requeued");
    warn.mockRestore();
  });
});

function nullEventTimeMembersQuery(): Array<unknown> {
  return [
    {
      rows: [
        {
          story_version: "v1",
          source_aice_id: "aice-1",
          known_ioc_hit: false,
          time_window_start: new Date("2026-05-01T00:00:00.000Z"),
          time_window_end: new Date("2026-05-01T02:00:00.000Z"),
        },
      ],
    },
    {
      rows: [
        {
          story_id: "12345",
          story_version: "v1",
          member_event_key: "1001",
          source_aice_id: "aice-1",
          role: "primary",
          event: { ip: "<<REDACTED_IP_001>>" },
          redaction_policy_version: "engine:1.0|ranges:abc",
          event_time: null, // unresolved — baseline_event had no match
        },
      ],
    },
  ];
}

describe("processStoryJob — event-time precondition", () => {
  beforeEach(() => vi.clearAllMocks());

  it("re-queues with attempts++ on a first unresolved event_time (#352)", async () => {
    // RFC 0002 #344: `event_time` comes from a deduped LEFT JOIN to
    // baseline_event. A NULL means the member's timestamp could not be
    // resolved. Because baseline_event and story_member are ingested
    // through separate phase2 endpoints with no ordering guarantee
    // (#352), a first NULL is a retryable precondition miss — the job is
    // re-queued with backoff so a lagging baseline can self-heal, not
    // failed permanently. The redaction-policy check passes first (valid
    // version), so we reach the event-time guard.
    const authPool = makePool({
      queryPlan: [
        { rows: [], rowCount: 1 }, // processing
        { rows: [], rowCount: 1 }, // requeue
      ],
    });
    const customerPool = makePool({
      queryPlan: [{ rows: [] }, ...nullEventTimeMembersQuery()],
    });
    const callAnalyzeStory = vi.fn();

    await processStoryJob(baseJob(), {
      authPool: authPool as never,
      checkEnrichmentReady: async () => ({ ready: true, knownIocHit: false }),
      callAnalyzeStory: callAnalyzeStory as never,
      resolveCustomerPool: () => customerPool as never,
    });

    expect(callAnalyzeStory).not.toHaveBeenCalled();
    // No result INSERT attempted.
    expect(customerPool.connect).not.toHaveBeenCalled();
    // Re-queued, not failed.
    const requeue = authPool.__calls.find((c) =>
      c.sql.includes("SET status = 'queued'"),
    );
    expect(requeue).toBeDefined();
    expect(requeue?.params?.[6]).toBe(1); // attempts = 0 + 1
    expect(requeue?.params?.[7]).toBe("member_event_time_unresolved");
    const failCall = authPool.__calls.find((c) =>
      c.sql.includes("status = 'failed'"),
    );
    expect(failCall).toBeUndefined();
  });

  it("flips to failed (no requeue) when the cap is reached (#352)", async () => {
    // A persistently unresolvable event_time still fails loudly and
    // terminally once attempts reach MAX_ATTEMPTS — preserving #344's
    // option-(c) data-integrity escalation signal.
    const authPool = makePool({
      queryPlan: [
        { rows: [], rowCount: 1 }, // processing
        { rows: [], rowCount: 1 }, // failed (cap)
      ],
    });
    const customerPool = makePool({
      queryPlan: [{ rows: [] }, ...nullEventTimeMembersQuery()],
    });
    const callAnalyzeStory = vi.fn();

    // Job already at attempts=4; next miss brings it to 5 (default MAX).
    await processStoryJob(
      { ...baseJob(), attempts: 4 },
      {
        authPool: authPool as never,
        checkEnrichmentReady: async () => ({ ready: true, knownIocHit: false }),
        callAnalyzeStory: callAnalyzeStory as never,
        resolveCustomerPool: () => customerPool as never,
      },
    );

    expect(callAnalyzeStory).not.toHaveBeenCalled();
    expect(customerPool.connect).not.toHaveBeenCalled();
    const failCall = authPool.__calls.find((c) =>
      c.sql.includes("status = 'failed'"),
    );
    expect(failCall).toBeDefined();
    expect(failCall?.params?.[6]).toBe(5); // attempts at the cap
    expect(failCall?.params?.[7]).toBe("member_event_time_unresolved");
    // No re-queue was issued.
    const requeue = authPool.__calls.find((c) =>
      c.sql.includes("SET status = 'queued'"),
    );
    expect(requeue).toBeUndefined();
  });
});

describe("processStoryJob — hallucination scan", () => {
  beforeEach(() => vi.clearAllMocks());

  it("fails the job before any result-row INSERT when output contains an unmapped token", async () => {
    const authPool = makePool({
      queryPlan: [
        { rows: [], rowCount: 1 }, // processing
        { rows: [], rowCount: 1 }, // failJob
      ],
    });
    const customerPool = makePool({
      queryPlan: [{ rows: [] }, ...goodMembersQuery()],
    });
    const callAnalyzeStory = vi.fn(async () => ({
      ...goodAimerResponse(),
      // E9 is not a member index — only E0 and E1 are mapped.
      analysis: "Lateral move from <<REDACTED_IP_E9_007>>.",
    }));

    await processStoryJob(baseJob(), {
      authPool: authPool as never,
      checkEnrichmentReady: async () => ({ ready: true, knownIocHit: false }),
      callAnalyzeStory: callAnalyzeStory as never,
      resolveCustomerPool: () => customerPool as never,
      loadRanges: emptyRangesLoader as never,
      loadOwnedDomains: emptyDomainsLoader as never,
    });

    expect(callAnalyzeStory).toHaveBeenCalledTimes(1);
    // Result INSERT must NOT have been attempted.
    expect(customerPool.connect).not.toHaveBeenCalled();
    const failCall = authPool.__calls.find((c) =>
      c.sql.includes("status = 'failed'"),
    );
    expect(failCall?.params?.[6]).toBe(1); // attempts bumped (LLM call consumed)
    expect(failCall?.params?.[7]).toBe("hallucination_detected");
  });

  // #440 review (Author Round 1): the leak scan must cover the persisted
  // score factors too, not just the narrative body — otherwise a fact
  // token echoed (or decoded to a customer-asset plaintext) inside a short
  // factor slips past the shape filter and reaches the report LLM input.
  it("fails the job when a score factor decodes a fact token to a customer-asset IP", async () => {
    const authPool = makePool({
      queryPlan: [
        { rows: [], rowCount: 1 }, // processing
        { rows: [], rowCount: 1 }, // failJob
      ],
    });
    const customerPool = makePool({
      queryPlan: [{ rows: [] }, ...goodMembersQuery()],
    });
    const callAnalyzeStory = vi.fn(async () => ({
      ...goodAimerResponse(),
      // A private IP is always redaction-eligible, so a factor echoing one
      // verbatim is a decoded-plaintext leak regardless of the range set.
      severityFactors: ["beacon to 10.0.0.5 internal host"],
    }));

    await processStoryJob(baseJob(), {
      authPool: authPool as never,
      checkEnrichmentReady: async () => ({ ready: true, knownIocHit: false }),
      callAnalyzeStory: callAnalyzeStory as never,
      resolveCustomerPool: () => customerPool as never,
      loadRanges: emptyRangesLoader as never,
      loadOwnedDomains: emptyDomainsLoader as never,
    });

    expect(callAnalyzeStory).toHaveBeenCalledTimes(1);
    // Result INSERT must NOT have been attempted.
    expect(customerPool.connect).not.toHaveBeenCalled();
    const failCall = authPool.__calls.find((c) =>
      c.sql.includes("status = 'failed'"),
    );
    expect(failCall?.params?.[6]).toBe(1);
    expect(failCall?.params?.[7]).toBe("hallucination_detected");
  });

  it("fails the job when a score factor carries an unmapped fact token", async () => {
    const authPool = makePool({
      queryPlan: [
        { rows: [], rowCount: 1 }, // processing
        { rows: [], rowCount: 1 }, // failJob
      ],
    });
    const customerPool = makePool({
      queryPlan: [{ rows: [] }, ...goodMembersQuery()],
    });
    const callAnalyzeStory = vi.fn(async () => ({
      ...goodAimerResponse(),
      // No facts were injected, so `F1` is not an allowed token — the
      // kind-agnostic backstop must flag it as an unmapped token leak.
      likelihoodFactors: ["<<REDACTED_IP_F1_001>> listed by feed"],
    }));

    await processStoryJob(baseJob(), {
      authPool: authPool as never,
      checkEnrichmentReady: async () => ({ ready: true, knownIocHit: false }),
      callAnalyzeStory: callAnalyzeStory as never,
      resolveCustomerPool: () => customerPool as never,
      loadRanges: emptyRangesLoader as never,
      loadOwnedDomains: emptyDomainsLoader as never,
    });

    expect(callAnalyzeStory).toHaveBeenCalledTimes(1);
    expect(customerPool.connect).not.toHaveBeenCalled();
    const failCall = authPool.__calls.find((c) =>
      c.sql.includes("status = 'failed'"),
    );
    expect(failCall?.params?.[6]).toBe(1);
    expect(failCall?.params?.[7]).toBe("hallucination_detected");
  });
});

describe("processStoryJob — retryable + fatal aimer errors", () => {
  beforeEach(() => vi.clearAllMocks());

  function fakeClientError(status: number): ClientError {
    return new ClientError(
      {
        status,
        errors: [{ message: "x" }],
        headers: new Headers(),
        data: null,
      } as unknown as ClientError["response"],
      { query: "x" },
    );
  }

  it("requeues with attempts++ on a 5xx", async () => {
    const authPool = makePool({
      queryPlan: [
        { rows: [], rowCount: 1 }, // processing
        { rows: [], rowCount: 1 }, // requeue
      ],
    });
    const customerPool = makePool({
      queryPlan: [{ rows: [] }, ...goodMembersQuery()],
    });
    const callAnalyzeStory = vi.fn(async () => {
      throw fakeClientError(503);
    });

    await processStoryJob(baseJob(), {
      authPool: authPool as never,
      checkEnrichmentReady: async () => ({ ready: true, knownIocHit: false }),
      callAnalyzeStory: callAnalyzeStory as never,
      resolveCustomerPool: () => customerPool as never,
    });

    expect(customerPool.connect).not.toHaveBeenCalled();
    const requeue = authPool.__calls.find((c) =>
      c.sql.includes("SET status = 'queued'"),
    );
    expect(requeue).toBeDefined();
    expect(requeue?.params?.[6]).toBe(1); // attempts = 0 + 1
    expect(requeue?.params?.[7]).toBe("aimer_5xx");
  });

  it("flips to failed (no requeue) when the cap is reached", async () => {
    const authPool = makePool({
      queryPlan: [
        { rows: [], rowCount: 1 }, // processing
        { rows: [], rowCount: 1 }, // failed (cap)
      ],
    });
    const customerPool = makePool({
      queryPlan: [{ rows: [] }, ...goodMembersQuery()],
    });
    const callAnalyzeStory = vi.fn(async () => {
      throw fakeClientError(503);
    });

    // Job already at attempts=4; next failure brings it to 5 (default MAX).
    await processStoryJob(
      { ...baseJob(), attempts: 4 },
      {
        authPool: authPool as never,
        checkEnrichmentReady: async () => ({ ready: true, knownIocHit: false }),
        callAnalyzeStory: callAnalyzeStory as never,
        resolveCustomerPool: () => customerPool as never,
      },
    );

    const failCall = authPool.__calls.find((c) =>
      c.sql.includes("status = 'failed'"),
    );
    expect(failCall).toBeDefined();
    expect(failCall?.params?.[6]).toBe(5); // attempts at the cap
    expect(failCall?.params?.[7]).toBe("aimer_5xx");
    // No re-queue was issued.
    const requeue = authPool.__calls.find((c) =>
      c.sql.includes("SET status = 'queued'"),
    );
    expect(requeue).toBeUndefined();
  });

  it("fails the job (no retry) on a 4xx", async () => {
    const authPool = makePool({
      queryPlan: [
        { rows: [], rowCount: 1 }, // processing
        { rows: [], rowCount: 1 }, // failJob
      ],
    });
    const customerPool = makePool({
      queryPlan: [{ rows: [] }, ...goodMembersQuery()],
    });
    const callAnalyzeStory = vi.fn(async () => {
      throw fakeClientError(400);
    });

    await processStoryJob(baseJob(), {
      authPool: authPool as never,
      checkEnrichmentReady: async () => ({ ready: true, knownIocHit: false }),
      callAnalyzeStory: callAnalyzeStory as never,
      resolveCustomerPool: () => customerPool as never,
    });

    const failCall = authPool.__calls.find((c) =>
      c.sql.includes("status = 'failed'"),
    );
    expect(failCall?.params?.[6]).toBe(1); // attempts bumped on fatal 4xx
    expect(failCall?.params?.[7]).toBe("aimer_4xx");
    // No re-queue.
    const requeue = authPool.__calls.find((c) =>
      c.sql.includes("SET status = 'queued'"),
    );
    expect(requeue).toBeUndefined();
  });

  it("bumps attempts onto the captured value on a 4xx after prior retries", async () => {
    // Regression for #296 round 5 (item 2): a fatal post-LLM outcome
    // must increment `attempts` by 1 from whatever the captured value
    // was, so jobs that already retried surface the correct count in
    // the audit/request trail.
    const authPool = makePool({
      queryPlan: [
        { rows: [], rowCount: 1 }, // processing
        { rows: [], rowCount: 1 }, // failJob
      ],
    });
    const customerPool = makePool({
      queryPlan: [{ rows: [] }, ...goodMembersQuery()],
    });
    const callAnalyzeStory = vi.fn(async () => {
      throw fakeClientError(400);
    });

    await processStoryJob(
      { ...baseJob(), attempts: 2 },
      {
        authPool: authPool as never,
        checkEnrichmentReady: async () => ({ ready: true, knownIocHit: false }),
        callAnalyzeStory: callAnalyzeStory as never,
        resolveCustomerPool: () => customerPool as never,
      },
    );

    const failCall = authPool.__calls.find((c) =>
      c.sql.includes("status = 'failed'"),
    );
    expect(failCall?.params?.[6]).toBe(3); // 2 → 3
    expect(failCall?.params?.[7]).toBe("aimer_4xx");
  });
});

describe("processStoryJob — source unavailable", () => {
  beforeEach(() => vi.clearAllMocks());

  it("fails the job when no canonical story version survives", async () => {
    const authPool = makePool({
      queryPlan: [
        { rows: [], rowCount: 1 }, // processing
        { rows: [], rowCount: 1 }, // failJob
      ],
    });
    const customerPool = makePool({
      queryPlan: [
        { rows: [] }, // probe
        { rows: [] }, // story SELECT — no version
      ],
    });
    const callAnalyzeStory = vi.fn();

    await processStoryJob(baseJob(), {
      authPool: authPool as never,
      checkEnrichmentReady: async () => ({ ready: true, knownIocHit: false }),
      callAnalyzeStory: callAnalyzeStory as never,
      resolveCustomerPool: () => customerPool as never,
    });

    expect(callAnalyzeStory).not.toHaveBeenCalled();
    const failCall = authPool.__calls.find((c) =>
      c.sql.includes("status = 'failed'"),
    );
    expect(failCall?.params?.[6]).toBe(0); // attempts unchanged (no LLM call)
    expect(failCall?.params?.[7]).toBe("source_unavailable");
  });
});

describe("processStoryJob — translate path (#580)", () => {
  beforeEach(() => vi.clearAllMocks());

  const CLAIM_MARKER = "2026-06-13T00:00:00.000Z";

  function goodTranslateResponse() {
    return {
      analysis: "한국어 분석 <<REDACTED_IP_E1_001>>.",
      severityFactors: ["측면 이동 신호", "권한 계정 사용"],
      likelihoodFactors: ["상관된 다수 이벤트"],
      promptVersion: "translate-v1",
      modelActualVersion: "gpt-4o-2024-08-06",
    };
  }

  it("defers via next_due_at without consuming the retry budget when the canonical is not ready", async () => {
    const authPool = makePool({
      queryPlan: [
        { rows: [{ processing_started_at: CLAIM_MARKER }], rowCount: 1 }, // claim
        { rows: [], rowCount: 1 }, // deferJobForCanonical
      ],
    });
    const customerPool = makePool({
      queryPlan: [
        { rows: [] }, // probe — no existing translated row
        { rows: [] }, // loadStoryEnglishCanonical — canonical NOT ready
      ],
    });
    const callTranslate = vi.fn();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    await processStoryJob(
      { ...baseJob(), lang: "KOREAN" },
      {
        authPool: authPool as never,
        callTranslateAnalysisNarrative: callTranslate as never,
        resolveCustomerPool: () => customerPool as never,
        loadRanges: emptyRangesLoader as never,
        loadOwnedDomains: emptyDomainsLoader as never,
      },
    );
    warn.mockRestore();

    // No translate call, no result INSERT.
    expect(callTranslate).not.toHaveBeenCalled();
    expect(customerPool.connect).not.toHaveBeenCalled();
    // The defer sets a bounded next_due_at and does NOT touch attempts or
    // flip the job to failed (no retry-budget consumption, no hot spin).
    const defer = authPool.__calls.find((c) =>
      c.sql.includes("english_canonical_not_ready"),
    );
    expect(defer).toBeDefined();
    expect(defer?.sql).toContain("next_due_at = NOW()");
    expect(defer?.sql).not.toContain("attempts =");
    expect(sqlIncludes(authPool, "status = 'failed'")).toBeUndefined();
  });

  it("fails loudly when the translated factor count diverges from the canonical", async () => {
    const authPool = makePool({
      queryPlan: [
        { rows: [{ processing_started_at: CLAIM_MARKER }], rowCount: 1 }, // claim
        { rows: [], rowCount: 1 }, // failJob
      ],
    });
    const customerPool = makePool({
      queryPlan: [
        { rows: [] }, // probe
        { rows: [canonicalResultRow()] }, // canonical (severity_factors length 2)
        ...goodMembersQuery(),
      ],
    });
    // Translated severityFactors collapses 2 → 1: an element-count change must
    // fail the job (no filterFactors re-run, no add/drop).
    const callTranslate = async () => ({
      ...goodTranslateResponse(),
      severityFactors: ["측면 이동 신호"],
    });

    await processStoryJob(
      { ...baseJob(), lang: "KOREAN" },
      {
        authPool: authPool as never,
        callTranslateAnalysisNarrative: callTranslate as never,
        resolveCustomerPool: () => customerPool as never,
        loadRanges: emptyRangesLoader as never,
        loadOwnedDomains: emptyDomainsLoader as never,
        loadEnrichmentFacts: async () => [],
      },
    );

    expect(customerPool.connect).not.toHaveBeenCalled();
    const failCall = authPool.__calls.find((c) =>
      c.sql.includes("status = 'failed'"),
    );
    expect(failCall?.params?.[6]).toBe(1); // attempts bumped (call consumed)
    expect(failCall?.params?.[7]).toBe("translation_factor_shape_changed");
  });

  it("leak-scans the translated narrative and fails on an unmapped token", async () => {
    const authPool = makePool({
      queryPlan: [
        { rows: [{ processing_started_at: CLAIM_MARKER }], rowCount: 1 }, // claim
        { rows: [], rowCount: 1 }, // failJob
      ],
    });
    const customerPool = makePool({
      queryPlan: [
        { rows: [] }, // probe
        { rows: [canonicalResultRow()] }, // canonical
        ...goodMembersQuery(),
      ],
    });
    // E9 is not a member index → unmapped token leak in the translated text.
    const callTranslate = async () => ({
      ...goodTranslateResponse(),
      analysis: "측면 이동 <<REDACTED_IP_E9_007>>.",
    });

    await processStoryJob(
      { ...baseJob(), lang: "KOREAN" },
      {
        authPool: authPool as never,
        callTranslateAnalysisNarrative: callTranslate as never,
        resolveCustomerPool: () => customerPool as never,
        loadRanges: emptyRangesLoader as never,
        loadOwnedDomains: emptyDomainsLoader as never,
        loadEnrichmentFacts: async () => [],
      },
    );

    expect(customerPool.connect).not.toHaveBeenCalled();
    const failCall = authPool.__calls.find((c) =>
      c.sql.includes("status = 'failed'"),
    );
    expect(failCall?.params?.[6]).toBe(1);
    expect(failCall?.params?.[7]).toBe("hallucination_detected");
  });

  it("scans the translation against the CANONICAL's tokens, not the latest member set (#580)", async () => {
    // The allow-list is pinned to the English canonical's STORED text, not to
    // whatever the latest story version produces. Here the canonical narrative
    // carries NO redaction token, yet the latest member set (goodMembersQuery)
    // would yield an `E1` token. A translation that introduces `E1_001` must
    // therefore FAIL: aimer preserves tokens verbatim, so a token absent from
    // the canonical cannot legitimately appear in its translation. A
    // member-derived allow-list (the pre-fix behaviour) would have wrongly
    // admitted it.
    const authPool = makePool({
      queryPlan: [
        { rows: [{ processing_started_at: CLAIM_MARKER }], rowCount: 1 }, // claim
        { rows: [], rowCount: 1 }, // failJob
      ],
    });
    const customerPool = makePool({
      queryPlan: [
        { rows: [] }, // probe
        {
          rows: [
            {
              ...canonicalResultRow(),
              analysis_text: "Lateral movement detected; no tokens cited.",
              severity_factors: ["lateral movement signals"],
              likelihood_factors: ["multiple correlated events"],
            },
          ],
        }, // canonical — token-free narrative
        ...goodMembersQuery(), // latest members WOULD yield an E1 token
      ],
    });
    const callTranslate = async () => ({
      ...goodTranslateResponse(),
      // Element counts preserved (1 severity / 1 likelihood) so the shape gate
      // passes and the leak scan is what fails the job.
      analysis: "측면 이동 <<REDACTED_IP_E1_001>>.",
      severityFactors: ["측면 이동 신호"],
      likelihoodFactors: ["상관된 다수 이벤트"],
    });

    await processStoryJob(
      { ...baseJob(), lang: "KOREAN" },
      {
        authPool: authPool as never,
        callTranslateAnalysisNarrative: callTranslate as never,
        resolveCustomerPool: () => customerPool as never,
        loadRanges: emptyRangesLoader as never,
        loadOwnedDomains: emptyDomainsLoader as never,
        loadEnrichmentFacts: async () => [],
      },
    );

    expect(customerPool.connect).not.toHaveBeenCalled();
    const failCall = authPool.__calls.find((c) =>
      c.sql.includes("status = 'failed'"),
    );
    expect(failCall?.params?.[7]).toBe("hallucination_detected");
  });

  it("aborts before the result insert when the claim was lost mid-translation", async () => {
    const authPool = makePool({
      queryPlan: [
        { rows: [{ processing_started_at: CLAIM_MARKER }], rowCount: 1 }, // claim
        { rows: [], rowCount: 0 }, // recordStoryTranslationAudit → claim lost
      ],
    });
    const customerPool = makePool({
      queryPlan: [
        { rows: [] }, // probe
        { rows: [canonicalResultRow()] }, // canonical
        ...goodMembersQuery(),
      ],
    });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    await processStoryJob(
      { ...baseJob(), lang: "KOREAN" },
      {
        authPool: authPool as never,
        callTranslateAnalysisNarrative: (async () =>
          goodTranslateResponse()) as never,
        resolveCustomerPool: () => customerPool as never,
        loadRanges: emptyRangesLoader as never,
        loadOwnedDomains: emptyDomainsLoader as never,
        loadEnrichmentFacts: async () => [],
      },
    );
    warn.mockRestore();

    // The audit UPDATE matched zero rows (watchdog requeued), so the durable
    // result INSERT must NOT run and the job is not finalized.
    expect(customerPool.connect).not.toHaveBeenCalled();
    expect(sqlIncludes(authPool, "status = 'done'")).toBeUndefined();
  });
});
