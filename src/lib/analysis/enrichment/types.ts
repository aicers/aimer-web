// RFC 0003 P1a enrichment-layer foundation — core types.
//
// These shapes are normative: they mirror RFC 0003 §"Pluggable enricher
// interface" and §"Audit / evidence model" field-for-field. The whole
// design turns on the `HitType` hinge (deterministic_ioc vs soft_reputation)
// and on keeping `floorEligible` (source-policy driven) separate from
// `hitType` (intrinsic to the match). See `rfcs/0003-external-ti-enrichment.md`.
//
// This module is pure types — no runtime behaviour, no DB, no HTTP.

/**
 * Entity types an indicator can carry. `CVE` is declared for completeness
 * (RFC phasing note) but is out of P1a IOC scope — no normalizer or feed
 * matches CVEs here.
 */
export type EntityType = "IP" | "DOMAIN" | "URL" | "HASH" | "CVE";

/**
 * The type-distinction hinge (RFC §"the type-distinction hinge"). Intrinsic
 * to a match — declared by the enricher, never derived from source policy.
 *   - `deterministic_ioc` — membership in a curated known-bad list; MAY feed
 *     the binary floor (iff `floorEligible`).
 *   - `soft_reputation` — a suggestive score/signal; NEVER drives the floor.
 */
export type HitType = "deterministic_ioc" | "soft_reputation";

/** Hash family, distinguished by digest length. */
export type HashType = "MD5" | "SHA1" | "SHA256";

/**
 * Source polarity (RFC 0003 F5 negative layer, #599). A `positive` source's
 * entries are known-bad/known-noisy signals that may become positive matches
 * (the default — every existing source). A `negative` source's entries are
 * known-good/known-noisy signals (MISP warninglists: public DNS resolvers,
 * CDNs, bogons, top-sites) that SUPPRESS / down-weight an indicator's positive
 * matches. A negative entry must never become a positive `EnrichmentMatch` and
 * must never feed `known_ioc_hit` — it contributes only a suppression signal.
 */
export type SourcePolarity = "positive" | "negative";

/**
 * Per-source failure (RFC interface `EnricherError`). `kind` enumerates the
 * failure classes a source can report; `sourcePolicyId` ties it back to the
 * governing policy.
 */
export type EnricherErrorKind =
  | "timeout"
  | "auth"
  | "rate_limit"
  | "stale"
  | "unavailable";

export interface EnricherError {
  sourcePolicyId: string;
  kind: EnricherErrorKind;
  message: string;
}

/**
 * Derived URL indicators (RFC §"Indicator normalization"). A single URL
 * fans out to three match targets so the follow-up can match each against
 * the appropriate feed: the full canonical URL, its host, and the
 * registered (eTLD+1) domain. `registeredDomain` is `null` when `tldts`
 * cannot derive one (e.g. an IP-literal host or unknown suffix).
 */
export interface DerivedUrlIndicators {
  url: string;
  host: string;
  registeredDomain: string | null;
}

/**
 * The post-normalization value actually matched against feeds (RFC
 * §"Indicator normalization"). Carries the canonical display `value`, the
 * equivalence set `matchValues` a feed may be keyed on, the entity type,
 * normalization-derived classification flags, and the `normalizationVersion`
 * stamp that scopes the enrichment cache key and in-run dedupe as rules
 * evolve. This shape drives matching, not persistence — the evidence record
 * stores the redaction-consistent indicator reference and map scope, not the
 * normalized indicator or its version.
 */
export interface NormalizedIndicator {
  entityType: EntityType;
  /** Canonical display form (e.g. A-label domain, lowercased hash). */
  value: string;
  /**
   * Every equivalent string a feed might key on — matching tries all of
   * them. This is how IDN U-label/A-label equivalence is represented
   * without splitting one indicator into many.
   */
  matchValues: string[];
  normalizationVersion: string;
  /** IP only: `true` iff global unicast (RFC allow-list). */
  isPublic?: boolean;
  /**
   * IP only: set when a non-public IP forces `floorEligible = false`
   * regardless of source policy. Tier 2 egress must later honour this.
   */
  neverOffHost?: boolean;
  /** HASH only: digest family. */
  hashType?: HashType;
  /** URL only: derived indicators for separate matching. */
  derived?: DerivedUrlIndicators;
}

