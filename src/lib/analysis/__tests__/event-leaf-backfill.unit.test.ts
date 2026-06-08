import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import {
  DEFAULT_WINDOW_DAYS,
  planBackfill,
  resolveScopeWindow,
  type UniverseMember,
} from "../event-leaf-backfill";

function member(over: Partial<UniverseMember>): UniverseMember {
  return {
    aiceId: "a",
    eventKey: "1",
    eventTime: "2026-06-01T00:00:00.000Z",
    alreadyCurrent: false,
    sourcePresent: true,
    ...over,
  };
}

describe("resolveScopeWindow", () => {
  it("ends at now and starts windowDays earlier", () => {
    const now = new Date("2026-06-08T00:00:00.000Z");
    const w = resolveScopeWindow(7, now);
    expect(w.windowEnd.toISOString()).toBe("2026-06-08T00:00:00.000Z");
    expect(w.windowStart.toISOString()).toBe("2026-06-01T00:00:00.000Z");
  });

  it("defaults the recent window to 7 days", () => {
    expect(DEFAULT_WINDOW_DAYS).toBe(7);
  });
});

describe("planBackfill categorization", () => {
  it("splits the universe into the no-silent-caps categories", () => {
    const members = [
      member({ eventKey: "1", alreadyCurrent: true }),
      member({ eventKey: "2", alreadyCurrent: false, sourcePresent: true }),
      member({ eventKey: "3", alreadyCurrent: false, sourcePresent: false }),
      member({ eventKey: "4", alreadyCurrent: false, sourcePresent: true }),
    ];
    const { counts, workItems } = planBackfill(members, null);
    expect(counts.totalUniverse).toBe(4);
    expect(counts.alreadyCurrent).toBe(1);
    expect(counts.sourceUnavailable).toBe(1);
    expect(counts.reanalyze).toBe(2);
    expect(counts.capExcluded).toBe(0);
    expect(workItems).toEqual([
      { aiceId: "a", eventKey: "2" },
      { aiceId: "a", eventKey: "4" },
    ]);
  });

  it("counts the universe sum across every category", () => {
    const members = [
      member({ eventKey: "1", alreadyCurrent: true }),
      member({ eventKey: "2", sourcePresent: false }),
      member({ eventKey: "3" }),
    ];
    const { counts } = planBackfill(members, null);
    expect(
      counts.reanalyze +
        counts.alreadyCurrent +
        counts.sourceUnavailable +
        counts.capExcluded,
    ).toBe(counts.totalUniverse);
  });

  it("applies a per-run cap and reports the remainder as cap_excluded", () => {
    const members = [
      member({ eventKey: "1" }),
      member({ eventKey: "2" }),
      member({ eventKey: "3" }),
    ];
    const { counts, workItems } = planBackfill(members, 2);
    expect(counts.reanalyze).toBe(2);
    expect(counts.capExcluded).toBe(1);
    expect(workItems).toHaveLength(2);
  });

  it("treats a cap of 0 as excluding all work candidates", () => {
    const members = [member({ eventKey: "1" }), member({ eventKey: "2" })];
    const { counts, workItems } = planBackfill(members, 0);
    expect(counts.reanalyze).toBe(0);
    expect(counts.capExcluded).toBe(2);
    expect(workItems).toHaveLength(0);
  });

  it("never cap-excludes already_current or source_unavailable members", () => {
    const members = [
      member({ eventKey: "1", alreadyCurrent: true }),
      member({ eventKey: "2", sourcePresent: false }),
    ];
    const { counts } = planBackfill(members, 0);
    expect(counts.capExcluded).toBe(0);
    expect(counts.alreadyCurrent).toBe(1);
    expect(counts.sourceUnavailable).toBe(1);
  });
});
