import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import type { UniverseMember } from "../event-leaf-backfill";
import { tallyDrain } from "../event-leaf-drain";

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

describe("tallyDrain", () => {
  it("counts not-yet-run and failed (no target leaf, source present) as outstanding", () => {
    const t = tallyDrain([
      member({ eventKey: "1" }),
      member({ eventKey: "2" }),
    ]);
    expect(t.universe).toBe(2);
    expect(t.outstanding).toBe(2);
    expect(t.sourceUnavailable).toBe(0);
  });

  it("treats already_current members as drained (not outstanding)", () => {
    const t = tallyDrain([
      member({ eventKey: "1", alreadyCurrent: true }),
      member({ eventKey: "2", alreadyCurrent: true }),
    ]);
    expect(t.outstanding).toBe(0);
  });

  it("excludes source_unavailable from outstanding", () => {
    const t = tallyDrain([
      member({ eventKey: "1", sourcePresent: false }),
      member({ eventKey: "2", alreadyCurrent: true }),
    ]);
    expect(t.outstanding).toBe(0);
    expect(t.sourceUnavailable).toBe(1);
  });

  it("a swept event can never make a fully-current scope un-drained", () => {
    // universe = 1 already-current + 1 swept; outstanding must be 0 so the
    // swept event does not block #469's refresh forever.
    const t = tallyDrain([
      member({ eventKey: "1", alreadyCurrent: true }),
      member({ eventKey: "2", sourcePresent: false }),
    ]);
    expect(t.outstanding).toBe(0);
  });
});
