import { describe, expect, it, vi } from "vitest";

// The module under test is server-only; stub the import guard so it loads
// under the test runner (mirrors the API route unit tests).
vi.mock("server-only", () => ({}));

import {
  type BackfillDeps,
  type BackfillScope,
  type CandidateLeaf,
  classifyDrain,
  classifyEnqueue,
  computeDrainSignal,
  computePlan,
  getStoryBackfillDrainSignal,
  previewStoryBackfill,
  runStoryBackfill,
} from "../story-backfill";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function leaf(over: Partial<CandidateLeaf> = {}): CandidateLeaf {
  return {
    storyId: "1",
    lang: "ENGLISH",
    stateStatus: "ready",
    targetStatus: null,
    targetDryRun: false,
    ...over,
  };
}

const SCOPE: BackfillScope = {
  customerId: "c1",
  modelName: "openai",
  model: "gpt-5.5",
  windowDays: 7,
  cap: null,
};

// ---------------------------------------------------------------------------
// classifyEnqueue (#466 Scope §5)
// ---------------------------------------------------------------------------

describe("classifyEnqueue", () => {
  it("seeds an absent target variant", () => {
    expect(classifyEnqueue(leaf({ targetStatus: null }), true)).toEqual({
      category: "seeded",
      action: "seed",
    });
  });

  it("requeues a failed target variant at the same generation", () => {
    expect(classifyEnqueue(leaf({ targetStatus: "failed" }), true)).toEqual({
      category: "requeued",
      action: "requeue",
    });
  });

  it("requeues a leftover dry-run row", () => {
    expect(
      classifyEnqueue(leaf({ targetStatus: "done", targetDryRun: true }), true),
    ).toEqual({ category: "requeued", action: "requeue" });
  });

  it.each([
    "queued",
    "processing",
    "done",
  ] as const)("coalesces an existing %s target variant (no write)", (status) => {
    expect(classifyEnqueue(leaf({ targetStatus: status }), true)).toEqual({
      category: "coalesced",
      action: null,
    });
  });

  it("reports a done target under a dirty state as skipped_dirty, not coalesced", () => {
    expect(
      classifyEnqueue(
        leaf({ stateStatus: "dirty", targetStatus: "done" }),
        true,
      ),
    ).toEqual({ category: "skipped_dirty", action: null });
  });

  it("never enqueues a dirty state (the worker's dirty re-seed owns it)", () => {
    expect(
      classifyEnqueue(leaf({ stateStatus: "dirty", targetStatus: null }), true),
    ).toEqual({ category: "skipped_dirty", action: null });
  });

  it("reports an archived state as source_unavailable", () => {
    expect(classifyEnqueue(leaf({ stateStatus: "archived" }), true)).toEqual({
      category: "source_unavailable",
      action: null,
    });
  });

  it("reports a missing live story row as source_unavailable", () => {
    expect(classifyEnqueue(leaf({ targetStatus: "done" }), false)).toEqual({
      category: "source_unavailable",
      action: null,
    });
  });
});

// ---------------------------------------------------------------------------
// classifyDrain (#466 Scope §6)
// ---------------------------------------------------------------------------

describe("classifyDrain", () => {
  it("is drained only when the target job is done and the state is not dirty", () => {
    expect(classifyDrain(leaf({ targetStatus: "done" }), true)).toBe("drained");
  });

  it("ready state alone does not imply drained (absent target → outstanding)", () => {
    expect(
      classifyDrain(leaf({ stateStatus: "ready", targetStatus: null }), true),
    ).toBe("absent");
  });

  it("a failed target keeps the scope un-drained", () => {
    expect(classifyDrain(leaf({ targetStatus: "failed" }), true)).toBe(
      "failed_outstanding",
    );
  });

  it("a dirty state is outstanding even with a done target", () => {
    expect(
      classifyDrain(leaf({ stateStatus: "dirty", targetStatus: "done" }), true),
    ).toBe("skipped_dirty");
  });

  it("queued / processing targets are outstanding", () => {
    expect(classifyDrain(leaf({ targetStatus: "queued" }), true)).toBe(
      "queued",
    );
    expect(classifyDrain(leaf({ targetStatus: "processing" }), true)).toBe(
      "processing",
    );
  });

  it("a dry-run done target is outstanding (not a real leaf)", () => {
    expect(
      classifyDrain(leaf({ targetStatus: "done", targetDryRun: true }), true),
    ).toBe("absent");
  });

  it("archived / missing source is excluded as source_unavailable", () => {
    expect(classifyDrain(leaf({ stateStatus: "archived" }), true)).toBe(
      "source_unavailable",
    );
    expect(classifyDrain(leaf({ targetStatus: "done" }), false)).toBe(
      "source_unavailable",
    );
  });
});

