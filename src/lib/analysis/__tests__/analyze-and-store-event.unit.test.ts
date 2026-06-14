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

// Spy on the default CVE supply resolver so a test can assert the run's real
// scope (customer id from auditBase, plus any explicit group scope) is threaded
// into the F2 source selection. The feature is off by default, so returning
// the gated-off state keeps the rest of the flow unchanged.
const cveSupplyMock = vi.hoisted(() => ({
  defaultCveSupply: vi.fn(() => ({ enabled: false }) as const),
}));
vi.mock("../cve/supply", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return { ...actual, defaultCveSupply: cveSupplyMock.defaultCveSupply };
});

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
    origin: "manual",
    requestedBy: "acc-1",
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

  it("threads the run's real customer id into the F2 source-selection scope", async () => {
    // The reviewer flagged that production callers never passed a scope, so
    // F2 selection saw `undefined` even though the customer id is known. The
    // helper now derives it from auditBase.customerId.
    await analyzeAndStoreEventResult(baseParams());
    expect(cveSupplyMock.defaultCveSupply).toHaveBeenCalledWith({
      customerId: "c1",
    });
  });

  it("merges an explicit cveScope (group id) over the derived customer scope", async () => {
    await analyzeAndStoreEventResult({
      ...baseParams(),
      cveScope: { groupId: "grp-1" },
    });
    expect(cveSupplyMock.defaultCveSupply).toHaveBeenCalledWith({
      customerId: "c1",
      groupId: "grp-1",
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
    // ... analysis_text (15), event_time (16), kind (17),
    // redaction_policy_version (18), requested_by (19), origin (20).
    // Zero-indexed: provenance at [5]/[6], generation at [7], event_time at
    // [15], kind at [16], policy at [17], requested_by at [18], origin at [19].
    expect(insert?.params?.[5]).toBe("gpt-4o-2026-05-01");
    expect(insert?.params?.[6]).toBe("v7");
    expect(insert?.params?.[7]).toBe(4);
    expect(insert?.params?.[15]).toBe(EVENT_TIME);
    // Manual params default eventKind to null (no kind in the wire contract).
    expect(insert?.params?.[16]).toBeNull();
    expect(insert?.params?.[17]).toBe("policy-v7");
    expect(insert?.params?.[18]).toBe("acc-1");
    expect(insert?.params?.[19]).toBe("manual");
    // The whole supersede+insert runs inside one transaction.
    expect(writeCalls[0].sql).toBe("BEGIN");
    expect(writeCalls.at(-1)?.sql).toBe("COMMIT");
  });

  it("broadens the English-canonical supersede across every language (#581)", async () => {
    // Advancing the English canonical must retire any user-language translation
    // pinned to the now-superseded generation, so a later failed re-translation
    // cannot leave a stale non-English leaf live for report selection. The
    // English write therefore passes `supersedeAllLangs = true` (the trailing
    // boolean bind) and the UPDATE drops the `lang =` equality.
    await analyzeAndStoreEventResult(baseParams());
    const update = writeCalls.find((c) => c.sql.includes("SET superseded_at"));
    expect(update).toBeDefined();
    expect(update?.sql).toContain("($7::boolean OR lang = $3)");
    expect(update?.params?.[6]).toBe(true);
  });

  it("persists event_time and the supplied kind (#552)", async () => {
    await analyzeAndStoreEventResult({
      ...baseParams(),
      eventKind: "HttpThreat",
    });
    const insert = writeCalls.find((c) =>
      c.sql.includes("INSERT INTO event_analysis_result"),
    );
    expect(insert).toBeDefined();
    // event_time at [15], kind at [16] (see column-order note above).
    expect(insert?.params?.[15]).toBe(EVENT_TIME);
    expect(insert?.params?.[16]).toBe("HttpThreat");
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

  // ---- preStoreCheck (#493 review round 4) ------------------------------
  // The auto-baseline worker re-checks eligibility (story membership / live
  // leaf) one last time INSIDE the storage transaction, under the variant
  // lock, immediately before supersede+insert. A non-null return rolls the
  // store back so no live row is ever superseded.

  it("aborts the store (rollback, no supersede/insert) when preStoreCheck returns a reason", async () => {
    const preStoreCheck = vi.fn(async () => "live_leaf_appeared");
    const res = await analyzeAndStoreEventResult({
      ...baseParams(),
      preStoreCheck,
    });
    expect(res).toEqual({ kind: "skipped", reason: "live_leaf_appeared" });

    // Runs on the transaction's own client, AFTER the lock is acquired.
    expect(preStoreCheck).toHaveBeenCalledTimes(1);
    expect(preStoreCheck).toHaveBeenCalledWith(client);
    const sqls = writeCalls.map((c) => c.sql);
    const beginIdx = sqls.indexOf("BEGIN");
    const lockIdx = sqls.findIndex((s) => s.includes("pg_advisory_xact_lock"));
    expect(beginIdx).toBeGreaterThanOrEqual(0);
    expect(lockIdx).toBeGreaterThan(beginIdx);

    // No generation read, no supersede, no INSERT — the tx rolled back.
    expect(sqls.some((s) => s.includes("next_generation"))).toBe(false);
    expect(sqls.some((s) => s.includes("SET superseded_at"))).toBe(false);
    expect(
      sqls.some((s) => s.includes("INSERT INTO event_analysis_result")),
    ).toBe(false);
    expect(sqls).toContain("ROLLBACK");
    expect(sqls).not.toContain("COMMIT");
  });

  it("proceeds with the store when preStoreCheck returns null", async () => {
    const preStoreCheck = vi.fn(async () => null);
    const res = await analyzeAndStoreEventResult({
      ...baseParams(),
      preStoreCheck,
    });
    expect(res).toEqual({ kind: "success", generation: 4 });
    expect(preStoreCheck).toHaveBeenCalledTimes(1);
    const sqls = writeCalls.map((c) => c.sql);
    expect(
      sqls.some((s) => s.includes("INSERT INTO event_analysis_result")),
    ).toBe(true);
    expect(sqls.at(-1)).toBe("COMMIT");
  });
});
