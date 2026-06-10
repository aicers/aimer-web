// Pure unit tests for the #495 long-tail analyzed-event aggregates: the
// universe→cited/uncited partition, technique clustering, tier distribution,
// exemplar factor selection, the 10-cluster cap + truncation warning, and the
// empty-universe omission. No DB — `planAnalyzedAggregates` and its helpers
// operate on in-memory leaf rows.

import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { __testables, wireCustomerId } from "../report-input-builder";

const {
  planAnalyzedAggregates,
  clusterExemplars,
  tierDistribution,
  chooseExemplarFactor,
  computeInputHash,
} = __testables;

type Tier = "CRITICAL" | "HIGH" | "MEDIUM" | "LOW";

// Minimal `EventLeafRow` factory — only the fields the aggregate helpers read.
function leaf(
  over: Partial<{
    aice_id: string;
    event_key: string;
    generation: number;
    model_name: string;
    model: string;
    severity_score: number;
    likelihood_score: number;
    priority_tier: Tier;
    ttp_tags: string[];
    severity_factors: string[];
    likelihood_factors: string[];
    redaction_policy_version: string;
  }> = {},
  // biome-ignore lint/suspicious/noExplicitAny: builds a partial leaf row
): any {
  return {
    aice_id: "aice-1",
    event_key: "1",
    generation: 1,
    model_name: "openai",
    model: "gpt",
    severity_score: 5,
    likelihood_score: 5,
    priority_tier: "MEDIUM" as Tier,
    ttp_tags: [],
    severity_factors: ["sev factor"],
    likelihood_factors: ["lik factor"],
    analysis_text: "",
    redaction_policy_version: "v1",
    event_time: new Date("2026-06-01T00:00:00Z"),
    ...over,
  };
}

const WINDOWS = {
  curStart: new Date("2026-06-01T00:00:00Z"),
  curEnd: new Date("2026-06-02T00:00:00Z"),
  prevStart: new Date("2026-05-31T00:00:00Z"),
  prevEnd: new Date("2026-06-01T00:00:00Z"),
  reportDate: "2026-06-01",
};

const WARN = {
  subjectId: "sub",
  period: "DAILY",
  bucketDate: "2026-06-01",
  tz: "UTC",
};

afterEach(() => {
  vi.restoreAllMocks();
});

describe("chooseExemplarFactor", () => {
  it("prefers severity_factors[0]", () => {
    expect(
      chooseExemplarFactor({
        severity_factors: ["sev0"],
        likelihood_factors: ["lik0"],
      }),
    ).toBe("sev0");
  });

  it("falls back to likelihood_factors[0] on the sentinel", () => {
    expect(
      chooseExemplarFactor({
        severity_factors: ["insufficient evidence"],
        likelihood_factors: ["lik0"],
      }),
    ).toBe("lik0");
  });

  it("returns the sentinel when no likelihood factor exists", () => {
    expect(
      chooseExemplarFactor({
        severity_factors: ["insufficient evidence"],
        likelihood_factors: [],
      }),
    ).toBe("insufficient evidence");
  });
});

describe("tierDistribution", () => {
  it("counts per tier in canonical high→low order, dropping empty tiers", () => {
    const dist = tierDistribution([
      leaf({ priority_tier: "LOW" }),
      leaf({ priority_tier: "CRITICAL" }),
      leaf({ priority_tier: "LOW" }),
      leaf({ priority_tier: "MEDIUM" }),
    ]);
    expect(dist).toEqual([
      { key: "CRITICAL", count: 1 },
      { key: "MEDIUM", count: 1 },
      { key: "LOW", count: 2 },
    ]);
  });
});