// ---------------------------------------------------------------------------
// computePlan — cap + categories (#466 Scope §3/§4)
// ---------------------------------------------------------------------------

describe("computePlan", () => {
  it("counts every category and plans writes for seed/requeue only", () => {
    const candidates = [
      leaf({ storyId: "1", targetStatus: null }), // seed
      leaf({ storyId: "2", targetStatus: "failed" }), // requeue
      leaf({ storyId: "3", targetStatus: "done" }), // coalesce
      leaf({ storyId: "4", stateStatus: "dirty" }), // skipped_dirty
      leaf({ storyId: "5", stateStatus: "archived" }), // source_unavailable
      leaf({ storyId: "6", targetStatus: null }), // source_unavailable (not live)
    ];
    const live = new Set(["1", "2", "3", "4"]);
    const plan = computePlan(candidates, live, null);
    expect(plan.counts).toEqual({
      seeded: 1,
      requeued: 1,
      coalesced: 1,
      skipped_dirty: 1,
      source_unavailable: 2,
      cap_excluded: 0,
    });
    expect(plan.writes).toEqual([
      { storyId: "1", lang: "ENGLISH", action: "seed" },
      { storyId: "2", lang: "ENGLISH", action: "requeue" },
    ]);
  });

  it("applies the per-run cap to enqueue writes in scan order, the rest cap_excluded", () => {
    const candidates = [
      leaf({ storyId: "1", targetStatus: null }),
      leaf({ storyId: "2", targetStatus: null }),
      leaf({ storyId: "3", targetStatus: "failed" }),
      leaf({ storyId: "4", targetStatus: "done" }), // coalesce — not capped
      leaf({ storyId: "5", targetStatus: null }),
    ];
    const live = new Set(["1", "2", "3", "4", "5"]);
    const plan = computePlan(candidates, live, 2);
    // Only the first two enqueue-eligible leaves are written; the third
    // enqueue-eligible (story 3) and fifth (story 5) are cap_excluded.
    expect(plan.writes).toEqual([
      { storyId: "1", lang: "ENGLISH", action: "seed" },
      { storyId: "2", lang: "ENGLISH", action: "seed" },
    ]);
    expect(plan.counts.seeded).toBe(2);
    expect(plan.counts.coalesced).toBe(1);
    expect(plan.counts.cap_excluded).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// Orchestration with fake deps
// ---------------------------------------------------------------------------

function fakeDeps(
  candidates: CandidateLeaf[],
  liveIds: string[],
): BackfillDeps & {
  seedJob: ReturnType<typeof vi.fn>;
  requeueJob: ReturnType<typeof vi.fn>;
} {
  return {
    scanCandidates: vi.fn(async () => candidates),
    liveStoryIds: vi.fn(async () => new Set(liveIds)),
    seedJob: vi.fn(async () => {}),
    requeueJob: vi.fn(async () => {}),
  };
}

describe("previewStoryBackfill", () => {
  it("returns category counts without enqueuing (cost preview)", async () => {
    const deps = fakeDeps(
      [
        leaf({ storyId: "1", targetStatus: null }),
        leaf({ storyId: "2", targetStatus: "done" }),
      ],
      ["1", "2"],
    );
    const counts = await previewStoryBackfill(SCOPE, deps);
    expect(counts.seeded).toBe(1);
    expect(counts.coalesced).toBe(1);
    expect(deps.seedJob).not.toHaveBeenCalled();
    expect(deps.requeueJob).not.toHaveBeenCalled();
  });

  it("only looks up live rows for non-archived candidates", async () => {
    const deps = fakeDeps(
      [
        leaf({ storyId: "1", targetStatus: null }),
        leaf({ storyId: "2", stateStatus: "archived" }),
      ],
      ["1"],
    );
    await previewStoryBackfill(SCOPE, deps);
    expect(deps.liveStoryIds).toHaveBeenCalledWith("c1", ["1"]);
  });
});

describe("runStoryBackfill", () => {
  it("seeds absent and requeues failed/dry-run target variants", async () => {
    const deps = fakeDeps(
      [
        leaf({ storyId: "1", lang: "ENGLISH", targetStatus: null }),
        leaf({ storyId: "2", lang: "KOREAN", targetStatus: "failed" }),
      ],
      ["1", "2"],
    );
    const res = await runStoryBackfill(SCOPE, deps);
    expect(res.counts.seeded).toBe(1);
    expect(res.counts.requeued).toBe(1);
    expect(deps.seedJob).toHaveBeenCalledWith(
      "c1",
      "1",
      "ENGLISH",
      "openai",
      "gpt-5.5",
    );
    expect(deps.requeueJob).toHaveBeenCalledWith(
      "c1",
      "2",
      "KOREAN",
      "openai",
      "gpt-5.5",
    );
  });

  it("is idempotent — a second run over the now-current leaf coalesces", async () => {
    // First run seeds; model the post-run state as a queued target variant.
    const deps = fakeDeps(
      [leaf({ storyId: "1", targetStatus: "queued" })],
      ["1"],
    );
    const res = await runStoryBackfill(SCOPE, deps);
    expect(res.counts.seeded).toBe(0);
    expect(res.counts.coalesced).toBe(1);
    expect(deps.seedJob).not.toHaveBeenCalled();
  });

  it("respects the per-run cap and reports cap_excluded", async () => {
    const deps = fakeDeps(
      [
        leaf({ storyId: "1", targetStatus: null }),
        leaf({ storyId: "2", targetStatus: null }),
        leaf({ storyId: "3", targetStatus: null }),
      ],
      ["1", "2", "3"],
    );
    const res = await runStoryBackfill({ ...SCOPE, cap: 1 }, deps);
    expect(res.counts.seeded).toBe(1);
    expect(res.counts.cap_excluded).toBe(2);
    expect(deps.seedJob).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// Drain signal (#466 Scope §6)
// ---------------------------------------------------------------------------

describe("computeDrainSignal", () => {
  it("is drained only when every in-scope leaf has a done target and no dirty state", () => {
    const sig = computeDrainSignal(
      SCOPE,
      [
        leaf({ storyId: "1", targetStatus: "done" }),
        leaf({ storyId: "2", targetStatus: "done" }),
      ],
      new Set(["1", "2"]),
    );
    expect(sig.drained).toBe(true);
    expect(sig.outstanding).toBe(0);
    expect(sig.totalLeaves).toBe(2);
  });

  it("a failed leaf keeps the scope un-drained (failed_outstanding)", () => {
    const sig = computeDrainSignal(
      SCOPE,
      [
        leaf({ storyId: "1", targetStatus: "done" }),
        leaf({ storyId: "2", targetStatus: "failed" }),
      ],
      new Set(["1", "2"]),
    );
    expect(sig.drained).toBe(false);
    expect(sig.counts.failed_outstanding).toBe(1);
    expect(sig.outstanding).toBe(1);
  });

  it("excludes source_unavailable leaves so they never block the gate", () => {
    const sig = computeDrainSignal(
      SCOPE,
      [
        leaf({ storyId: "1", targetStatus: "done" }),
        leaf({ storyId: "2", stateStatus: "archived" }),
        leaf({ storyId: "3", targetStatus: "done" }), // source gone
      ],
      new Set(["1"]),
    );
    expect(sig.counts.source_unavailable).toBe(2);
    expect(sig.totalLeaves).toBe(1);
    expect(sig.drained).toBe(true);
  });

  it("ready state with an absent target is outstanding (not drained)", () => {
    const sig = computeDrainSignal(
      SCOPE,
      [leaf({ storyId: "1", stateStatus: "ready", targetStatus: null })],
      new Set(["1"]),
    );
    expect(sig.drained).toBe(false);
    expect(sig.counts.absent).toBe(1);
  });
});

describe("getStoryBackfillDrainSignal", () => {
  it("scans and classifies via deps", async () => {
    const deps = fakeDeps(
      [leaf({ storyId: "1", targetStatus: "done" })],
      ["1"],
    );
    const sig = await getStoryBackfillDrainSignal(SCOPE, deps);
    expect(sig.drained).toBe(true);
    expect(sig.scope.model).toBe("gpt-5.5");
  });
});
