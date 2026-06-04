// RFC 0003 P1a — coverage status (RFC §"Audit / evidence model").
//
// `coverageStatus` is computed from the merged `outcomes[]` (§2) against the
// source-policy registry's *relevant deterministic sources* for the
// indicator's entity type. It is SEPARATE from the `known_ioc_hit` boolean:
// the boolean is monotonic in observed hits, missing coverage is reported via
// status — never by hiding a hit.

import type { SourcePolicyRegistry } from "./source-policy";
import type { CoverageReport, EntityType, SourceOutcome } from "./types";

/**
 * Per-relevant-source classification (RFC §6):
 *   - `fresh`         — answered and within `maxAge`
 *   - `stale`         — answered but past `maxAge`
 *   - `unavailable`   — an outcome exists but `answered === false` (the source
 *                       was attempted and failed, or its registered enricher
 *                       threw/omitted and the dispatcher augmented it)
 *   - `not_attempted` — no outcome at all (no enricher backs this relevant
 *                       deterministic source) — partial coverage, not failure
 */
type SourceState = "fresh" | "stale" | "unavailable" | "not_attempted";

function classify(
  outcome: SourceOutcome | undefined,
  maxAge: number,
  checkedAtMs: number,
): SourceState {
  if (outcome === undefined) return "not_attempted";
  if (outcome.answered !== true) return "unavailable";
  // Answered. A missing `sourceUpdatedAt` cannot prove staleness, so an
  // answered source with no snapshot timestamp is treated as fresh (a clean
  // no-hit still counts toward `complete`).
  if (outcome.sourceUpdatedAt === undefined) return "fresh";
  const updatedMs = Date.parse(outcome.sourceUpdatedAt);
  if (Number.isNaN(updatedMs)) return "fresh";
  return checkedAtMs - updatedMs > maxAge ? "stale" : "fresh";
}

/**
 * Compute coverage status from the merged outcomes. Relevant deterministic
 * sources come from the registry (§3); for each, its outcome is classified
 * and collapsed to a single enum by most-severe-wins precedence (§6):
 *
 *   1. any unavailable                 → `unknown`
 *   2. else any stale                  → `stale`
 *   3. else answered < expected (a relevant source was not attempted)
 *                                      → `partial`
 *   4. else all fresh                  → `complete`
 *
 * Raw counts are recorded alongside the enum so the collapse never hides
 * detail. `false-complete` (all sources answered fresh, zero matches) is thus
 * distinguishable from `false-unknown` (a source was unavailable).
 */
export function computeCoverage(
  entityType: EntityType,
  outcomes: readonly SourceOutcome[],
  registry: SourcePolicyRegistry,
  checkedAt: string,
): CoverageReport {
  const checkedAtMs = Date.parse(checkedAt);
  const relevant = registry.relevantDeterministic(entityType);

  // Index outcomes by source policy id. If the same source appears more than
  // once, prefer an answered outcome (an answered source should not be hidden
  // by a stray unavailable duplicate — boolean monotonicity at the source
  // level).
  const byId = new Map<string, SourceOutcome>();
  for (const outcome of outcomes) {
    const existing = byId.get(outcome.sourcePolicyId);
    if (!existing || (!existing.answered && outcome.answered)) {
      byId.set(outcome.sourcePolicyId, outcome);
    }
  }

  let freshCount = 0;
  let staleCount = 0;
  let unavailableCount = 0;
  let notAttemptedCount = 0;
  for (const policy of relevant) {
    const state = classify(
      byId.get(policy.sourcePolicyId),
      policy.maxAge,
      checkedAtMs,
    );
    if (state === "fresh") freshCount += 1;
    else if (state === "stale") staleCount += 1;
    else if (state === "unavailable") unavailableCount += 1;
    else notAttemptedCount += 1;
  }

  const expectedCount = relevant.length;
  const answeredCount = freshCount + staleCount;

  let status: CoverageReport["status"];
  if (unavailableCount > 0) {
    status = "unknown";
  } else if (staleCount > 0) {
    status = "stale";
  } else if (answeredCount < expectedCount) {
    status = "partial";
  } else {
    status = "complete";
  }

  return {
    status,
    expectedCount,
    answeredCount,
    freshCount,
    staleCount,
    unavailableCount,
    notAttemptedCount,
  };
}
