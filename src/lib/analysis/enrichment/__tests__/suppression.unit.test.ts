// RFC 0003 F5 (#599) — negative-layer suppression pass unit tests.
//
// Exercises `applyNegativeSuppression` over merged dispatch results directly
// (no DB): the no-negative no-op, soft drop, deterministic demotion, fact
// regeneration to empty, the decision log payload (no raw indicator), and the
// monotonic-floor safety guarantee that a negative hit can never create a hit.

import { describe, expect, it } from "vitest";
import { normalizeIp } from "../normalization";
import { matchSatisfiesFloor } from "../source-policy";
import { applyNegativeSuppression } from "../suppression";
import type {
  CoverageReport,
  EnrichmentMatch,
  MergedEnrichmentResult,
  NegativeMatch,
} from "../types";

const INDICATOR = normalizeIp("45.66.230.5");

const COVERAGE: CoverageReport = {
  status: "complete",
  expectedCount: 1,
  answeredCount: 1,
  freshCount: 1,
  staleCount: 0,
  unavailableCount: 0,
  notAttemptedCount: 0,
};

function detMatch(overrides: Partial<EnrichmentMatch> = {}): EnrichmentMatch {
  return {
    source: "abuse.ch/feodo",
    sourcePolicyId: "abuse.ch/feodo",
    hitType: "deterministic_ioc",
    floorEligible: true,
    classification: "c2",
    ...overrides,
  };
}

function softMatch(overrides: Partial<EnrichmentMatch> = {}): EnrichmentMatch {
  return {
    source: "soft/rep-a",
    sourcePolicyId: "soft/rep-a",
    hitType: "soft_reputation",
    floorEligible: false,
    confidence: 0.9,
    ...overrides,
  };
}

function negative(overrides: Partial<NegativeMatch> = {}): NegativeMatch {
  return {
    source: "misp/warninglists",
    sourcePolicyId: "misp/warninglists",
    classification: "public-dns",
    ...overrides,
  };
}

function merged(
  matches: EnrichmentMatch[],
  negativeMatches: NegativeMatch[] = [],
): MergedEnrichmentResult {
  return {
    indicator: INDICATOR,
    matches,
    negativeMatches,
    facts: matches.map((m) => ({
      text: `${INDICATOR.value} is listed by ${m.source}`,
      redactionTokens: [],
    })),
    errors: [],
    outcomes: [],
    checkedAt: "2026-06-04T12:00:00.000Z",
    coverage: COVERAGE,
  };
}

describe("applyNegativeSuppression", () => {
  it("is a byte-for-byte no-op when no negative hit is present", () => {
    const input = merged([detMatch(), softMatch()]);
    const { result, decisions } = applyNegativeSuppression(input);
    // Same object reference — nothing downstream can observe a difference.
    expect(result).toBe(input);
    expect(decisions).toEqual([]);
  });

  it("treats an absent negativeMatches field as no negative hit", () => {
    const input: MergedEnrichmentResult = {
      ...merged([detMatch()]),
      negativeMatches: undefined,
    };
    const { result, decisions } = applyNegativeSuppression(input);
    expect(result).toBe(input);
    expect(decisions).toEqual([]);
  });

  it("forces a floor-eligible deterministic match floor-ineligible (retained)", () => {
    const input = merged([detMatch({ floorEligible: true })], [negative()]);
    const { result, decisions } = applyNegativeSuppression(input);

    // The deterministic hit is RETAINED as evidence but can no longer floor.
    expect(result.matches).toHaveLength(1);
    expect(result.matches[0].hitType).toBe("deterministic_ioc");
    expect(result.matches[0].floorEligible).toBe(false);
    expect(matchSatisfiesFloor(result.matches[0])).toBe(false);

    expect(decisions).toContainEqual({
      sourcePolicyId: "abuse.ch/feodo",
      hitType: "deterministic_ioc",
      confidence: undefined,
      action: "demoted_deterministic",
    });
  });

  it("drops a soft match entirely from evidence and facts", () => {
    const input = merged([softMatch({ confidence: 0.9 })], [negative()]);
    const { result, decisions } = applyNegativeSuppression(input);

    expect(result.matches).toHaveLength(0);
    expect(result.facts).toHaveLength(0);
    expect(decisions).toContainEqual({
      sourcePolicyId: "soft/rep-a",
      hitType: "soft_reputation",
      confidence: 0.9,
      action: "dropped_soft",
    });
  });

  it("regenerates facts to empty for a warninglisted indicator (fact set ⊆ evidence)", () => {
    // A deterministic hit is retained as evidence, but its fact is removed:
    // under suppression the fact set is a strict subset of the evidence set.
    const input = merged([detMatch()], [negative()]);
    const { result } = applyNegativeSuppression(input);
    expect(result.matches).toHaveLength(1); // evidence retained
    expect(result.facts).toHaveLength(0); // fact removed
  });

  it("mixes soft-drop + deterministic-demote in one pass", () => {
    const input = merged(
      [detMatch({ floorEligible: true }), softMatch()],
      [negative()],
    );
    const { result, decisions } = applyNegativeSuppression(input);

    expect(result.matches).toHaveLength(1);
    expect(result.matches[0].hitType).toBe("deterministic_ioc");
    expect(result.matches[0].floorEligible).toBe(false);
    expect(result.facts).toHaveLength(0);
    expect(decisions.map((d) => d.action).sort()).toEqual([
      "demoted_deterministic",
      "dropped_soft",
    ]);
  });

  it("monotonic-floor safety: a negative hit never creates a flooring match", () => {
    // No positive matches at all — only a negative hit. Suppression must not
    // synthesize a positive/flooring match out of the negative signal.
    const input = merged([], [negative()]);
    const { result } = applyNegativeSuppression(input);
    expect(result.matches).toHaveLength(0);
    expect(result.matches.some(matchSatisfiesFloor)).toBe(false);
  });

  it("never leaks a raw indicator into the decision payload", () => {
    const input = merged([detMatch(), softMatch()], [negative()]);
    const { decisions } = applyNegativeSuppression(input);
    expect(JSON.stringify(decisions)).not.toContain(INDICATOR.value);
  });
});
