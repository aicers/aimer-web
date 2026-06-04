import { describe, expect, it } from "vitest";
import { EnrichmentDispatcher } from "../dispatcher";
import { normalizeIp } from "../normalization";
import { FixtureEnricher, type FixtureFeed } from "../reference-enricher";
import {
  matchSatisfiesFloor,
  type SourcePolicy,
  SourcePolicyRegistry,
} from "../source-policy";
import type { Enricher, EntityType, NormalizedIndicator } from "../types";

const NOW = new Date("2026-06-04T12:00:00.000Z");
const FRESH = "2026-06-04T11:30:00.000Z";

function ipPolicy(id: string, floorEligible = true): SourcePolicy {
  return {
    sourcePolicyId: id,
    label: id,
    entityTypes: ["IP"],
    deterministicCoverage: true,
    maxAge: 60 * 60 * 1000,
    floorEligible,
  };
}

function ipFeed(
  id: string,
  matchValue: string,
  expiresAt: string,
): FixtureFeed {
  return {
    sourcePolicyId: id,
    source: id,
    entityTypes: ["IP"],
    sourceUpdatedAt: FRESH,
    expiresAt,
    entries: [{ matchValue, hitType: "deterministic_ioc" }],
  };
}

function build(policies: SourcePolicy[]): {
  dispatcher: EnrichmentDispatcher;
  registry: SourcePolicyRegistry;
} {
  const registry = new SourcePolicyRegistry(policies);
  const dispatcher = new EnrichmentDispatcher({ registry, now: () => NOW });
  return { dispatcher, registry };
}