/**
 * Structured report-level context bundled with an indicator (RFC 0003 F6,
 * #594; Appendix A §"Vendor IOC repositories"). Vendor IOC repositories
 * (Unit 42, ESET, Volexity, …) attach actor / campaign / malware-family /
 * blog-link context to each indicator — the first confirmed-clean source of
 * C1 narrative material. All fields are optional; `extra` is a free-form bag
 * for source-specific keys that have no dedicated field. This is per-row feed
 * data (stored in `ioc_feed_snapshot.context`), not a source descriptor
 * field, so context-less feeds simply leave it absent.
 */
export interface EnrichmentContextPayload {
  actor?: string;
  campaign?: string;
  malwareFamily?: string;
  reportUrl?: string;
  extra?: Record<string, unknown>;
}

/**
 * One match for one indicator from one source. An indicator can produce
 * MANY of these across sources/feeds/classifications — never collapsed to a
 * single hit/hitType.
 */
export interface EnrichmentMatch {
  /** Provenance / citation, e.g. "abuse.ch/feodo". */
  source: string;
  /** Which source-policy entry governs this source. */
  sourcePolicyId: string;
  /** Intrinsic to the match (the enricher declares it). */
  hitType: HitType;
  /** Whether the active source policy lets THIS match drive the floor. */
  floorEligible: boolean;
  /** Source-native label, e.g. "c2", "malware", "scanner". */
  classification?: string;
  confidence?: number;
  /**
   * Structured report-level context for context-bearing sources (vendor IOC
   * repositories). Absent for context-less feeds (the Tier-1 IOC feeds). Read
   * from the snapshot's `context` JSONB through a narrowing validator — never
   * trusted as the raw pg value. Carried here for later #589 / #591 consumers.
   */
  contextPayload?: EnrichmentContextPayload;
  /** Feed version / pulse id / engine set. */
  sourceVersion?: string;
  /** Content hash of the matched feed snapshot (audit). */
  feedHash?: string;
  /** When the matched feed snapshot was last refreshed (freshness/stale). */
  sourceUpdatedAt?: string;
}

/**
 * A negative-layer (warninglist) hit for one indicator from one negative
 * source (RFC 0003 F5, #599). This is a SUPPRESSION SIGNAL, not a positive
 * match: it carries no `hitType` (a warninglist entry is neither
 * `deterministic_ioc` nor `soft_reputation`) and no `floorEligible` (a
 * negative source can never drive the floor). It lands on
 * `EnrichmentResult.negativeMatches`, never on `matches[]`, so a negative
 * source cannot leak in as a positive match. Its presence for an indicator is
 * what triggers the suppression pass over that indicator's positive matches.
 */
export interface NegativeMatch {
  /** Provenance / citation, e.g. "misp/warninglists". */
  source: string;
  /** Which source-policy entry governs this negative source. */
  sourcePolicyId: string;
  /** Source-native label, e.g. "public-dns", "cdn", "tlds". */
  classification?: string;
  confidence?: number;
  /** Feed version / list id. */
  sourceVersion?: string;
  /** Content hash of the matched feed snapshot (audit). */
  feedHash?: string;
  /** When the matched feed snapshot was last refreshed (freshness/stale). */
  sourceUpdatedAt?: string;
}

/**
 * Per-source coverage signal, reported for EVERY source the enricher is
 * responsible for — INCLUDING a clean no-hit (`matches: []`, no error). This
 * is the authoritative input to `coverageStatus`: without it a no-hit
 * answered source is indistinguishable from one that never ran.
 */
