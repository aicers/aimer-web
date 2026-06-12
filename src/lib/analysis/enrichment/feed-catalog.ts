// RFC 0003 Tier-1 feed-refresh — the shared Tier-1 source catalog (#566).
//
// One place that maps each known Tier-1 `source_policy_id` to how its raw
// feed is parsed/imported (`parse` / `entityType` / `hitType` /
// `classification`) plus a human-readable `label` and freshness `maxAge`.
//
// Both supply paths read this manifest so the mapping is defined ONCE:
//   - `FIXTURE_FEEDS` (fixture-feeds.ts) re-attaches each fixture `file`,
//   - the manual-upload feature (admin UI + upload route) reads the
//     `sourcePolicyId → parse/entityType/hitType/classification` mapping
//     and the `label` / `maxAge` for the status table + fresh/stale badge.
//
// `label` and `maxAge` are NOT redefined here: they are sourced from
// `LOCAL_FEED_POLICIES` (the policy the matcher/Badge actually use) so the
// admin catalog can't drift from the matcher policy.

import type { FeedParseKind } from "./feed-source";
import { LOCAL_FEED_POLICIES } from "./local-feed-enricher";
import type { EntityType, HitType } from "./types";

/**
 * Per-source descriptor for a Tier-1 feed, independent of supply mode. The
 * non-`file` part of a fixture spec, plus the policy's `label` / `maxAge`.
 */
export interface Tier1FeedSource {
  /** Source policy this descriptor governs (e.g. `abuse.ch/feodo`). */
  sourcePolicyId: string;
  /** Human-readable source identity (sourced from `LOCAL_FEED_POLICIES`). */
  label: string;
  /** How to parse the raw feed content into indicator values. */
  parse: FeedParseKind;
  /** Default entity type for the parsed rows. */
  entityType: EntityType;
  /** Intrinsic match type — Tier-1 IOC feeds are `deterministic_ioc`. */
  hitType: HitType;
  /** Optional classification tag for the rows. */
  classification?: string;
  /** Staleness bound (ms) — a snapshot older than this is `stale`. */
  maxAge: number;
}

/** Per-policy `label` / `maxAge`, keyed by source — single source of truth. */
const POLICY_BY_ID = new Map(
  LOCAL_FEED_POLICIES.map((policy) => [policy.sourcePolicyId, policy]),
);

function policyFor(sourcePolicyId: string): { label: string; maxAge: number } {
  const policy = POLICY_BY_ID.get(sourcePolicyId);
  if (!policy) {
    throw new Error(
      `No LOCAL_FEED_POLICIES entry for source "${sourcePolicyId}"`,
    );
  }
  return { label: policy.label, maxAge: policy.maxAge };
}

/** The non-`file`, non-policy descriptor for each Tier-1 source. */
type Tier1FeedSpec = Omit<Tier1FeedSource, "label" | "maxAge">;

const TIER1_FEED_SPECS: readonly Tier1FeedSpec[] = [
  {
    sourcePolicyId: "abuse.ch/feodo",
    parse: "ip-blocklist",
    entityType: "IP",
    hitType: "deterministic_ioc",
    classification: "c2",
  },
  {
    sourcePolicyId: "abuse.ch/urlhaus",
    parse: "urlhaus-csv",
    entityType: "URL",
    hitType: "deterministic_ioc",
    classification: "malware_url",
  },
  {
    sourcePolicyId: "abuse.ch/urlhaus-payloads",
    parse: "urlhaus-payloads-csv",
    entityType: "HASH",
    hitType: "deterministic_ioc",
    classification: "malware_payload",
  },
  {
    sourcePolicyId: "spamhaus/drop",
    parse: "spamhaus-drop",
    entityType: "IP",
    hitType: "deterministic_ioc",
    classification: "drop",
  },
  {
    sourcePolicyId: "spamhaus/edrop",
    parse: "spamhaus-drop",
    entityType: "IP",
    hitType: "deterministic_ioc",
    classification: "edrop",
  },
];

/**
 * The shared Tier-1 source catalog: every known source's parse/import
 * mapping with its policy `label` / `maxAge` re-attached. Order matches the
 * RFC source catalog (and the fixture specs derived from it).
 */
export const TIER1_FEED_SOURCES: readonly Tier1FeedSource[] =
  TIER1_FEED_SPECS.map((spec) => ({
    ...spec,
    ...policyFor(spec.sourcePolicyId),
  }));

/** Look up a catalog source by `source_policy_id` (undefined if unknown). */
export function getTier1FeedSource(
  sourcePolicyId: string,
): Tier1FeedSource | undefined {
  return TIER1_FEED_SOURCES.find((s) => s.sourcePolicyId === sourcePolicyId);
}
