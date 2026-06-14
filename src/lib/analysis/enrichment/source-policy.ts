// RFC 0003 P1a — source-policy registry + floor predicate (RFC §"the
// type-distinction hinge", §"Source taxonomy").
//
// A source policy governs BOTH floor eligibility AND coverage computation,
// not just `floorEligible`. Egress tier and floor eligibility are independent
// axes (RFC §"Source taxonomy") — this registry governs floor eligibility and
// coverage only; egress/opt-in is a later phase.

import type {
  EnrichmentMatch,
  EntityType,
  NormalizedIndicator,
  SourcePolarity,
} from "./types";

/**
 * One source-policy entry. Carries enough to govern both the floor and
 * coverage status (§6): the entity types it covers, whether it counts as a
 * relevant deterministic source for coverage, its staleness bound, and
 * whether its matches may drive the floor.
 */
export interface SourcePolicy {
  sourcePolicyId: string;
  /** Human-readable source identity / label. */
  label: string;
  /**
   * Source polarity (RFC 0003 F5, #599). Omitted ⇒ `positive`. A `negative`
   * source's enricher emits only a suppression signal
   * (`EnrichmentResult.negativeMatches`), never a positive match, and its
   * `deterministicCoverage` / `floorEligible` are both false so it touches
   * neither coverage nor the floor.
   */
  polarity?: SourcePolarity;
  /** Which entity types this source covers. */
  entityTypes: EntityType[];
  /**
   * Whether this source counts as a *relevant deterministic source* for
   * coverage status (§6). A `soft_reputation`-only source is `false`.
   */
  deterministicCoverage: boolean;
  /**
   * Staleness bound (milliseconds). A source whose
   * `checkedAt - sourceUpdatedAt > maxAge` is treated as `stale` (§6).
   */
  maxAge: number;
  /** Whether matches from this source may drive the floor. */
  floorEligible: boolean;
}

/**
 * In-memory registry mapping `sourcePolicyId → SourcePolicy`. Injectable so
 * tests run against a fixture set rather than a global singleton.
 */
export class SourcePolicyRegistry {
  private readonly policies = new Map<string, SourcePolicy>();

  constructor(initial: readonly SourcePolicy[] = []) {
    for (const policy of initial) this.register(policy);
  }

  register(policy: SourcePolicy): void {
    this.policies.set(policy.sourcePolicyId, policy);
  }

  get(sourcePolicyId: string): SourcePolicy | undefined {
    return this.policies.get(sourcePolicyId);
  }

  all(): SourcePolicy[] {
    return [...this.policies.values()];
  }

  /**
   * The *relevant deterministic sources* for an entity type (§6): registered
   * policies whose `entityTypes` include the type AND `deterministicCoverage`
   * is true. This is the expected set coverage status is computed against.
   */
  relevantDeterministic(entityType: EntityType): SourcePolicy[] {
    return this.all().filter(
      (p) => p.deterministicCoverage && p.entityTypes.includes(entityType),
    );
  }
}

/**
 * The floor predicate (RFC §"Pluggable enricher interface"): a match counts
 * toward the floor IFF it is a deterministic IOC hit from a floor-eligible
 * source. The OR-over-members derivation and the `applyLikelihoodFloors`
 * call live in the #361 follow-up; P1a exposes only this per-match predicate.
 */
export function matchSatisfiesFloor(match: EnrichmentMatch): boolean {
  return match.hitType === "deterministic_ioc" && match.floorEligible === true;
}

/**
 * Resolve `floorEligible` for a match from the active source policy, applying
 * the non-public IP override (RFC §"Indicator normalization", normative): a
 * non-public IP forces `floorEligible = false` regardless of source policy.
 * `hitType` is intrinsic to the match and is NOT derived here.
 */
export function resolveFloorEligible(
  policy: SourcePolicy,
  indicator: NormalizedIndicator,
): boolean {
  if (indicator.entityType === "IP" && indicator.isPublic === false) {
    return false;
  }
  return policy.floorEligible;
}