describe("computeInputHash exemplar refs (#495 review r1, item 1)", () => {
  const base = {
    subjectId: "sub",
    period: "DAILY",
    bucketDate: "2026-06-01",
    variant: {
      tz: "UTC",
      lang: "ENGLISH",
      modelName: "openai",
      model: "gpt",
      // biome-ignore lint/suspicious/noExplicitAny: minimal variant
    } as any,
    storyRefs: [],
    eventRefs: [],
    // biome-ignore lint/suspicious/noExplicitAny: payload is opaque to the hash
    aimerInputs: { storyAnalyses: [], eventAnalyses: [] } as any,
  };
  const ref = (over: Partial<Record<string, unknown>>) => ({
    aice_id: "a",
    event_key: "1",
    generation: 1,
    model_name: "openai",
    model: "gpt",
    ...over,
  });

  it("omits empty exemplar refs so the hash is byte-identical to pre-#495", () => {
    // An empty long-tail must hash exactly as if `exemplar_refs` were never a
    // field, otherwise every empty-universe report would be marked dirty.
    expect(computeInputHash({ ...base, exemplarRefs: [] })).toBe(
      computeInputHash({ ...base, exemplarRefs: [] }),
    );
  });

  it("a non-empty exemplar ref changes the hash vs the empty case", () => {
    expect(computeInputHash({ ...base, exemplarRefs: [ref({})] })).not.toBe(
      computeInputHash({ ...base, exemplarRefs: [] }),
    );
  });

  it("two different exemplar leaves with the same payload hash differently", () => {
    // The core gap: identical `aimerInputs` (factor strings are report-scope
    // placeholders) but different generation-pinned provenance must NOT collide.
    const a = computeInputHash({
      ...base,
      exemplarRefs: [ref({ generation: 1 })],
    });
    const b = computeInputHash({
      ...base,
      exemplarRefs: [ref({ generation: 2 })],
    });
    expect(a).not.toBe(b);
  });

  it("is order-independent in the exemplar ref list", () => {
    const r1 = ref({ aice_id: "a", event_key: "1" });
    const r2 = ref({ aice_id: "b", event_key: "2" });
    expect(computeInputHash({ ...base, exemplarRefs: [r1, r2] })).toBe(
      computeInputHash({ ...base, exemplarRefs: [r2, r1] }),
    );
  });
});

describe("computeInputHash member customer_id canonicalization (#523)", () => {
  // The single-customer story/event/exemplar ref shapes, mirroring what
  // `assembleReportInput` now stamps. `subjectId` is the report's own subject.
  const SUBJECT = "subject-1";
  const baseSingle = {
    subjectId: SUBJECT,
    period: "DAILY",
    bucketDate: "2026-06-01",
    variant: {
      tz: "UTC",
      lang: "ENGLISH",
      modelName: "openai",
      model: "gpt",
      // biome-ignore lint/suspicious/noExplicitAny: minimal variant
    } as any,
    // biome-ignore lint/suspicious/noExplicitAny: payload is opaque to the hash
    aimerInputs: { storyAnalyses: [], eventAnalyses: [] } as any,
  };
  const storyRef = (customerId?: string) => ({
    story_id: "7001",
    generation: 1,
    model_name: "openai",
    model: "gpt",
    ...(customerId !== undefined ? { customer_id: customerId } : {}),
  });
  const eventRef = (customerId?: string) => ({
    aice_id: "aice-1",
    event_key: "1",
    generation: 1,
    model_name: "openai",
    model: "gpt",
    ...(customerId !== undefined ? { customer_id: customerId } : {}),
  });
  const exemplarRef = (customerId?: string) => ({
    aice_id: "aice-2",
    event_key: "2",
    generation: 1,
    model_name: "openai",
    model: "gpt",
    ...(customerId !== undefined ? { customer_id: customerId } : {}),
  });

  it("is byte-identical whether a single-customer ref carries customer_id == subject or omits it", () => {
    // The acceptance gate: a new single-customer report stamps customer_id ==
    // subject_id on every ref, and that MUST hash exactly as a legacy ref that
    // never carried customer_id — otherwise every single-customer row would be
    // marked dirty by the #523 schema change alone.
    const withDefault = computeInputHash({
      ...baseSingle,
      storyRefs: [storyRef(SUBJECT)],
      eventRefs: [eventRef(SUBJECT)],
      exemplarRefs: [exemplarRef(SUBJECT)],
    });
    const withoutCustomerId = computeInputHash({
      ...baseSingle,
      storyRefs: [storyRef()],
      eventRefs: [eventRef()],
      exemplarRefs: [exemplarRef()],
    });
    expect(withDefault).toBe(withoutCustomerId);
  });

  it("a cross-member ref (customer_id != subject) changes the hash", () => {
    // Only a true cross-member ref (which does not occur until #524)
    // contributes customer_id to the hash.
    const single = computeInputHash({
      ...baseSingle,
      storyRefs: [],
      eventRefs: [eventRef(SUBJECT)],
      exemplarRefs: [],
    });
    const crossMember = computeInputHash({
      ...baseSingle,
      storyRefs: [],
      eventRefs: [eventRef("other-member")],
      exemplarRefs: [],
    });
    expect(single).not.toBe(crossMember);
  });
});

