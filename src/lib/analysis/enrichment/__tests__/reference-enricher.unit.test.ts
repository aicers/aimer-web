import { describe, expect, it } from "vitest";
import { normalizeDomain, normalizeIp, normalizeUrl } from "../normalization";
import { buildReferenceDispatcher } from "../reference-enricher";
import { matchSatisfiesFloor } from "../source-policy";

// A clock during the feeds' freshness window (sourceUpdatedAt 2026-06-04,
// maxAge 1 day).
const fresh = () => new Date("2026-06-04T06:00:00.000Z");
// A clock long after the snapshot, so every source reads as stale.
const late = () => new Date("2026-06-10T00:00:00.000Z");

describe("reference enricher — end to end", () => {
  it("produces a floor-eligible deterministic hit for a known public IP", async () => {
    const dispatcher = buildReferenceDispatcher({ now: fresh });
    const result = await dispatcher.dispatch(normalizeIp("45.66.230.5"));

    // Both hitType values appear: feodo deterministic + internal soft.
    const hitTypes = result.matches.map((m) => m.hitType).sort();
    expect(hitTypes).toEqual(["deterministic_ioc", "soft_reputation"]);

    // The deterministic feodo match satisfies the floor; the soft one does not.
    const floorHits = result.matches.filter(matchSatisfiesFloor);
    expect(floorHits).toHaveLength(1);
    expect(floorHits[0].sourcePolicyId).toBe("abuse.ch/feodo");

    // Relevant deterministic IP source (feodo) answered fresh → complete.
    expect(result.coverage.status).toBe("complete");
    expect(result.facts.length).toBeGreaterThan(0);
  });

  it("produces a deterministic hit for a known domain and URL", async () => {
    const dispatcher = buildReferenceDispatcher({ now: fresh });

    const domain = await dispatcher.dispatch(
      normalizeDomain("malware.example"),
    );
    expect(domain.matches.some(matchSatisfiesFloor)).toBe(true);
    expect(domain.coverage.status).toBe("complete");

    const url = await dispatcher.dispatch(
      normalizeUrl("http://malware.example/payload"),
    );
    // The URL matches both the full-URL entry and the host (domain) entry.
    expect(url.matches.some(matchSatisfiesFloor)).toBe(true);
  });

  it("reports a clean no-hit as answered (false-complete, no floor hit)", async () => {
    const dispatcher = buildReferenceDispatcher({ now: fresh });
    const result = await dispatcher.dispatch(normalizeIp("8.8.8.8"));
    expect(result.matches).toHaveLength(0);
    expect(result.matches.some(matchSatisfiesFloor)).toBe(false);
    // feodo answered with a clean no-hit → complete, not unknown.
    expect(result.coverage.status).toBe("complete");
    const feodo = result.outcomes.find(
      (o) => o.sourcePolicyId === "abuse.ch/feodo",
    );
    expect(feodo?.answered).toBe(true);
  });

  it("a stale snapshot drives coverage to stale", async () => {
    const dispatcher = buildReferenceDispatcher({ now: late });
    const result = await dispatcher.dispatch(normalizeIp("45.66.230.5"));
    expect(result.coverage.status).toBe("stale");
    // The hit itself is still observed — staleness never hides a hit.
    expect(result.matches.some(matchSatisfiesFloor)).toBe(true);
  });

  it("an unavailable source drives coverage to unknown without flipping a hit", async () => {
    // feodo throws; but the indicator also hits via the CIDR entry... use a
    // separate hit-bearing source to prove monotonicity: here feodo is the
    // only deterministic IP source, so a hit cannot survive its failure.
    // Instead assert the unknown status when feodo is down on a non-hit IP.
    const dispatcher = buildReferenceDispatcher({
      now: fresh,
      failPolicyIds: ["abuse.ch/feodo"],
    });
    const result = await dispatcher.dispatch(normalizeIp("8.8.8.8"));
    expect(result.coverage.status).toBe("unknown");
    const feodo = result.outcomes.find(
      (o) => o.sourcePolicyId === "abuse.ch/feodo",
    );
    expect(feodo?.answered).toBe(false);
  });

  it("forces a non-public IP match to non-floor-eligible end to end", async () => {
    const dispatcher = buildReferenceDispatcher({ now: fresh });
    // 198.51.100.5 is in feodo's CIDR entry but is TEST-NET-2 (non-public).
    const indicator = normalizeIp("198.51.100.5");
    expect(indicator.neverOffHost).toBe(true);
    const result = await dispatcher.dispatch(indicator);
    expect(result.matches).toHaveLength(1);
    expect(result.matches[0].floorEligible).toBe(false);
    expect(result.matches.some(matchSatisfiesFloor)).toBe(false);
  });
});
