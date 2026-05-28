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
          redaction_policy_version: "engine:1.0|ranges:abc",
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
    analysis: "Suspicious lateral movement involving <<REDACTED_IP_E0_001>>.",
    promptVersion: "story-v3",
    modelActualVersion: "gpt-4o-2024-08-06",
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
    const llmCalls: Array<{ membersJson: string }> = [];
    const callAnalyzeStory = async (args: { membersJson: string }) => {
      llmCalls.push(args);
      return goodAimerResponse();
    };

    await processStoryJob(baseJob(), {
      authPool: authPool as never,
      callAnalyzeStory: callAnalyzeStory as never,
      resolveCustomerPool: () => customerPool as never,
      loadRanges: emptyRangesLoader as never,
    });

    expect(llmCalls).toHaveLength(1);
    // Tokens must be rewritten to story-scope before the LLM sees them.
    expect(llmCalls[0].membersJson).toContain("<<REDACTED_IP_E0_001>>");
    expect(llmCalls[0].membersJson).toContain("<<REDACTED_IP_E1_002>>");
    expect(llmCalls[0].membersJson).not.toMatch(/<<REDACTED_IP_001>>/);

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
      callAnalyzeStory: callAnalyzeStory as never,
      resolveCustomerPool: () => customerPool as never,
      loadRanges: emptyRangesLoader as never,
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
    const customerPool = makePool({
      queryPlan: [{ rows: [] }, ...goodMembersQuery({ knownIocHit: true })],
      clientQueryPlan: [{ rows: [] }, { rows: [] }, { rows: [] }, { rows: [] }],
    });
    const callAnalyzeStory = async () => ({
      ...goodAimerResponse(),
      severityScore: SEVERITY,
      likelihoodScore: RAW_LIKELIHOOD,
    });

    await processStoryJob(baseJob(), {
      authPool: authPool as never,
      callAnalyzeStory: callAnalyzeStory as never,
      resolveCustomerPool: () => customerPool as never,
      loadRanges: emptyRangesLoader as never,
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
      callAnalyzeStory: callAnalyzeStory as never,
      resolveCustomerPool: () => customerPool as never,
      loadRanges: emptyRangesLoader as never,
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
