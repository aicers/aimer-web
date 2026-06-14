// RFC 0003 Tier-1 feed-refresh — the shared Tier-1 source catalog (#566),
// now derived from the self-registering source registry (#588).
//
// One place that maps each known Tier-1 `source_policy_id` to how its raw
// feed is parsed/imported (`parse` / `entityType` / `hitType` /
// `classification`) plus a human-readable `label` and freshness `maxAge`.
// Both supply paths read this catalog so the mapping is defined ONCE.
//
// The per-source values are no longer declared here: each source owns a
// `TiSourceDescriptor` under `./sources/` and self-registers it. This module
// derives the `Tier1FeedSource[]` view (the non-`file` part of a fixture spec,
// plus the policy `label` / `maxAge`) from that registry, so adding a source is
// "add a descriptor file" with no edit to any array here.

import "./sources";
import type {
  FeedParseConfig,
  FeedParseKind,
  VendorRepoConfig,
} from "./feed-source";
import {
  allTiSourceDescriptors,
  getTiSourceDescriptor,
  type TiSourceFetchConfig,
} from "./sources/registry";
import type { EntityType, HitType, SourcePolarity } from "./types";

// Re-exported from the registry, which now owns these (the catalog is a derived
// view). Kept exported here so `feed-fetch` / `feed-upload` importers are
// unchanged. `Tier1FetchConfig` is the historical name for the registry's
// `TiSourceFetchConfig`.
export { FETCH_AUTH_KEY_PLACEHOLDER } from "./sources/registry";
export type Tier1FetchConfig = TiSourceFetchConfig;

/**
 * Per-source descriptor for a Tier-1 feed, independent of supply mode — the
 * non-`file` part of a fixture spec, plus the policy's `label` / `maxAge`.
 * Derived from each source's `TiSourceDescriptor`.
 */
export interface Tier1FeedSource {
  /** Source policy this descriptor governs (e.g. `abuse.ch/feodo`). */
  sourcePolicyId: string;
  /** Human-readable source identity. */
  label: string;
  /** How to parse the raw feed content into indicator values. */
  parse: FeedParseKind;
  /** Config for a parameterized parser (`generic-list` / `csv-column`, #593). */
  parseConfig?: FeedParseConfig;
  /** Default entity type for the parsed rows. */
  entityType: EntityType;
  /**
   * Source polarity (RFC 0003 F5, #599). Omitted ⇒ `positive`. Propagated to
   * the upload / self-fetch `RawFeedPayload` so a negative source imports
   * negative rows in those supply modes too.
   */
  polarity?: SourcePolarity;
  /**
   * Intrinsic match type — Tier-1 IOC feeds are `deterministic_ioc`. Absent for
   * a `negative` source (its rows carry no `hit_type`).
   */
  hitType?: HitType;
  /** Optional classification tag for the rows. */
  classification?: string;
  /** Staleness bound (ms) — a snapshot older than this is `stale`. */
  maxAge: number;
  /**
   * Self-fetch HTTP config (#568). Absent for sources that cannot be
   * self-fetched today — notably `spamhaus/edrop`, merged into DROP in 2024.
   */
  fetch?: TiSourceFetchConfig;
  /**
   * Why a source has no self-fetch (`fetch` absent): `"merged"` ⇒ superseded
   * upstream (EDROP into DROP); omitted ⇒ fixture-/manual-upload-only with no
   * aggregate endpoint (e.g. Infoblox). Drives the self-fetch table badge.
   */
  selfFetchUnavailable?: "merged";
  /**
   * Vendor IOC repository config (RFC 0003 F4, #603). Present for a vendor-repo
   * source; such a source is fetched + imported through the vendor-repo engine
   * (tree enumerate → allowlisted blobs → per-source batch replace), NOT the
   * flat `fetch` path. Carried through the catalog so the operator / scheduler
   * self-fetch path can route to the vendor engine.
   */
  vendorRepo?: VendorRepoConfig;
}

/**
 * The shared Tier-1 source catalog: every registered source's parse/import
 * mapping with its policy `label` / `maxAge`. Derived from the registry in its
 * deterministic stable-by-id order.
 */
export const TIER1_FEED_SOURCES: readonly Tier1FeedSource[] =
  allTiSourceDescriptors().map((descriptor) => ({
    sourcePolicyId: descriptor.sourcePolicyId,
    label: descriptor.label,
    parse: descriptor.parse,
    parseConfig: descriptor.parseConfig,
    entityType: descriptor.entityType,
    polarity: descriptor.polarity,
    hitType: descriptor.hitType,
    classification: descriptor.classification,
    maxAge: descriptor.maxAge,
    fetch: descriptor.fetch,
    selfFetchUnavailable: descriptor.selfFetchUnavailable,
    vendorRepo: descriptor.vendorRepo,
  }));

/** Look up a catalog source by `source_policy_id` (undefined if unknown). */
export function getTier1FeedSource(
  sourcePolicyId: string,
): Tier1FeedSource | undefined {
  const descriptor = getTiSourceDescriptor(sourcePolicyId);
  if (!descriptor) return undefined;
  return {
    sourcePolicyId: descriptor.sourcePolicyId,
    label: descriptor.label,
    parse: descriptor.parse,
    parseConfig: descriptor.parseConfig,
    entityType: descriptor.entityType,
    polarity: descriptor.polarity,
    hitType: descriptor.hitType,
    classification: descriptor.classification,
    maxAge: descriptor.maxAge,
    fetch: descriptor.fetch,
    selfFetchUnavailable: descriptor.selfFetchUnavailable,
    vendorRepo: descriptor.vendorRepo,
  };
}