export interface SourceOutcome {
  sourcePolicyId: string;
  /** `true` = source responded (hit OR clean no-hit). */
  answered: boolean;
  /** Snapshot freshness; drives answered-fresh vs answered-stale. */
  sourceUpdatedAt?: string;
  /** Present when `answered === false`. */
  error?: EnricherError;
}

/**
 * A redaction-token-aware narrative fact for C1 (RFC §"Pluggable enricher
 * interface"). P1a defines only the type + a trivial constructor; the
 * redaction pipeline (RFC 0001 Amendment A, #424) populates it later.
 */
export interface EnrichmentFact {
  /** Narrative text; may embed redaction tokens once Amendment A lands. */
  text: string;
  /** Redaction tokens referenced by `text` (placeholder for Amendment A). */
  redactionTokens: string[];
}

/** Coverage status enum (RFC §"Audit / evidence model"). */
export type CoverageStatus = "complete" | "partial" | "unknown" | "stale";

/**
 * The collapsed coverage enum plus the raw counts that fed it. The counts
 * are recorded alongside the enum so the most-severe-wins precedence never
 * hides detail needed for debugging or operational alerting.
 */
export interface CoverageReport {
  status: CoverageStatus;
  /** Relevant deterministic sources expected for this entity type. */
  expectedCount: number;
  /** Sources that responded (fresh or stale). */
  answeredCount: number;
  freshCount: number;
  staleCount: number;
  /** Sources attempted (registered) that failed to deliver an outcome. */
  unavailableCount: number;
  /** Relevant deterministic sources with no enricher backing them. */
  notAttemptedCount: number;
}

/**
 * The result for one indicator (RFC interface `EnrichmentResult`). This is
 * what a single enricher returns AND the shape the dispatcher merges; the
 * merge produces a `MergedEnrichmentResult` that additionally carries the
 * computed `coverage` (§6). Per-source `checkedAt` is discarded on merge in
 * favour of the single dispatch-start instant.
 */
export interface EnrichmentResult {
  /** Post-normalization value actually matched. */
  indicator: NormalizedIndicator;
  /** `[]` when no source hit. */
  matches: EnrichmentMatch[];
  /**
   * Negative-layer (warninglist) hits for this indicator (RFC 0003 F5, #599).
   * Optional — a positive source omits it (≡ `[]`); only a `negative` source
   * populates it. A negative hit lands HERE, never on `matches[]`, so a
   * negative source can never leak in as a positive match. Carried through the
   * dispatch merge to `MergedEnrichmentResult`, where the suppression pass
   * reads it to suppress / down-weight this indicator's positive matches.
   */
  negativeMatches?: NegativeMatch[];
  /** Narrative facts for C1. */
  facts: EnrichmentFact[];
  /** Per-source failures. */
  errors: EnricherError[];
  /** One per source this enricher is responsible for (sole input to §6). */
  outcomes: SourceOutcome[];
  /** When enrichment ran (overridden by the dispatch-start instant on merge). */
  checkedAt: string;
  /** Cache TTL boundary; on merge, the min across sources. */
  expiresAt?: string;
}

/**
 * The dispatcher's merged result: a merged `EnrichmentResult` plus the
 * `coverage` report computed from the merged `outcomes[]` (§6). Coverage is a
 * dispatcher concern (it needs the full registry view), so it lives here and
 * not on a single enricher's result.
 */
export interface MergedEnrichmentResult extends EnrichmentResult {
  coverage: CoverageReport;
}

/**
 * The pluggable enricher abstraction (RFC §"Pluggable enricher interface").
 * Every source — local feed, online API, MISP — enters as an adapter
 * implementing this. No consumer calls a TI source directly; all enrichment
 * flows through the dispatcher (the "enrich once" invariant).
 */
export interface Enricher {
  supports(entityType: EntityType): boolean;
  enrich(indicator: NormalizedIndicator): Promise<EnrichmentResult>;
}
