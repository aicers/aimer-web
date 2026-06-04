// RFC 0003 P1a — evidence-record model + keyed-HMAC stamping (RFC §"Audit /
// evidence model"). MODEL + LOGIC ONLY: no table, no DB write — persistence
// is the #361 follow-up.
//
// The record stores enough to re-verify a match later WITHOUT plaintext: a
// redaction token, a keyed HMAC of the normalized indicator, the HMAC key
// version + normalization version, and the source/provenance fields. The
// HMAC primitive is a small OFFLINE helper (Node `createHmac`) keyed by an
// injectable versioned key ring — deliberately NOT routed through
// `src/lib/crypto/` (OpenBao Transit/envelope). Real secret-store wiring is
// the follow-up's concern.

import { createHmac, timingSafeEqual } from "node:crypto";
import { serializeIndicator } from "./normalization";
import type {
  CoverageReport,
  EnrichmentMatch,
  HitType,
  NormalizedIndicator,
} from "./types";

/**
 * An injectable, versioned HMAC key ring (`hmacKeyVersion → key`). Rotation
 * must RETAIN old versions so prior evidence stays verifiable. Injectability
 * keeps unit tests pure — no OpenBao call.
 */
export class HmacKeyRing {
  private readonly keys: Map<string, string>;
  readonly currentVersion: string;

  constructor(keys: Record<string, string>, currentVersion: string) {
    this.keys = new Map(Object.entries(keys));
    if (!this.keys.has(currentVersion)) {
      throw new Error(
        `current HMAC key version "${currentVersion}" is not in the key ring`,
      );
    }
    this.currentVersion = currentVersion;
  }

  /** Resolve a key by version, or throw if the version is unknown. */
  get(version: string): string {
    const key = this.keys.get(version);
    if (key === undefined) {
      throw new Error(`unknown HMAC key version: ${version}`);
    }
    return key;
  }

  has(version: string): boolean {
    return this.keys.has(version);
  }
}

export interface IndicatorHmac {
  normalizedIndicatorHmac: string;
  hmacKeyVersion: string;
}

/**
 * Compute the keyed HMAC of a normalized indicator. Defaults to the key
 * ring's current version; pass `version` to stamp with a specific (e.g.
 * pre-rotation) key. The message is the deterministic, version-stamped
 * `serializeIndicator` output, so the same indicator+normalizationVersion
 * always digests identically.
 */
export function computeIndicatorHmac(
  indicator: NormalizedIndicator,
  keyRing: HmacKeyRing,
  version: string = keyRing.currentVersion,
): IndicatorHmac {
  const key = keyRing.get(version);
  const normalizedIndicatorHmac = createHmac("sha256", key)
    .update(serializeIndicator(indicator))
    .digest("hex");
  return { normalizedIndicatorHmac, hmacKeyVersion: version };
}

/**
 * Recompute the HMAC for the record's key version and compare in constant
 * time. Lets a stored record be re-confirmed against a feed snapshot without
 * the value in clear — including across a key rotation, because the record
 * carries the `hmacKeyVersion` that produced it.
 */
export function verifyIndicatorHmac(
  indicator: NormalizedIndicator,
  record: Pick<EvidenceRecord, "normalizedIndicatorHmac" | "hmacKeyVersion">,
  keyRing: HmacKeyRing,
): boolean {
  if (!keyRing.has(record.hmacKeyVersion)) return false;
  const recomputed = computeIndicatorHmac(
    indicator,
    keyRing,
    record.hmacKeyVersion,
  ).normalizedIndicatorHmac;
  const a = Buffer.from(recomputed, "hex");
  const b = Buffer.from(record.normalizedIndicatorHmac, "hex");
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/**
 * The evidence record (RFC §"Audit / evidence model"). Stores enough to
 * re-verify a `known_ioc_hit` later without plaintext by default. Persistence
 * is out of P1a scope; this is the populated model only.
 */
export interface EvidenceRecord {
  /** Links evidence back to the masked member. */
  redactionToken: string;
  /** Keyed HMAC of the normalized indicator. */
  normalizedIndicatorHmac: string;
  /** Which key produced the digest (rotation retains old versions). */
  hmacKeyVersion: string;
  /** Optional external key identifier (e.g. a secret-store key id). */
  evidenceKeyId?: string;
  /** Keeps the HMAC interpretable as normalization rules evolve. */
  normalizationVersion: string;
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
   * here gives the #361 persistence follow-up a typed home for `coverageStatus`
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
  indicator: NormalizedIndicator;
  match: EnrichmentMatch;
  redactionToken: string;
  keyRing: HmacKeyRing;
  checkedAt: string;
  expiresAt?: string;
  /** Stamp with a specific key version; defaults to the ring's current. */
  hmacKeyVersion?: string;
  evidenceKeyId?: string;
  /** Coverage report from the merged dispatch result (see `EvidenceRecord`). */
  coverage?: CoverageReport;
}

/**
 * Populate an evidence record from a match + its indicator. No persistence —
 * the returned object is what the #361 follow-up will write.
 */
export function buildEvidenceRecord(
  params: BuildEvidenceParams,
): EvidenceRecord {
  const { normalizedIndicatorHmac, hmacKeyVersion } = computeIndicatorHmac(
    params.indicator,
    params.keyRing,
    params.hmacKeyVersion,
  );
  return {
    redactionToken: params.redactionToken,
    normalizedIndicatorHmac,
    hmacKeyVersion,
    evidenceKeyId: params.evidenceKeyId,
    normalizationVersion: params.indicator.normalizationVersion,
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
