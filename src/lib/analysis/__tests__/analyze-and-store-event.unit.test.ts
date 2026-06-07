// #463 — shared analyzeAndStoreEventResult helper tests.
//
// The supersede-and-insert(generation+1) write was lifted verbatim out of
// runAnalyzeFlow so the in-app regenerate endpoint can reuse it. These
// tests lock in that it re-calls aimer with the supplied (stored) redacted
// event + recovered event_time, supersedes the prior latest generation,
// INSERTs generation = N+1, stamps the supplied redaction_policy_version
// and requested_by, and returns the new generation.

import { beforeEach, describe, expect, it, vi } from "vitest";
import { buildRangeSet, EMPTY_OWNED_DOMAIN_SET } from "@/lib/redaction";

vi.mock("server-only", () => ({}));
vi.mock("@/lib/audit", () => ({ auditLog: vi.fn() }));

const mockGraphqlRequest = vi.fn();
vi.mock("@/lib/graphql/client", () => ({
  graphqlRequest: (...args: unknown[]) => mockGraphqlRequest(...args),
}));

import {
  type AnalyzeAndStoreEventParams,
  analyzeAndStoreEventResult,
} from "../run-analyze-flow";

const AICE_ID = "aice-1";
const EVENT_KEY = "1001";
const EVENT_TIME = "2026-05-20T00:00:00Z";

// Captures the customer-DB write statements so a test can assert the
// supersede UPDATE + INSERT shape and bind params.
let writeCalls: Array<{ sql: string; params: unknown[] }> = [];

function makeClient() {
  return {
    query: vi.fn(async (sql: string, params: unknown[] = []) => {
      writeCalls.push({ sql, params });
      if (sql.includes("next_generation")) {
        return { rows: [{ next_generation: 4 }] };
      }
      return { rows: [] };
    }),
    release: vi.fn(),
  };
}

let client: ReturnType<typeof makeClient>;
const customerPool = { connect: vi.fn(async () => client) };

function baseParams(): AnalyzeAndStoreEventParams {
  return {
    // biome-ignore lint/suspicious/noExplicitAny: pg Pool minimal surface
    customerPool: customerPool as any,
    aiceId: AICE_ID,
    eventKey: EVENT_KEY,
    redactedEvent: { event_time: EVENT_TIME, foo: "bar" },
    eventTimeForAimer: EVENT_TIME,
    lang: "ENGLISH",
    langForStorage: "ENGLISH",
    modelName: "openai",
    model: "gpt-4o",
    accountId: "acc-1",
    mergedMap: {},
    ranges: buildRangeSet([]),
    ownedDomains: EMPTY_OWNED_DOMAIN_SET,
    redactionPolicyVersion: "policy-v7",
    auditBase: {
      actorId: "acc-1",
      authContext: "general",
      targetType: "event_analysis_result",
      ipAddress: "127.0.0.1",
      sid: "sess-1",
      customerId: "c1",
      aiceId: AICE_ID,
    },
    force: true,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  writeCalls = [];
  client = makeClient();
  mockGraphqlRequest.mockResolvedValue({
    analyzeEvent: {
      severityScore: 0.4,
      likelihoodScore: 0.8,
      severityFactors: ["broad blast radius"],
      likelihoodFactors: ["lateral movement"],
      ttpTags: [],
      analysis: "plain narrative with no entities",
      promptVersion: "v7",
      modelActualVersion: "gpt-4o-2026-05-01",
    },
  });
});

describe("analyzeAndStoreEventResult", () => {
  it("re-calls aimer with the stored event + recovered event_time", async () => {
    const res = await analyzeAndStoreEventResult(baseParams());
    expect(res).toEqual({ kind: "success", generation: 4 });
    const [doc, variables] = mockGraphqlRequest.mock.calls[0];
    expect(doc).toBeDefined();
    expect(variables).toMatchObject({
      event: JSON.stringify({ event_time: EVENT_TIME, foo: "bar" }),
      eventTime: EVENT_TIME,
      name: "openai",
      model: "gpt-4o",
      lang: "ENGLISH",
    });
  });

  it("supersedes the prior row and inserts generation N+1", async () => {
    await analyzeAndStoreEventResult(baseParams());
    const update = writeCalls.find((c) => c.sql.includes("SET superseded_at"));
    expect(update).toBeDefined();
    // The supersede targets generations below the newly computed N+1 (4).
    expect(update?.params).toContain(4);

    const insert = writeCalls.find((c) =>
      c.sql.includes("INSERT INTO event_analysis_result"),
    );
    expect(insert).toBeDefined();
    // Column order: aice_id, event_key, lang, model_name, model,
    // model_actual_version (param 6), prompt_version (7), generation (8),
    // ... redaction_policy_version (16), requested_by (17). Zero-indexed:
    // provenance at [5]/[6], generation at [7], policy at [15],
    // requested_by at [16].
    expect(insert?.params?.[5]).toBe("gpt-4o-2026-05-01");
    expect(insert?.params?.[6]).toBe("v7");
    expect(insert?.params?.[7]).toBe(4);
    expect(insert?.params?.[15]).toBe("policy-v7");
    expect(insert?.params?.[16]).toBe("acc-1");
    // The whole supersede+insert runs inside one transaction.
    expect(writeCalls[0].sql).toBe("BEGIN");
    expect(writeCalls.at(-1)?.sql).toBe("COMMIT");
  });

  it("omits the GraphQL lang variable when lang is undefined", async () => {
    await analyzeAndStoreEventResult({ ...baseParams(), lang: undefined });
    const [, variables] = mockGraphqlRequest.mock.calls[0];
    expect("lang" in (variables as object)).toBe(false);
  });

  it("returns an error (no write) when the aimer call fails", async () => {
    mockGraphqlRequest.mockRejectedValue(new Error("network down"));
    const res = await analyzeAndStoreEventResult(baseParams());
    expect(res.kind).toBe("error");
    expect(customerPool.connect).not.toHaveBeenCalled();
  });
});
