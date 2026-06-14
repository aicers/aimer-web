// RFC 0003 F5 (#599) — the negative layer's suppression pass.
//
// MISP warninglists (RFC 0003 Appendix A) are a known-good / known-noisy set
// (public DNS resolvers, CDNs, bogons, top-sites), not a known-bad feed. When
// an indicator hits such a `negative` source it is a likely false positive, so
// this pass suppresses / down-weights that indicator's POSITIVE matches before
// they reach the floor, the evidence surface, and the narrative fact channel.
//
// It runs as ONE function over a single indicator's merged dispatch result, at
// the dispatcher / merged-result boundary, AFTER the merge and BEFORE
// `matchSatisfiesFloor` / evidence persistence / fact collection — so both the
// story (`enrichment-worker`) and loose-event (`event-enrichment-worker`)
// workers, and the fact channel, are covered by the same code once. The
// function does not know the event scope (`member_event_key` / `eventKey` live
// only in the workers), so it RETURNS the dropped-match decisions and the
// worker attaches scope + emits the observability log.
//
// v1 suppression policy (conservative, tunable — Appendix A is explicit that a
// warninglisted indicator must never feed `known_ioc_hit`):
//
//   - Force `floorEligible = false` on every positive match for the indicator,
//     so a warninglisted indicator can never drive `known_ioc_hit` (the hard
//     requirement).
//   - DROP `soft_reputation` matches entirely (from both the evidence surface
//     and the fact channel) — they are likely FPs. The drop is recorded for
//     observability, not silently lost.
//   - KEEP `deterministic_ioc` matches as floor-INELIGIBLE evidence (the hit
//     is still audited and explainable), but they no longer fire the floor.
//   - REGENERATE facts (do not filter): `EnrichmentFact` carries no link back
//     to its originating match, so the pre-built `facts[]` cannot be filtered.
//     Under suppression EVERY match is for the warninglisted indicator, so the
//     fact-eligible set is empty and the regenerated fact list is empty — even
//     the retained deterministic evidence produces NO fact. The fact set is
//     therefore a strict subset of the evidence set (evidence keeps the
//     audited deterministic hit; facts do not).
//
// This is a v1 stance and revisitable: a later phase could instead emit a
// context-aware "listed but warninglisted" fact rather than dropping it.
//
// Forward-only (Scope §5): this prevents a NEW `known_ioc_hit = true` and NEW
// floor evidence; it does not retroactively flip an already-stored hit or
// delete prior floor evidence (the persist path is monotonic OR / class-scoped
// replace). Re-processing results stored before a negative source existed is
// out of scope.
//
// No-negative-source invariant: when `negativeMatches` is empty the merged
// result is returned UNCHANGED (same object) and no decisions are produced, so
// with only positive sources matching / floor / coverage / evidence / facts
// are byte-for-byte unchanged.

import { buildFactsFromMatches } from "./local-feed-enricher";
import type { EnrichmentMatch, HitType, MergedEnrichmentResult } from "./types";

/**
 * One suppression decision, recorded so the worker can attach event scope and
 * emit an observability log. Carries NO raw indicator (privacy) — only
 * source / confidence / hit class / action.
 */
export interface SuppressionDecision {
  /** The suppressed positive match's source policy. */
  sourcePolicyId: string;
  /** The suppressed match's intrinsic hit type. */
  hitType: HitType;
  /** The suppressed match's confidence, if any. */
  confidence?: number;
  /**
   * What happened to the match:
   *   - `dropped_soft` — a `soft_reputation` match removed from evidence + facts.
   *   - `demoted_deterministic` — a `deterministic_ioc` match forced
   *     floor-ineligible (retained as evidence, removed from facts).
   */
  action: "dropped_soft" | "demoted_deterministic";
}

/** The suppression pass result: the (possibly) rewritten merged result + decisions. */
export interface SuppressionResult {
  /**
   * The merged result after suppression. When no negative hit was present this
   * is the SAME object passed in (no-op). Otherwise it has soft matches
   * dropped, deterministic matches forced floor-ineligible, and facts
   * regenerated from the (empty) fact-eligible set.
   */
  result: MergedEnrichmentResult;
  /** Dropped/demoted-match decisions for the worker to scope + log. */
  decisions: SuppressionDecision[];
}

/**
 * Apply the v1 negative-layer suppression policy to one indicator's merged
 * dispatch result. See the file header for the full policy and invariants.
 */
export function applyNegativeSuppression(
  merged: MergedEnrichmentResult,
): SuppressionResult {
  const negatives = merged.negativeMatches ?? [];
  // No negative hit for this indicator → byte-for-byte unchanged (the whole
  // point of the no-negative-source regression guarantee). Return the same
  // object so nothing downstream can observe a difference.
  if (negatives.length === 0) {
    return { result: merged, decisions: [] };
  }

  const decisions: SuppressionDecision[] = [];
  const keptMatches: EnrichmentMatch[] = [];
  for (const match of merged.matches) {
    if (match.hitType === "soft_reputation") {
      // Likely FP — drop from both the evidence surface and the fact channel.
      decisions.push({
        sourcePolicyId: match.sourcePolicyId,
        hitType: match.hitType,
        confidence: match.confidence,
        action: "dropped_soft",
      });
      continue;
    }
    // Deterministic: retained as floor-INELIGIBLE evidence (explainable), but
    // it can no longer fire the floor.
    decisions.push({
      sourcePolicyId: match.sourcePolicyId,
      hitType: match.hitType,
      confidence: match.confidence,
      action: "demoted_deterministic",
    });
    keptMatches.push(
      match.floorEligible ? { ...match, floorEligible: false } : match,
    );
  }

  // Regenerate facts from the fact-eligible matches only — i.e. excluding every
  // match for this (warninglisted) indicator. Since all matches here are for
  // the one warninglisted indicator, the fact-eligible set is empty, so this
  // yields no facts. Building via `buildFactsFromMatches` over the empty set
  // (rather than hard-coding `[]`) keeps the "regenerate, do not filter"
  // mechanism explicit and correct if the v1 policy is later relaxed.
  const facts = buildFactsFromMatches(merged.indicator, []);

  return {
    result: { ...merged, matches: keptMatches, facts },
    decisions,
  };
}
