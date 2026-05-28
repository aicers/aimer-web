import { describe, expect, it } from "vitest";
import {
  applyLikelihoodFloors,
  computePriorityTier,
  maxTier,
  type PriorityTier,
  tierRank,
} from "../priority-tier";

describe("computePriorityTier — full 4x4 matrix coverage", () => {
  // Row order matches RFC 0002 §"Priority tiering" table; columns are
  // (L < 0.4, 0.4 ≤ L < 0.6, 0.6 ≤ L < 0.8, L ≥ 0.8).
  const samples: Array<
    [number, [PriorityTier, PriorityTier, PriorityTier, PriorityTier]]
  > = [
    [0.9, ["MEDIUM", "HIGH", "CRITICAL", "CRITICAL"]],
    [0.7, ["LOW", "MEDIUM", "HIGH", "HIGH"]],
    [0.5, ["LOW", "LOW", "MEDIUM", "MEDIUM"]],
    [0.1, ["LOW", "LOW", "LOW", "LOW"]],
  ];
  const likelihoods = [0.1, 0.5, 0.7, 0.9];

  for (const [severity, expectedRow] of samples) {
    for (const [colIdx, likelihood] of likelihoods.entries()) {
      it(`severity=${severity}, likelihood=${likelihood} → ${expectedRow[colIdx]}`, () => {
        expect(computePriorityTier(severity, likelihood)).toBe(
          expectedRow[colIdx],
        );
      });
    }
  }
});

describe("computePriorityTier — threshold boundary points", () => {
  // Thresholds 0.4 / 0.6 / 0.8 are inclusive lower bounds on the next bucket.
  it("severity 0.4 lands in the 0.4 ≤ S < 0.6 row", () => {
    expect(computePriorityTier(0.4, 0.3)).toBe("LOW");
    expect(computePriorityTier(0.4, 0.5)).toBe("LOW");
    expect(computePriorityTier(0.4, 0.7)).toBe("MEDIUM");
    expect(computePriorityTier(0.4, 0.9)).toBe("MEDIUM");
  });

  it("severity 0.6 lands in the 0.6 ≤ S < 0.8 row", () => {
    expect(computePriorityTier(0.6, 0.3)).toBe("LOW");
    expect(computePriorityTier(0.6, 0.5)).toBe("MEDIUM");
    expect(computePriorityTier(0.6, 0.7)).toBe("HIGH");
    expect(computePriorityTier(0.6, 0.9)).toBe("HIGH");
  });

  it("severity 0.8 lands in the S ≥ 0.8 row", () => {
    expect(computePriorityTier(0.8, 0.3)).toBe("MEDIUM");
    expect(computePriorityTier(0.8, 0.5)).toBe("HIGH");
    expect(computePriorityTier(0.8, 0.7)).toBe("CRITICAL");
    expect(computePriorityTier(0.8, 0.9)).toBe("CRITICAL");
  });

  it("likelihood 0.4 / 0.6 / 0.8 cross the column boundaries", () => {
    expect(computePriorityTier(0.9, 0.4)).toBe("HIGH");
    expect(computePriorityTier(0.9, 0.6)).toBe("CRITICAL");
    expect(computePriorityTier(0.9, 0.8)).toBe("CRITICAL");
  });

  it("endpoints 0.0 and 1.0 are valid", () => {
    expect(computePriorityTier(0.0, 0.0)).toBe("LOW");
    expect(computePriorityTier(1.0, 1.0)).toBe("CRITICAL");
  });
});

describe("tierRank / maxTier — semantic ordering, not lexicographic", () => {
  it("ranks CRITICAL > HIGH > MEDIUM > LOW", () => {
    expect(tierRank("CRITICAL")).toBeGreaterThan(tierRank("HIGH"));
    expect(tierRank("HIGH")).toBeGreaterThan(tierRank("MEDIUM"));
    expect(tierRank("MEDIUM")).toBeGreaterThan(tierRank("LOW"));
  });

  it("HIGH > LOW (lexicographic would say HIGH < LOW)", () => {
    expect(maxTier("HIGH", "LOW")).toBe("HIGH");
  });

  it("HIGH > MEDIUM (lexicographic would say HIGH < MEDIUM)", () => {
    expect(maxTier("HIGH", "MEDIUM")).toBe("HIGH");
  });

  it("CRITICAL > MEDIUM (lexicographic would say CRITICAL < MEDIUM)", () => {
    expect(maxTier("CRITICAL", "MEDIUM")).toBe("CRITICAL");
  });

  it("maxTier accepts variadic input and is order-independent", () => {
    expect(maxTier("LOW", "CRITICAL", "MEDIUM", "HIGH")).toBe("CRITICAL");
    expect(maxTier("LOW")).toBe("LOW");
  });

  it("maxTier throws on empty input", () => {
    expect(() => maxTier()).toThrow();
  });
});

describe("applyLikelihoodFloors — Phase 1 likelihood signals", () => {
  it("returns the raw value when no signals fire", () => {
    expect(
      applyLikelihoodFloors(0.3, { knownIocHit: false, memberCount: 1 }),
    ).toBe(0.3);
  });

  it("raises likelihood to >= 0.95 when knownIocHit fires", () => {
    expect(
      applyLikelihoodFloors(0.1, { knownIocHit: true, memberCount: 0 }),
    ).toBe(0.95);
  });

  it("never lowers an already-high likelihood", () => {
    expect(
      applyLikelihoodFloors(0.99, { knownIocHit: true, memberCount: 10 }),
    ).toBe(0.99);
  });

  it("raises to >= 0.7 when memberCount meets the floor (default N=5)", () => {
    expect(
      applyLikelihoodFloors(0.2, { knownIocHit: false, memberCount: 5 }),
    ).toBe(0.7);
    expect(
      applyLikelihoodFloors(0.2, { knownIocHit: false, memberCount: 100 }),
    ).toBe(0.7);
  });

  it("does not raise when memberCount is below the floor", () => {
    expect(
      applyLikelihoodFloors(0.2, { knownIocHit: false, memberCount: 4 }),
    ).toBe(0.2);
  });

  it("knownIocHit dominates memberCount when both fire", () => {
    expect(
      applyLikelihoodFloors(0.1, { knownIocHit: true, memberCount: 50 }),
    ).toBe(0.95);
  });
});
