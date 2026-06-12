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
 * Placeholder token in a self-fetch URL that the fetch engine replaces with
 * the decrypted Auth-Key. The current URLhaus export API embeds the key in
 * the URL *path* (e.g. `.../exports/<AUTH-KEY>/recent.csv`), not a header, so
 * a source whose URL contains this token requires an Auth-Key to fetch.
 */
export const FETCH_AUTH_KEY_PLACEHOLDER = "{AUTH_KEY}";

/** Self-fetch (#568) HTTP fetch config for a Tier-1 source. */
export interface Tier1FetchConfig {
  /**
   * URL(s) to fetch over HTTP. Multiple URLs (Spamhaus `drop_v4`/`drop_v6`)
   * are fetched in order and their bodies concatenated before parsing. A URL
   * may contain `FETCH_AUTH_KEY_PLACEHOLDER`, substituted at fetch time.
   */
  urls: readonly string[];
  /**
   * Hard cadence floor (ms): nothing fetches this source more often than
   * this. Guards against an abuse.ch / Spamhaus IP ban from over-fetching.
   */
  cadenceFloorMs: number;
  /**
   * Parse kind for the self-fetched bytes. May differ from the catalog's
   * fixture/upload `parse`: Spamhaus is served as NDJSON over HTTP today
   * (`spamhaus-drop-ndjson`) but the committed fixtures use the legacy text
   * form (`spamhaus-drop`).
   */
  parse: FeedParseKind;
  /**
   * `feed_source_secret.key_name` of the Auth-Key this source needs, if any
   * (URLhaus). Sources without an Auth-Key (Feodo, Spamhaus) omit it.
   */
  authKeyName?: string;
}

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
  /**
   * Self-fetch HTTP config (#568). Absent for sources that cannot be
   * self-fetched today — notably `spamhaus/edrop`, merged into DROP in 2024.
   */
  fetch?: Tier1FetchConfig;
}

const FIVE_MINUTES_MS = 5 * 60 * 1000;
const ONE_HOUR_MS = 60 * 60 * 1000;

/**
 * Per-source self-fetch config (#568), keyed by source. Endpoints, file
 * variant, and auth mechanism confirmed against the live APIs at
 * implementation (June 2026):
 *   - Feodo: the recommended *plain-text* IP blocklist (consumed by the
 *     existing `ip-blocklist` parser), NOT the JSON/full-IOC variant.
 *   - URLhaus URL + payload CSV exports: Auth-Key embedded in the URL path
 *     (`FETCH_AUTH_KEY_PLACEHOLDER`), generated every 5 min — floor 5 min.
 *   - Spamhaus DROP: NDJSON `drop_v4.json` + `drop_v6.json` (EDROP merged
 *     into DROP, 2024). Over-fetching risks an IP firewall — floor 1 h.
 */
const FETCH_CONFIG_BY_ID: Readonly<Record<string, Tier1FetchConfig>> = {
  "abuse.ch/feodo": {
    urls: [
      "https://feodotracker.abuse.ch/downloads/ipblocklist_recommended.txt",
    ],
    cadenceFloorMs: FIVE_MINUTES_MS,
    parse: "ip-blocklist",
  },
  "abuse.ch/urlhaus": {
    urls: [
      `https://urlhaus-api.abuse.ch/v2/urls/exports/${FETCH_AUTH_KEY_PLACEHOLDER}/recent.csv`,
    ],
    cadenceFloorMs: FIVE_MINUTES_MS,
    parse: "urlhaus-csv",
    authKeyName: "urlhaus",
  },
  "abuse.ch/urlhaus-payloads": {
    urls: [
      `https://urlhaus-api.abuse.ch/v2/files/exports/${FETCH_AUTH_KEY_PLACEHOLDER}/recent.csv`,
    ],
    cadenceFloorMs: FIVE_MINUTES_MS,
    parse: "urlhaus-payloads-csv",
    authKeyName: "urlhaus",
  },
  "spamhaus/drop": {
    urls: [
      "https://www.spamhaus.org/drop/drop_v4.json",
      "https://www.spamhaus.org/drop/drop_v6.json",
    ],
    cadenceFloorMs: ONE_HOUR_MS,
    parse: "spamhaus-drop-ndjson",
  },
};

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
    fetch: FETCH_CONFIG_BY_ID[spec.sourcePolicyId],
  }));

/** Look up a catalog source by `source_policy_id` (undefined if unknown). */
export function getTier1FeedSource(
  sourcePolicyId: string,
): Tier1FeedSource | undefined {
  return TIER1_FEED_SOURCES.find((s) => s.sourcePolicyId === sourcePolicyId);
}