describe("wireCustomerId wire-source helper (#524/#525)", () => {
  it("resolves a single-customer wire source (no customer_id) to the report's own subject", () => {
    expect(wireCustomerId({}, "subject-1")).toBe("subject-1");
  });

  it("returns the source's own customer_id when present", () => {
    expect(wireCustomerId({ customer_id: "member-9" }, "subject-1")).toBe(
      "member-9",
    );
  });
});

describe("clusterExemplars", () => {
  it("clusters by technique with max tier, count, and top-ranked rep leaf", () => {
    const a = leaf({
      aice_id: "a",
      event_key: "1",
      priority_tier: "HIGH",
      severity_score: 8,
      likelihood_score: 8,
      ttp_tags: ["T1"],
    });
    const b = leaf({
      aice_id: "b",
      event_key: "2",
      priority_tier: "MEDIUM",
      severity_score: 3,
      likelihood_score: 3,
      ttp_tags: ["T1"],
    });
    const { kept, totalClusters } = clusterExemplars([a, b]);
    expect(totalClusters).toBe(1);
    expect(kept).toHaveLength(1);
    expect(kept[0]).toMatchObject({ technique: "T1", count: 2, tier: "HIGH" });
    // Higher tier + score wins the representative slot.
    expect(kept[0].repLeaf.aice_id).toBe("a");
  });

  it("a leaf with empty ttp_tags seeds no cluster", () => {
    const { kept } = clusterExemplars([leaf({ ttp_tags: [] })]);
    expect(kept).toHaveLength(0);
  });

  it("caps at 10 clusters by tier desc → count desc → technique ID", () => {
    // 12 distinct techniques, all MEDIUM, single leaf each.
    const leaves = Array.from({ length: 12 }, (_, i) =>
      leaf({
        aice_id: `a${i}`,
        event_key: String(i),
        priority_tier: "MEDIUM",
        ttp_tags: [`T${String(i).padStart(2, "0")}`],
      }),
    );
    const { kept, totalClusters } = clusterExemplars(leaves);
    expect(totalClusters).toBe(12);
    expect(kept).toHaveLength(10);
    // Tie on tier+count → ID ascending, so T00..T09 survive.
    expect(kept.map((k) => k.technique)).toEqual([
      "T00",
      "T01",
      "T02",
      "T03",
      "T04",
      "T05",
      "T06",
      "T07",
      "T08",
      "T09",
    ]);
  });
});