describe("EnrichmentDispatcher", () => {
  it("fans an indicator out to every supports()-matching enricher", async () => {
    const { dispatcher, registry } = build([ipPolicy("a"), ipPolicy("b")]);
    dispatcher.register({
      enricher: new FixtureEnricher({
        feed: ipFeed("a", "45.66.230.5", "2026-06-05T00:00:00.000Z"),
        policy: registry.get("a") as SourcePolicy,
      }),
      sourcePolicyIds: ["a"],
    });
    dispatcher.register({
      enricher: new FixtureEnricher({
        feed: ipFeed("b", "45.66.230.5", "2026-06-06T00:00:00.000Z"),
        policy: registry.get("b") as SourcePolicy,
      }),
      sourcePolicyIds: ["b"],
    });

    const result = await dispatcher.dispatch(normalizeIp("45.66.230.5"));
    expect(result.matches.map((m) => m.sourcePolicyId).sort()).toEqual([
      "a",
      "b",
    ]);
  });

  it("does NOT invoke enrichers that do not support the entity type", async () => {
    const { dispatcher, registry } = build([ipPolicy("a")]);
    let calls = 0;
    const domainOnly: Enricher = {
      supports: (e: EntityType) => e === "DOMAIN",
      enrich: async (indicator: NormalizedIndicator) => {
        calls += 1;
        return {
          indicator,
          matches: [],
          facts: [],
          errors: [],
          outcomes: [],
          checkedAt: "",
        };
      },
    };
    dispatcher.register({ enricher: domainOnly, sourcePolicyIds: ["dom"] });
    dispatcher.register({
      enricher: new FixtureEnricher({
        feed: ipFeed("a", "45.66.230.5", "2026-06-05T00:00:00.000Z"),
        policy: registry.get("a") as SourcePolicy,
      }),
      sourcePolicyIds: ["a"],
    });
    await dispatcher.dispatch(normalizeIp("45.66.230.5"));
    expect(calls).toBe(0);
  });

  it("sets checkedAt to the dispatch-start instant from the injected clock", async () => {
    const { dispatcher } = build([]);
    const result = await dispatcher.dispatch(normalizeIp("45.66.230.5"));
    expect(result.checkedAt).toBe(NOW.toISOString());
  });

  it("merges expiresAt as the minimum across answering sources", async () => {
    const { dispatcher, registry } = build([ipPolicy("a"), ipPolicy("b")]);
    dispatcher.register({
      enricher: new FixtureEnricher({
        feed: ipFeed("a", "45.66.230.5", "2026-06-05T00:00:00.000Z"),
        policy: registry.get("a") as SourcePolicy,
      }),
      sourcePolicyIds: ["a"],
    });
    dispatcher.register({
      enricher: new FixtureEnricher({
        feed: ipFeed("b", "45.66.230.5", "2026-06-04T18:00:00.000Z"),
        policy: registry.get("b") as SourcePolicy,
      }),
      sourcePolicyIds: ["b"],
    });
    const result = await dispatcher.dispatch(normalizeIp("45.66.230.5"));
    expect(result.expiresAt).toBe("2026-06-04T18:00:00.000Z");
  });

  it("concatenates outcomes and augments a throwing registered enricher to unavailable", async () => {
    const { dispatcher, registry } = build([ipPolicy("a"), ipPolicy("b")]);
    dispatcher.register({
      enricher: new FixtureEnricher({
        feed: ipFeed("a", "45.66.230.5", "2026-06-05T00:00:00.000Z"),
        policy: registry.get("a") as SourcePolicy,
      }),
      sourcePolicyIds: ["a"],
    });
    dispatcher.register({
      enricher: new FixtureEnricher({
        feed: ipFeed("b", "45.66.230.5", "2026-06-05T00:00:00.000Z"),
        policy: registry.get("b") as SourcePolicy,
        failWith: { sourcePolicyId: "b", kind: "timeout", message: "boom" },
      }),
      sourcePolicyIds: ["b"],
    });
    const result = await dispatcher.dispatch(normalizeIp("45.66.230.5"));
    const b = result.outcomes.find((o) => o.sourcePolicyId === "b");
    expect(b?.answered).toBe(false);
    expect(result.coverage.status).toBe("unknown");
  });

  it("augments a registered enricher that omits its outcome to unavailable", async () => {
    const { dispatcher } = build([ipPolicy("a")]);
    const omitting: Enricher = {
      supports: () => true,
      enrich: async (indicator: NormalizedIndicator) => ({
        indicator,
        matches: [],
        facts: [],
        errors: [],
        outcomes: [], // omits its SourceOutcome
        checkedAt: "",
      }),
    };
    dispatcher.register({ enricher: omitting, sourcePolicyIds: ["a"] });
    const result = await dispatcher.dispatch(normalizeIp("45.66.230.5"));
    expect(result.outcomes).toHaveLength(1);
    expect(result.outcomes[0]).toMatchObject({
      sourcePolicyId: "a",
      answered: false,
    });
    expect(result.coverage.status).toBe("unknown");
  });

  it("a down source downgrades coverage to unknown without hiding another source's hit", async () => {
    // Source `a` hits (floor-eligible deterministic); source `b` throws.
    const { dispatcher, registry } = build([ipPolicy("a"), ipPolicy("b")]);
    dispatcher.register({
      enricher: new FixtureEnricher({
        feed: ipFeed("a", "45.66.230.5", "2026-06-05T00:00:00.000Z"),
        policy: registry.get("a") as SourcePolicy,
      }),
      sourcePolicyIds: ["a"],
    });
    dispatcher.register({
      enricher: new FixtureEnricher({
        feed: ipFeed("b", "45.66.230.5", "2026-06-05T00:00:00.000Z"),
        policy: registry.get("b") as SourcePolicy,
        failWith: { sourcePolicyId: "b", kind: "timeout", message: "down" },
      }),
      sourcePolicyIds: ["b"],
    });
    const result = await dispatcher.dispatch(normalizeIp("45.66.230.5"));
    // The hit from `a` is preserved (monotonic boolean) ...
    expect(result.matches.some(matchSatisfiesFloor)).toBe(true);
    // ... while the down source `b` only downgrades coverage.
    expect(result.coverage.status).toBe("unknown");
  });

  it("rewrites a match's floorEligible from the registry, not the enricher", async () => {
    // Policy `a` is NOT floor-eligible, but a misbehaving adapter returns a
    // deterministic match claiming `floorEligible: true`. The registry is the
    // authority, so the dispatcher must correct it back to false.
    const { dispatcher } = build([ipPolicy("a", false)]);
    const lyingEnricher: Enricher = {
      supports: () => true,
      enrich: async (indicator: NormalizedIndicator) => ({
        indicator,
        matches: [
          {
            source: "a",
            sourcePolicyId: "a",
            hitType: "deterministic_ioc",
            floorEligible: true, // wrong: policy says false
          },
        ],
        facts: [],
        errors: [],
        outcomes: [
          { sourcePolicyId: "a", answered: true, sourceUpdatedAt: FRESH },
        ],
        checkedAt: "",
      }),
    };
    dispatcher.register({ enricher: lyingEnricher, sourcePolicyIds: ["a"] });
    const result = await dispatcher.dispatch(normalizeIp("45.66.230.5"));
    expect(result.matches).toHaveLength(1);
    expect(result.matches[0].floorEligible).toBe(false);
    expect(result.matches.some(matchSatisfiesFloor)).toBe(false);
  });

  it("forces floorEligible=false for a match whose policy is unknown to the registry", async () => {
    // No policy registered for `ghost`; a match citing it has nothing to
    // authorize the floor, so it cannot be floor-eligible.
    const { dispatcher } = build([]);
    const ghostEnricher: Enricher = {
      supports: () => true,
      enrich: async (indicator: NormalizedIndicator) => ({
        indicator,
        matches: [
          {
            source: "ghost",
            sourcePolicyId: "ghost",
            hitType: "deterministic_ioc",
            floorEligible: true,
          },
        ],
        facts: [],
        errors: [],
        outcomes: [],
        checkedAt: "",
      }),
    };
    dispatcher.register({
      enricher: ghostEnricher,
      sourcePolicyIds: ["ghost"],
    });
    const result = await dispatcher.dispatch(normalizeIp("45.66.230.5"));
    expect(result.matches[0].floorEligible).toBe(false);
    expect(result.matches.some(matchSatisfiesFloor)).toBe(false);
  });

  it("forces floorEligible=false for a non-public IP regardless of policy", async () => {
    const { dispatcher, registry } = build([ipPolicy("a", true)]);
    dispatcher.register({
      enricher: new FixtureEnricher({
        feed: ipFeed("a", "10.0.0.1", "2026-06-05T00:00:00.000Z"),
        policy: registry.get("a") as SourcePolicy,
      }),
      sourcePolicyIds: ["a"],
    });
    const indicator = normalizeIp("10.0.0.1");
    expect(indicator.isPublic).toBe(false);
    const result = await dispatcher.dispatch(indicator);
    expect(result.matches).toHaveLength(1);
    expect(result.matches[0].floorEligible).toBe(false);
  });
});
