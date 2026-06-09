// Unit tests for the subject retention providers (#505 / #513).
//
// Focused on the B4 group retention bound — the single shared formula the
// display-time navigation boundary (#513) and the write-side reaper (#509)
// must agree on — plus the group provider's read shape.

import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import {
  computeBoundaryDate,
  computeGroupRetentionBoundDays,
  createGroupRetentionProvider,
} from "../subject-retention-provider";

describe("computeGroupRetentionBoundDays (B4 shared formula)", () => {
  it("takes the minimum over group policy and member horizons", () => {
    expect(computeGroupRetentionBoundDays(90, [120, 200])).toBe(90);
    expect(computeGroupRetentionBoundDays(365, [120, 200])).toBe(120);
  });

  it("treats a null input as unbounded (does not constrain the min)", () => {
    // Group unbounded → bound is the member minimum.
    expect(computeGroupRetentionBoundDays(null, [120, 200])).toBe(120);
    // A member unbounded → that member does not pull the bound down.
    expect(computeGroupRetentionBoundDays(90, [null, 200])).toBe(90);
    expect(computeGroupRetentionBoundDays(300, [null, null])).toBe(300);
  });

  it("returns null when group and every member are unbounded", () => {
    expect(computeGroupRetentionBoundDays(null, [null, null])).toBeNull();
    expect(computeGroupRetentionBoundDays(null, [])).toBeNull();
  });
});

describe("createGroupRetentionProvider", () => {
  function fakePool(rows: {
    tz: string | null;
    groupDays: number | null;
    memberDays: Array<number | null>;
  }) {
    return {
      query: vi.fn(async (sql: string) => {
        if (sql.includes("FROM customer_groups")) {
          return { rows: [{ tz: rows.tz, group_days: rows.groupDays }] };
        }
        return { rows: rows.memberDays.map((d) => ({ analysis_days: d })) };
      }),
      // biome-ignore lint/suspicious/noExplicitAny: minimal Pool stub
    } as any;
  }

  it("derives the boundary from the B4 bound in the group timezone", async () => {
    const provider = createGroupRetentionProvider(
      "group-1",
      fakePool({ tz: "UTC", groupDays: 90, memberDays: [120, null] }),
      () => new Date("2026-06-10T00:00:00Z"),
    );
    const { oldestNavigableDate, today } =
      await provider.resolveBoundary("DAILY");
    expect(today).toBe("2026-06-10");
    // min(90, 120) = 90 days back from 2026-06-10.
    expect(oldestNavigableDate).toBe(computeBoundaryDate("2026-06-10", 90));
  });

  it("is unbounded (null) when group and all members are unbounded", async () => {
    const provider = createGroupRetentionProvider(
      "group-1",
      fakePool({ tz: "UTC", groupDays: null, memberDays: [null, null] }),
      () => new Date("2026-06-10T00:00:00Z"),
    );
    const { oldestNavigableDate } = await provider.resolveBoundary("WEEKLY");
    expect(oldestNavigableDate).toBeNull();
  });
});