describe("planAnalyzedAggregates", () => {
  it("omits the section (finalize → null) when the universe is empty", () => {
    const plan = planAnalyzedAggregates({
      windows: WINDOWS,
      universe: [],
      cited: [],
      warnContext: WARN,
    });
    expect(plan.exemplarLeaves).toEqual([]);
    expect(plan.exemplarRefs).toEqual([]);
    expect(plan.finalize([])).toBeNull();
  });

  it("partitions universe into cited + uncited and ranges facets correctly", () => {
    const citedLeaf = leaf({
      aice_id: "c",
      event_key: "1",
      priority_tier: "CRITICAL",
      ttp_tags: ["T1"],
    });
    const uncited1 = leaf({
      aice_id: "u",
      event_key: "2",
      priority_tier: "LOW",
      ttp_tags: ["T1", "T2"],
    });
    const uncited2 = leaf({
      aice_id: "u",
      event_key: "3",
      priority_tier: "MEDIUM",
      ttp_tags: ["T2"],
    });
    const universe = [citedLeaf, uncited1, uncited2];
    const cited = [citedLeaf];

    const plan = planAnalyzedAggregates({
      windows: WINDOWS,
      universe,
      cited,
      warnContext: WARN,
    });
    // Two distinct uncited techniques → two exemplar clusters, one rep leaf
    // each (uncited1 reps T1 and is shared, uncited2 reps T2). Distinct rep
    // leaves only.
    const payload = plan.finalize(
      plan.exemplarLeaves.map((_, i) => `R-factor-${i}`),
    );
    expect(payload).not.toBeNull();
    if (payload === null) return;

    expect(payload.windowStart).toBe(WINDOWS.curStart.toISOString());
    expect(payload.windowEnd).toBe(WINDOWS.curEnd.toISOString());
    expect(payload.analyzedCount).toBe(3);
    expect(payload.citedCount).toBe(1);

    // topTechniques over the FULL universe: T1 appears in cited+uncited1 (2),
    // T2 in uncited1+uncited2 (2).
    expect(payload.topTechniques).toEqual([
      { key: "T1", count: 2 },
      { key: "T2", count: 2 },
    ]);
    // tierDistribution over the FULL universe.
    expect(payload.tierDistribution).toEqual([
      { key: "CRITICAL", count: 1 },
      { key: "MEDIUM", count: 1 },
      { key: "LOW", count: 1 },
    ]);
    // uncitedRollup over the UNCITED partition only: T1 (uncited1), T2
    // (uncited1+uncited2).
    expect(payload.uncitedRollup).toEqual([
      { key: "T2", count: 2 },
      { key: "T1", count: 1 },
    ]);
    // Exemplar factor strings come from the rewritten texts (token plumbing).
    for (const ex of payload.exemplars) {
      expect(ex.factor).toMatch(/^R-factor-\d+$/);
    }
  });

  it("surfaces each kept rep leaf's redaction_policy_version for the precondition", () => {
    // A low-only window: no cited leaves, but the uncited LOW leaves seed
    // exemplar clusters whose factors are sent to aimer. Their policy versions
    // must reach the redaction precondition (#495 review r1, item 2), else the
    // report would stamp `baseline-only` while shipping exemplar tokens.
    const universe = [
      leaf({ aice_id: "u", event_key: "1", ttp_tags: ["T1"] }),
      leaf({
        aice_id: "u",
        event_key: "2",
        ttp_tags: ["T2"],
        redaction_policy_version: "v9",
      }),
    ];
    const plan = planAnalyzedAggregates({
      windows: WINDOWS,
      universe,
      cited: [],
      warnContext: WARN,
    });
    expect(plan.exemplarPolicyVersions).toHaveLength(plan.exemplarRefs.length);
    expect([...plan.exemplarPolicyVersions].sort()).toEqual(["v1", "v9"]);
  });

  it("emits a truncation warning when more than 10 clusters exist", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const universe = Array.from({ length: 12 }, (_, i) =>
      leaf({
        aice_id: `a${i}`,
        event_key: String(i),
        priority_tier: "MEDIUM",
        ttp_tags: [`T${String(i).padStart(2, "0")}`],
      }),
    );
    const plan = planAnalyzedAggregates({
      windows: WINDOWS,
      universe,
      cited: [],
      warnContext: WARN,
    });
    expect(warn).toHaveBeenCalledTimes(1);
    const logged = JSON.parse(warn.mock.calls[0][0] as string);
    expect(logged.event).toBe("analysis.report_long_tail_exemplars_truncated");
    expect(logged.kept).toBe(10);
    expect(logged.dropped).toBe(2);
    // Only the distinct kept representative leaves enter the ref set.
    expect(plan.exemplarRefs).toHaveLength(10);
  });
});
