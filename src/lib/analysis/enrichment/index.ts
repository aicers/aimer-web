// RFC 0003 P1a — enrichment-layer foundation public surface.
//
// Pure module + types + fixtures: no DB, no HTTP, no consumer wiring. The
// #361 follow-up derives `known_ioc_hit` from these matches and wires it into
// `applyLikelihoodFloors`; the C1 issue consumes `facts[]`. See the module
// READMEs in each file and `rfcs/0003-external-ti-enrichment.md`.

export { computeCoverage } from "./coverage";
export {
  type DispatcherOptions,
  type EnricherRegistration,
  EnrichmentDispatcher,
} from "./dispatcher";
export {
  type BuildEvidenceParams,
  buildEvidenceRecord,
  type EvidenceRecord,
} from "./evidence";
export { createEnrichmentFact } from "./fact";
export {
  type ExtractedIndicator,
  extractIndicators,
  type RecoverToken,
} from "./indicator-extraction";
export {
  buildLocalFeedDispatcher,
  candidateValues,
  type FeedMatchRow,
  type FeedSnapshotMeta,
  type FeedStore,
  LOCAL_FEED_POLICIES,
  LocalFeedEnricher,
} from "./local-feed-enricher";
export {
  ipInCidr,
  NORMALIZATION_VERSION,
  NormalizationError,
  normalizeDomain,
  normalizeHash,
  normalizeIp,
  normalizeUrl,
  serializeIndicator,
} from "./normalization";
export {
  buildReferenceDispatcher,
  FixtureEnricher,
  type FixtureEntry,
  type FixtureFeed,
  type FixtureFile,
  loadReferenceFeeds,
  REFERENCE_POLICIES,
} from "./reference-enricher";
export {
  matchSatisfiesFloor,
  resolveFloorEligible,
  type SourcePolicy,
  SourcePolicyRegistry,
} from "./source-policy";
export type {
  CoverageReport,
  CoverageStatus,
  DerivedUrlIndicators,
  Enricher,
  EnricherError,
  EnricherErrorKind,
  EnrichmentFact,
  EnrichmentMatch,
  EnrichmentResult,
  EntityType,
  HashType,
  HitType,
  MergedEnrichmentResult,
  NormalizedIndicator,
  SourceOutcome,
} from "./types";
