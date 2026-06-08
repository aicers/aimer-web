import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import {
  classifyPreCap,
  MAX_GENERATION,
  type PreCapOutcome,
  planRefresh,
  type VariantEvaluation,
} from "../report-refresh";

function evalVariant(
  preOutcome: PreCapOutcome | "refreshable",
  over: Partial<VariantEvaluation> = {},
): VariantEvaluation {
  return {
    period: "DAILY",
    bucketDate: "2026-06-05",
    tz: "UTC",
    lang: "ENGLISH",
    modelName: "openai",
    model: "gpt-5.5",
    windowStart: "2026-06-05T00:00:00.000Z",
    windowEnd: "2026-06-06T00:00:00.000Z",
    preOutcome,
    ...over,
  };
}

describe("classifyPreCap precedence", () => {
  const base = {
    stateArchived: false,
    jobStatus: null as null,
    jobGeneration: null as number | null,
    maxGeneration: 50,
    storyDrained: true,
    eventDrained: true,
  };

  it("reports an archived parent state as source_unavailable first", () => {
    expect(
      classifyPreCap({
        ...base,
        stateArchived: true,
        // even an in-flight job / undrained leaves do not override it
        jobStatus: "queued",
        storyDrained: false,
      }),
    ).toBe("source_unavailable");
  });

  it("skips a queued or processing variant as already_queued", () => {
    expect(classifyPreCap({ ...base, jobStatus: "queued" })).toBe(
      "already_queued",
    );
    expect(classifyPreCap({ ...base, jobStatus: "processing" })).toBe(
      "already_queued",
    );
  });

  it("reports a variant at the generation cap as capped, not refreshable", () => {
    expect(
      classifyPreCap({
        ...base,
        jobStatus: "done",
        jobGeneration: 50,
        maxGeneration: 50,
      }),
    ).toBe("capped");
  });

  it("gates a variant whose story OR event leaves are not drained", () => {
    expect(classifyPreCap({ ...base, storyDrained: false })).toBe("gated");
    expect(classifyPreCap({ ...base, eventDrained: false })).toBe("gated");
    expect(
      classifyPreCap({ ...base, storyDrained: false, eventDrained: false }),
    ).toBe("gated");
  });

  it("classifies a drained, under-cap, idle variant as refreshable", () => {
    // No job row yet (seed) — still refreshable when both sides are drained.
    expect(classifyPreCap(base)).toBe("refreshable");
    // A failed / done under-cap job is refreshable too.
    expect(
      classifyPreCap({ ...base, jobStatus: "failed", jobGeneration: 3 }),
    ).toBe("refreshable");
    expect(
      classifyPreCap({ ...base, jobStatus: "done", jobGeneration: 49 }),
    ).toBe("refreshable");
  });
});

describe("planRefresh cap + counts", () => {
  it("sums every outcome into totalVariants and passes non-refreshable through", () => {
    const evals = [
      evalVariant("refreshable", { bucketDate: "2026-06-05" }),
      evalVariant("gated", { bucketDate: "2026-06-04" }),
      evalVariant("already_queued", { bucketDate: "2026-06-03" }),
      evalVariant("capped", { bucketDate: "2026-06-02" }),
      evalVariant("source_unavailable", { bucketDate: "2026-06-01" }),
    ];
    const { counts, variants } = planRefresh(evals, null);
    expect(counts).toEqual({
      totalVariants: 5,
      refreshed: 1,
      capped: 1,
      gated: 1,
      alreadyQueued: 1,
      sourceUnavailable: 1,
      limited: 0,
    });
    expect(variants.map((v) => v.outcome)).toEqual([
      "refreshed",
      "gated",
      "already_queued",
      "capped",
      "source_unavailable",
    ]);
  });

  it("refreshes the first cap refreshable variants and reports the rest as limited", () => {
    const evals = [
      evalVariant("refreshable", { bucketDate: "2026-06-05" }),
      evalVariant("refreshable", { bucketDate: "2026-06-04" }),
      evalVariant("refreshable", { bucketDate: "2026-06-03" }),
    ];
    const { counts, variants } = planRefresh(evals, 2);
    expect(counts.refreshed).toBe(2);
    expect(counts.limited).toBe(1);
    expect(variants.map((v) => v.outcome)).toEqual([
      "refreshed",
      "refreshed",
      "limited",
    ]);
  });

  it("never limits a non-refreshable outcome (no silent caps)", () => {
    const evals = [
      evalVariant("gated"),
      evalVariant("source_unavailable"),
      evalVariant("capped"),
    ];
    const { counts } = planRefresh(evals, 0);
    expect(counts.limited).toBe(0);
    expect(counts.gated).toBe(1);
    expect(counts.sourceUnavailable).toBe(1);
    expect(counts.capped).toBe(1);
  });

  it("a cap of 0 limits every refreshable variant", () => {
    const evals = [evalVariant("refreshable"), evalVariant("refreshable")];
    const { counts } = planRefresh(evals, 0);
    expect(counts.refreshed).toBe(0);
    expect(counts.limited).toBe(2);
  });
});

describe("MAX_GENERATION", () => {
  it("defaults to 50 (mirrors the report worker cap)", () => {
    expect(MAX_GENERATION).toBe(50);
  });
});
