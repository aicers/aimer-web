import { describe, expect, it } from "vitest";
import { normalizeIp } from "../normalization";
import {
  matchSatisfiesFloor,
  resolveFloorEligible,
  type SourcePolicy,
  SourcePolicyRegistry,
} from "../source-policy";
import type { EnrichmentMatch } from "../types";

function match(overrides: Partial<EnrichmentMatch>): EnrichmentMatch {
  return {
    source: "test",
    sourcePolicyId: "test",
    hitType: "deterministic_ioc",
    floorEligible: true,
    ...overrides,
  };
}

const floorEligiblePolicy: SourcePolicy = {
  sourcePolicyId: "feed/a",
  label: "Feed A",
  entityTypes: ["IP"],
  deterministicCoverage: true,
  maxAge: 1000,
  floorEligible: true,
};

describe("matchSatisfiesFloor", () => {
  it("is true only for a floor-eligible deterministic IOC hit", () => {
    expect(
      matchSatisfiesFloor(
        match({ hitType: "deterministic_ioc", floorEligible: true }),
      ),
    ).toBe(true);
  });

  it("is false for a soft_reputation match even when floorEligible", () => {
    expect(
      matchSatisfiesFloor(
        match({ hitType: "soft_reputation", floorEligible: true }),
      ),
    ).toBe(false);
  });

  it("is false for a deterministic IOC match with floorEligible=false", () => {
    expect(
      matchSatisfiesFloor(
        match({ hitType: "deterministic_ioc", floorEligible: false }),
      ),
    ).toBe(false);
  });
});

describe("resolveFloorEligible", () => {
  it("returns the policy value for a public IP", () => {
    const indicator = normalizeIp("45.66.230.5");
    expect(resolveFloorEligible(floorEligiblePolicy, indicator)).toBe(true);
  });

  it("forces false for a non-public IP regardless of policy", () => {
    const indicator = normalizeIp("10.0.0.1");
    expect(resolveFloorEligible(floorEligiblePolicy, indicator)).toBe(false);
  });
});

describe("SourcePolicyRegistry", () => {
  it("returns relevant deterministic sources for an entity type", () => {
    const registry = new SourcePolicyRegistry([
      floorEligiblePolicy,
      {
        sourcePolicyId: "feed/soft",
        label: "Soft",
        entityTypes: ["IP"],
        deterministicCoverage: false,
        maxAge: 1000,
        floorEligible: false,
      },
      {
        sourcePolicyId: "feed/dom",
        label: "Domain feed",
        entityTypes: ["DOMAIN"],
        deterministicCoverage: true,
        maxAge: 1000,
        floorEligible: true,
      },
    ]);
    const relevant = registry.relevantDeterministic("IP");
    expect(relevant.map((p) => p.sourcePolicyId)).toEqual(["feed/a"]);
    expect(
      registry.relevantDeterministic("DOMAIN").map((p) => p.sourcePolicyId),
    ).toEqual(["feed/dom"]);
  });
});
