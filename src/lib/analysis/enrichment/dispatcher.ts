// RFC 0003 P1a — registration + per-entity dispatch + result merge (RFC
// §"Pluggable enricher interface", issue §2).
//
// The dispatcher is the single producer (the "enrich once" invariant): given
// a `NormalizedIndicator` it routes to every registered enricher whose
// `supports(entityType)` is true, runs them, and merges their results into
// one. No consumer calls a TI source directly. An injectable `now` keeps
// `checkedAt` and stale computation deterministically testable.

import { computeCoverage } from "./coverage";
import {
  resolveFloorEligible,
  type SourcePolicyRegistry,
} from "./source-policy";
import type {
  Enricher,
  EnricherError,
  EnrichmentFact,
  EnrichmentMatch,
  MergedEnrichmentResult,
  NegativeMatch,
  NormalizedIndicator,
  SourceOutcome,
} from "./types";

/**
 * Registration declares responsibility: an enricher is registered together
 * with the `sourcePolicyId`s it backs. One enricher may back several
 * (e.g. a future MISP adapter exposing multiple feeds), so this is a list.
 */
export interface EnricherRegistration {
  enricher: Enricher;
  sourcePolicyIds: string[];
}

export interface DispatcherOptions {
  registry: SourcePolicyRegistry;
  /** Injectable clock; defaults to the real clock. */
  now?: () => Date;
}

/** Earlier of two ISO timestamps, treating `undefined` as "no bound". */
function minTimestamp(
  a: string | undefined,
  b: string | undefined,
): string | undefined {
  if (a === undefined) return b;
  if (b === undefined) return a;
  return Date.parse(a) <= Date.parse(b) ? a : b;
}

export class EnrichmentDispatcher {
  private readonly registrations: EnricherRegistration[] = [];
  private readonly registry: SourcePolicyRegistry;
  private readonly now: () => Date;

  constructor(options: DispatcherOptions) {
    this.registry = options.registry;
    this.now = options.now ?? (() => new Date());
  }

  register(registration: EnricherRegistration): void {
    this.registrations.push(registration);
  }

  /**
   * Dispatch one indicator to all `supports()`-matching enrichers and merge.
   * Merge rules (issue §2):
   *   - `matches` / `facts` / `errors` / `outcomes` — concatenated;
   *   - `checkedAt` — the single dispatch-start instant (not per-source);
   *   - `expiresAt` — the minimum TTL across answering sources;
   *   - `outcomes` — augmented so every expected deterministic source that
   *     produced no outcome (enricher threw or omitted it) is recorded as
   *     `unavailable`. The merged `outcomes[]` is the sole input to coverage.
   * `floorEligible` on every match is (re)derived from the active source
   * policy via `resolveFloorEligible`, not trusted from the enricher — the
   * registry is the authority for floor eligibility, and the non-public IP
   * override is applied there too. A match whose `sourcePolicyId` is unknown
   * to the registry is forced `floorEligible = false` (no policy authorizes
   * it to drive the floor).
   */
  async dispatch(
    indicator: NormalizedIndicator,
  ): Promise<MergedEnrichmentResult> {
    const checkedAt = this.now().toISOString();
    const applicable = this.registrations.filter((r) =>
      r.enricher.supports(indicator.entityType),
    );

    let matches: EnrichmentMatch[] = [];
    // RFC 0003 F5 (#599): negative-layer (warninglist) hits, merged on their
    // own channel — NEVER concatenated into `matches`, so a negative source
    // can never leak in as a positive match. The suppression pass reads these.
    const negativeMatches: NegativeMatch[] = [];
    const facts: EnrichmentFact[] = [];
    const errors: EnricherError[] = [];
    const outcomes: SourceOutcome[] = [];
    let expiresAt: string | undefined;

    const results = await Promise.allSettled(
      applicable.map((r) => r.enricher.enrich(indicator)),
    );

    results.forEach((settled, index) => {
      const registration = applicable[index];
      if (settled.status === "fulfilled") {
        const result = settled.value;
        matches.push(...result.matches);
        if (result.negativeMatches) {
          negativeMatches.push(...result.negativeMatches);
        }
        facts.push(...result.facts);
        errors.push(...result.errors);
        outcomes.push(...result.outcomes);
        expiresAt = minTimestamp(expiresAt, result.expiresAt);
      } else {
        // The enricher threw: record an `unavailable` error per declared
        // source so the failure is visible in `errors[]`. The missing
        // `outcomes` are filled by augmentation below.
        for (const sourcePolicyId of registration.sourcePolicyIds) {
          errors.push({
            sourcePolicyId,
            kind: "unavailable",
            message:
              settled.reason instanceof Error
                ? settled.reason.message
                : String(settled.reason),
          });
        }
      }
    });

    // The registry — not the enricher — is the authority for floor
    // eligibility (issue §3). Re-derive `floorEligible` on every merged match
    // from its source policy via `resolveFloorEligible`, which also applies
    // the non-public IP override. An adapter that returns the wrong value
    // (e.g. `floorEligible: true` for a `floorEligible: false` policy) is
    // corrected here. A match whose `sourcePolicyId` is unknown to the
    // registry has no policy to authorize it, so it cannot drive the floor.
    matches = matches.map((m) => {
      const policy = this.registry.get(m.sourcePolicyId);
      const floorEligible = policy
        ? resolveFloorEligible(policy, indicator)
        : false;
      return floorEligible === m.floorEligible ? m : { ...m, floorEligible };
    });

    // Augment outcomes (issue §2): any expected deterministic source that an
    // enricher was REGISTERED to back (per registration + registry) but that
    // produced no outcome — because the enricher threw or omitted it — is
    // recorded as `unavailable`. A relevant deterministic source with NO
    // registered enricher is deliberately NOT augmented: it is "not attempted"
    // (no adapter configured), which coverage reads as partial rather than the
    // stronger unknown that an outright failure warrants.
    const seen = new Set(outcomes.map((o) => o.sourcePolicyId));
    const registeredRelevant = new Set(
      applicable
        .flatMap((r) => r.sourcePolicyIds)
        .filter((id) => {
          const policy = this.registry.get(id);
          return (
            policy?.deterministicCoverage === true &&
            policy.entityTypes.includes(indicator.entityType)
          );
        }),
    );
    for (const sourcePolicyId of registeredRelevant) {
      if (!seen.has(sourcePolicyId)) {
        outcomes.push({
          sourcePolicyId,
          answered: false,
          error: {
            sourcePolicyId,
            kind: "unavailable",
            message: "registered enricher produced no outcome",
          },
        });
      }
    }

    const coverage = computeCoverage(
      indicator.entityType,
      outcomes,
      this.registry,
      checkedAt,
    );

    return {
      indicator,
      matches,
      negativeMatches,
      facts,
      errors,
      outcomes,
      checkedAt,
      expiresAt,
      coverage,
    };
  }
}
