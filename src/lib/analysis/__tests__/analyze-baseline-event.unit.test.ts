// #493 — baseline-sourced analysis caller.
//
// Locks in: sourcing the EXACT baseline_version's stored redacted
// `raw_event` + its stored `redaction_policy_version` (redaction held
// constant), the `aice_id := source_aice_id` grain mapping, the
// auto-baseline provenance + NULL requested_by (non-human requester), the
// worker actor attribution, and the `source_unavailable` outcome when the
// version was rebaselined away.

import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const mockAnalyzeAndStore = vi.fn();
const mockDecrypt = vi.fn();
const mockLoadRanges = vi.fn();
const mockLoadDomains = vi.fn();

vi.mock("../run-analyze-flow", () => ({
  analyzeAndStoreEventResult: (...args: unknown[]) =>
    mockAnalyzeAndStore(...args),
}));

vi.mock("@/lib/redaction", () => ({
  decryptRedactionMap: (...args: unknown[]) => mockDecrypt(...args),
  loadCustomerRanges: (...args: unknown[]) => mockLoadRanges(...args),
  loadCustomerOwnedDomains: (...args: unknown[]) => mockLoadDomains(...args),
}));

const { analyzeBaselineEventLeaf } = await import("../analyze-baseline-event");

const CUSTOMER_ID = "c0000000-0000-0000-0000-000000000001";
const SOURCE_AICE_ID = "aice-src-1";
const EVENT_KEY = "1001";
const EVENT_TIME = "2026-05-20T00:00:00.000Z";
const WORKER = "system:analysis-worker";

function customerPool(opts: { baselineRow?: unknown; mapRow?: unknown }) {
  return {
    query: vi.fn(async (sql: string) => {
      if (sql.includes("FROM baseline_event")) {
        return { rows: opts.baselineRow ? [opts.baselineRow] : [] };
      }
      if (sql.includes("FROM event_redaction_map")) {
        return { rows: opts.mapRow ? [opts.mapRow] : [] };
      }
      return { rows: [] };
    }),
    // biome-ignore lint/suspicious/noExplicitAny: minimal pg surface
  } as any;
}

const authPool = {} as never;

beforeEach(() => {
  vi.clearAllMocks();
  mockLoadRanges.mockResolvedValue({ normalisedCidrs: [] });
  mockLoadDomains.mockResolvedValue({ normalisedSuffixes: [] });
  mockAnalyzeAndStore.mockResolvedValue({ kind: "success", generation: 2 });
});

describe("analyzeBaselineEventLeaf", () => {
  it("maps aice_id := source_aice_id, holds redaction constant, writes auto_baseline + NULL requested_by", async () => {
    const cp = customerPool({
      baselineRow: {
        raw_event: { event_time: EVENT_TIME, foo: "bar" },
        redaction_policy_version: "policy-stored-v3",
        event_time: new Date(EVENT_TIME),
      },
    });

    const out = await analyzeBaselineEventLeaf({
      authPool,
      customerPool: cp,
      customerId: CUSTOMER_ID,
      sourceAiceId: SOURCE_AICE_ID,
      eventKey: EVENT_KEY,
      baselineVersion: "bv-7",
      lang: "ENGLISH",
      modelName: "openai",
      model: "gpt-4o",
      workerAccountId: WORKER,
    });

    expect(out).toEqual({ kind: "analyzed", generation: 2 });
    // The baseline load pins the exact baseline_version.
    expect(cp.query.mock.calls[0][1]).toEqual([
      SOURCE_AICE_ID,
      EVENT_KEY,
      "bv-7",
    ]);

    const params = mockAnalyzeAndStore.mock.calls[0][0];
    expect(params.aiceId).toBe(SOURCE_AICE_ID);
    expect(params.origin).toBe("auto_baseline");
    expect(params.requestedBy).toBeNull();
    expect(params.redactionPolicyVersion).toBe("policy-stored-v3");
    expect(params.accountId).toBe(WORKER);
    expect(params.auditBase.actorId).toBe(WORKER);
    expect(params.eventTimeForAimer).toBe(EVENT_TIME);
  });

  it("returns source_unavailable when the exact baseline_version is gone", async () => {
    const cp = customerPool({ baselineRow: undefined });
    const out = await analyzeBaselineEventLeaf({
      authPool,
      customerPool: cp,
      customerId: CUSTOMER_ID,
      sourceAiceId: SOURCE_AICE_ID,
      eventKey: EVENT_KEY,
      baselineVersion: "bv-gone",
      lang: "ENGLISH",
      modelName: "openai",
      model: "gpt-4o",
      workerAccountId: WORKER,
    });
    expect(out).toEqual({ kind: "source_unavailable" });
    expect(mockAnalyzeAndStore).not.toHaveBeenCalled();
  });

  it("falls back to the baseline_event.event_time column when the payload lacks one", async () => {
    const cp = customerPool({
      baselineRow: {
        raw_event: { foo: "bar" }, // no event_time
        redaction_policy_version: "p",
        event_time: new Date(EVENT_TIME),
      },
    });
    await analyzeBaselineEventLeaf({
      authPool,
      customerPool: cp,
      customerId: CUSTOMER_ID,
      sourceAiceId: SOURCE_AICE_ID,
      eventKey: EVENT_KEY,
      baselineVersion: "bv-1",
      lang: "ENGLISH",
      modelName: "openai",
      model: "gpt-4o",
      workerAccountId: WORKER,
    });
    expect(mockAnalyzeAndStore.mock.calls[0][0].eventTimeForAimer).toBe(
      EVENT_TIME,
    );
  });
});
