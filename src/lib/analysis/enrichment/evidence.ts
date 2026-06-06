// RFC 0003 P1a — evidence-record model (RFC §"Audit / evidence model").
// This is the populated model; persistence lives in `enrichment-worker.ts`
// (the evidence-persist path writing `story_ioc_evidence`).
//
// Evidence stores indicators exactly like the rest of the redaction layer:
// external indicators raw and customer-asset indicators as tokens (the
// original lives only in the existing encrypted redaction map). The
// `redactionToken` carries that value (raw for external, token for
// customer-asset), so no separate HMAC scheme is needed — external
// indicators are self-sufficient and customer-asset ones are recoverable
// via the redaction map, the same trade-off the redaction layer already
// makes.

import type { CoverageReport, EnrichmentMatch, HitType } from "./types";

/**
 * The evidence record (RFC §"Audit / evidence model"). Stores enough to
 * explain a `known_ioc_hit` after the fact: the redaction-consistent
 * indicator reference plus the source/provenance fields. Persisted as a
 * `story_ioc_evidence` row by the worker's evidence-persist path.
 */
export interface EvidenceRecord {
  /**
   * The redaction-consistent indicator reference: the raw value for an
   * external indicator, or a `<<REDACTED_*_NNN>>` token for a customer-asset
   * indicator (whose original lives only in the existing redaction map).
   */
  redactionToken: string;
  /**
   * The event redaction-map scope this evidence was extracted under: the
   * `(aice_id, event_key)` key of the `event_redaction_map` row. For a
   * customer-asset `redactionToken` this is what makes the original
   * recoverable — token numbering restarts per event, so the same
   * `<<REDACTED_*_NNN>>` from two members maps to different values and the
   * token alone is ambiguous. For a raw external indicator it is provenance
   * (which member event the hit came from).
   */
  sourceAiceId: string;
  memberEventKey: string;
  sourcePolicyId: string;
  sourceVersion?: string;
  feedHash?: string;
  sourceUpdatedAt?: string;
  hitType: HitType;
  floorEligible: boolean;
  checkedAt: string;
  expiresAt?: string;
  /**
   * The coverage report for the dispatch this match came from (RFC §6 — "record
   * the raw counts ... alongside the enum on the result/evidence"). Carrying it
   * here gives the evidence-persist path a typed home for `coverageStatus`
   * + counts so it need not invent fields outside this foundation. It is the
   * same per-indicator `CoverageReport` the dispatcher puts on
   * `MergedEnrichmentResult`; stamping it onto each per-match record keeps every
   * evidence row self-describing about how complete the scan was when the match
   * was found. Optional because a single enricher's result (pre-merge) has no
   * coverage view — only the dispatcher computes it.
   */
  coverage?: CoverageReport;
}

export interface BuildEvidenceParams {
  match: EnrichmentMatch;
  redactionToken: string;
  /** The `(aice_id, event_key)` map scope (see `EvidenceRecord`). */
  sourceAiceId: string;
  memberEventKey: string;
  checkedAt: string;
  expiresAt?: string;
  /** Coverage report from the merged dispatch result (see `EvidenceRecord`). */
  coverage?: CoverageReport;
}

/**
 * Populate an evidence record from a match + its indicator. The returned
 * object is what the worker's evidence-persist path writes as a
 * `story_ioc_evidence` row.
 */
export function buildEvidenceRecord(
  params: BuildEvidenceParams,
): EvidenceRecord {
  return {
    redactionToken: params.redactionToken,
    sourceAiceId: params.sourceAiceId,
    memberEventKey: params.memberEventKey,
    sourcePolicyId: params.match.sourcePolicyId,
    sourceVersion: params.match.sourceVersion,
    feedHash: params.match.feedHash,
    sourceUpdatedAt: params.match.sourceUpdatedAt,
    hitType: params.match.hitType,
    floorEligible: params.match.floorEligible,
    checkedAt: params.checkedAt,
    expiresAt: params.expiresAt,
    coverage: params.coverage,
  };
}
