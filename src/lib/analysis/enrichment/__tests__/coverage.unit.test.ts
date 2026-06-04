import { describe, expect, it } from "vitest";
import { computeCoverage } from "../coverage";
import { type SourcePolicy, SourcePolicyRegistry } from "../source-policy";
import type { SourceOutcome } from "../types";

const CHECKED_AT = "2026-06-04T12:00:00.000Z";
const ONE_HOUR = 60 * 60 * 1000;
const FRESH = "2026-06-04T11:30:00.000Z"; // 30 min before checkedAt
const STALE = "2026-06-04T08:00:00.000Z"; // 4 h before checkedAt

function det(id: string): SourcePolicy {
  return {
    sourcePolicyId: id,
    label: id,
    entityTypes: ["IP"],
    deterministicCoverage: true,
    maxAge: ONE_HOUR,
    floorEligible: true,
  };
}

const soft: SourcePolicy = {
  sourcePolicyId: "soft",
  label: "soft",
  entityTypes: ["IP"],
  deterministicCoverage: false,
  maxAge: ONE_HOUR,
  floorEligible: false,
};

function answered(id: string, sourceUpdatedAt?: string): SourceOutcome {
  return { sourcePolicyId: id, answered: true, sourceUpdatedAt };
}

function unavailable(id: string): SourceOutcome {
  return {
    sourcePolicyId: id,
    answered: false,
    error: { sourcePolicyId: id, kind: "unavailable", message: "down" },
  };
}

describe("computeCoverage", () => {
  it("complete — all relevant sources answered fresh (even with zero matches)", () => {
    const registry = new SourcePolicyRegistry([det("a"), det("b"), soft]);
    const report = computeCoverage(
      "IP",
      [answered("a", FRESH), answered("b", FRESH)],
      registry,
      CHECKED_AT,
    );
    expect(report.status).toBe("complete");
    expect(report.expectedCount).toBe(2);
    expect(report.answeredCount).toBe(2);
    expect(report.freshCount).toBe(2);
  });

  it("partial — a relevant deterministic source was not attempted", () => {
    const registry = new SourcePolicyRegistry([det("a"), det("b")]);
    const report = computeCoverage(
      "IP",
      [answered("a", FRESH)],
      registry,
      CHECKED_AT,
    );
    expect(report.status).toBe("partial");
    expect(report.expectedCount).toBe(2);
    expect(report.answeredCount).toBe(1);
    expect(report.unavailableCount).toBe(0);
    expect(report.notAttemptedCount).toBe(1);
  });

  it("unknown — a relevant source is unavailable (answered:false)", () => {
    const registry = new SourcePolicyRegistry([det("a"), det("b")]);
    const report = computeCoverage(
      "IP",
      [answered("a", FRESH), unavailable("b")],
      registry,
      CHECKED_AT,
    );
    expect(report.status).toBe("unknown");
    expect(report.unavailableCount).toBe(1);
  });

  it("stale — a relevant source answered past its maxAge", () => {
    const registry = new SourcePolicyRegistry([det("a"), det("b")]);
    const report = computeCoverage(
      "IP",
      [answered("a", FRESH), answered("b", STALE)],
      registry,
      CHECKED_AT,
    );
    expect(report.status).toBe("stale");
    expect(report.staleCount).toBe(1);
  });

  it("uses the injected checkedAt for the stale boundary (≤ maxAge is fresh)", () => {
    const registry = new SourcePolicyRegistry([det("a")]);
    const exactlyMaxAge = "2026-06-04T11:00:00.000Z"; // exactly 1 h before
    expect(
      computeCoverage(
        "IP",
        [answered("a", exactlyMaxAge)],
        registry,
        CHECKED_AT,
      ).status,
    ).toBe("complete");
    const justOver = "2026-06-04T10:59:59.000Z";
    expect(
      computeCoverage("IP", [answered("a", justOver)], registry, CHECKED_AT)
        .status,
    ).toBe("stale");
  });

  it("precedence — unavailable beats stale beats partial", () => {
    const registry = new SourcePolicyRegistry([det("a"), det("b"), det("c")]);
    // fresh + stale + unavailable → unknown (unavailable wins)
    expect(
      computeCoverage(
        "IP",
        [answered("a", FRESH), answered("b", STALE), unavailable("c")],
        registry,
        CHECKED_AT,
      ).status,
    ).toBe("unknown");
    // fresh + stale (no unavailable) → stale (beats the not-attempted "c")
    expect(
      computeCoverage(
        "IP",
        [answered("a", FRESH), answered("b", STALE)],
        registry,
        CHECKED_AT,
      ).status,
    ).toBe("stale");
  });

  it("ignores soft (non-deterministic) sources entirely", () => {
    const registry = new SourcePolicyRegistry([det("a"), soft]);
    // soft source unanswered must not downgrade the status.
    const report = computeCoverage(
      "IP",
      [answered("a", FRESH)],
      registry,
      CHECKED_AT,
    );
    expect(report.status).toBe("complete");
    expect(report.expectedCount).toBe(1);
  });

  it("false-complete and false-unknown are distinguishable", () => {
    const registry = new SourcePolicyRegistry([det("a")]);
    const falseComplete = computeCoverage(
      "IP",
      [answered("a", FRESH)],
      registry,
      CHECKED_AT,
    );
    const falseUnknown = computeCoverage(
      "IP",
      [unavailable("a")],
      registry,
      CHECKED_AT,
    );
    // Both have zero matches at the caller, but their coverage differs.
    expect(falseComplete.status).toBe("complete");
    expect(falseUnknown.status).toBe("unknown");
  });
});
