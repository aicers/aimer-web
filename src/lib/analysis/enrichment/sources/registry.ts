// RFC 0003 — composable self-registering TI source registry (#588).
//
// The single descriptor a Tier-1 IOC-feed source declares, plus the registry
// it self-registers into. Before this module, adding a source meant editing
// FIVE separate shared arrays/maps (`LOCAL_FEED_POLICIES`, `TIER1_FEED_SPECS`,
// `FETCH_CONFIG_BY_ID`, `FIXTURE_FILES`, the `parseFeedContent` switch) — every
// one a guaranteed merge-conflict hotspot when source issues land in parallel.
//
// Here each source is ONE `TiSourceDescriptor` owned by a single per-source
// file under `./` that calls `registerTiSource(...)` at module load. The five
// former structures are now *derived* from this registry (see
// `local-feed-enricher` / `feed-catalog` / `fixture-feeds`), so adding a source
// is "add a file + one append-only import line" in the `./index` barrel — no
// edit to any shared structured array.
//
// Boundary (RFC 0003 / #588): this registry is IOC-feed-specific — `entityTypes`,
// `hitType`, `floorEligible`, `deterministicCoverage`, and `parse` describe IOC
// feeds that flow through the indicator-extraction → dispatch → floor pipeline.
// CVE-context sources (RFC 0005) register against #590's `CveCatalog`, NOT this
// registry.

import type {
  FeedParseConfig,
  FeedParseKind,
  VendorRepoConfig,
} from "../feed-source";
import type { EntityType, HitType, SourcePolarity } from "../types";

/**
 * Placeholder token in a self-fetch URL that the fetch engine replaces with
 * the decrypted Auth-Key. The current URLhaus export API embeds the key in
 * the URL *path* (e.g. `.../exports/<AUTH-KEY>/recent.csv`), not a header, so
 * a source whose URL contains this token requires an Auth-Key to fetch.
 */
export const FETCH_AUTH_KEY_PLACEHOLDER = "{AUTH_KEY}";

/**
 * `feed_source_secret.key_name` of the single, optional, shared GitHub token
 * that every vendor-repo source uses (RFC 0003 F4, #650). All seven vendor
 * repositories are public, so a no-scope (public-read) Personal Access Token
 * suffices; supplying one lifts GitHub's REST rate limit from 60 to 5,000
 * requests/hour, shared across all vendor fetches. Keyless fetch still works.
 *
 * Defined here — the light type-only module every descriptor already imports —
 * rather than in the `server-only` `feed-vendor-repo.ts`, so the descriptor
 * registration path does not drag the fetch engine into descriptor evaluation.
 */
export const GITHUB_VENDOR_AUTH_KEY_NAME = "github";

/**
 * Feed staleness bound: the Tier-1 feeds refresh roughly daily, so a snapshot
 * older than two days is treated as stale (drives `stale` coverage). Shared by
 * every source descriptor's `maxAge` unless a source overrides it.
 */
export const FEED_MAX_AGE_MS = 2 * 24 * 60 * 60 * 1000;

/** Common cadence-floor magnitudes used by source self-fetch configs. */
export const FIVE_MINUTES_MS = 5 * 60 * 1000;
export const ONE_HOUR_MS = 60 * 60 * 1000;

/** Self-fetch (#568) HTTP fetch config for a TI source. */
export interface TiSourceFetchConfig {
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
   * Config for a parameterized self-fetch parser (`generic-list` /
   * `csv-column`, #593). May differ from the fixture/upload `parseConfig` the
   * same way `parse` may. Absent for the bespoke string kinds.
   */
  parseConfig?: FeedParseConfig;
  /**
   * `feed_source_secret.key_name` of the Auth-Key this source needs, if any
   * (URLhaus). Sources without an Auth-Key (Feodo, Spamhaus) omit it.
   */
  authKeyName?: string;
}

/**
 * Everything one TI IOC-feed source needs to register itself — the union of
 * the five structures this registry collapses. Each per-source file declares
 * exactly one of these and self-registers it via `registerTiSource`.
 */
export interface TiSourceDescriptor {
  /** Source policy this descriptor governs (e.g. `abuse.ch/feodo`). */
  sourcePolicyId: string;
  /** Human-readable source identity / label. */
  label: string;
  /**
   * Source polarity (RFC 0003 F5, #599). Omitted ⇒ `positive` (every existing
   * source). A `negative` source's imported rows are marked negative (and
   * carry NO `hit_type`); it never emits a positive `EnrichmentMatch`, only a
   * suppression signal. A negative source MUST also set
   * `deterministicCoverage: false` and `floorEligible: false` so it can affect
   * neither coverage nor the floor — enforced at registration.
   */
  polarity?: SourcePolarity;
  // --- source-policy fields (derive `LOCAL_FEED_POLICIES`) ---
  /** Which entity types this source covers (policy `supports()`). */
  entityTypes: EntityType[];
  /** Whether it counts as a *relevant deterministic source* for coverage. */
  deterministicCoverage: boolean;
  /** Staleness bound (ms) — a snapshot older than this is `stale`. */
  maxAge: number;
  /** Whether matches from this source may drive the binary floor. */
  floorEligible: boolean;
  // --- catalog / parse fields (derive `TIER1_FEED_SOURCES`) ---
  /** How to parse the raw fixture/upload feed content into indicator values. */
  parse: FeedParseKind;
  /**
   * Config for a parameterized parser (`generic-list` / `csv-column`, #593).
   * A fan-out plain/CSV source selects a generic `parse` kind + this config
   * instead of adding a bespoke parser. Absent for the bespoke string kinds.
   */
  parseConfig?: FeedParseConfig;
  /**
   * Default entity type for the parsed rows. A source whose parser emits more
   * than one entity type (URLhaus → URL + DOMAIN) sets the per-row override in
   * `parseFeedContent`; this is the import-time default for the rest.
   */
  entityType: EntityType;
  /**
   * Intrinsic match type — Tier-1 IOC feeds are `deterministic_ioc`. REQUIRED
   * for a positive source; OMITTED for a `negative` source (its rows carry no
   * `hit_type`). Enforced at registration.
   */
  hitType?: HitType;
  /** Optional classification tag for the rows. */
  classification?: string;
  /**
   * RFC 0003 F2 Tier-2 seam (#598). `true` marks a source that needs a
   * customer-supplied paid key before it can enrich — distinct from the
   * operator-side feed-fetch Auth-Key (`TiSourceFetchConfig.authKeyName`),
   * which is the operator's credential, not the customer's. This is ONLY a
   * shape placeholder: no key storage/plumbing exists yet, so no current
   * source sets it. The per-subject selection DTO surfaces it so the UI can
   * render such a source as unavailable-without-key once Tier 2 lands.
   */
  requiresCustomerKey?: boolean;
  // --- optional supply-mode config ---
  /**
   * Self-fetch HTTP config (#568). Absent for sources that cannot be
   * self-fetched today — notably `spamhaus/edrop`, merged into DROP in 2024.
   */
  fetch?: TiSourceFetchConfig;
  /**
   * Why a source has no self-fetch config (`fetch` absent). Drives the
   * self-fetch table badge so each non-fetchable source reads accurately:
   * `"merged"` ⇒ superseded upstream (e.g. `spamhaus/edrop` folded into
   * DROP); when omitted the source is simply fixture-/manual-upload-only with
   * no aggregate "latest" endpoint (e.g. `infoblox/threat-intelligence`).
   * Ignored when `fetch` is present.
   */
  selfFetchUnavailable?: "merged";
  /**
   * Vendor IOC repository extraction config (RFC 0003 F4, #603). Present for a
   * vendor-repo source (Unit 42 / ESET / Volexity / PRODAFT / Zscaler /
   * Huntress / Meta), absent for the flat Tier-1 feeds. A source carrying this
   * is imported through the vendor-repo engine (tree enumerate → allowlisted
   * blobs → per-source batch replace), not the flat `parse`/`fetch` path.
   */
  vendorRepo?: VendorRepoConfig;
  /** Committed fixture filename under `../feeds/`, if this source ships one. */
  fixtureFile?: string;
}

/** `sourcePolicyId → descriptor`; populated by per-source module side effects. */
const REGISTRY = new Map<string, TiSourceDescriptor>();

/** Structural equality so re-registering an identical descriptor is idempotent. */
function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== typeof b) return false;
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) {
      return false;
    }
    return a.every((v, i) => deepEqual(v, b[i]));
  }
  if (a && b && typeof a === "object" && typeof b === "object") {
    const ak = Object.keys(a as Record<string, unknown>);
    const bk = Object.keys(b as Record<string, unknown>);
    if (ak.length !== bk.length) return false;
    return ak.every(
      (k) =>
        Object.hasOwn(b as Record<string, unknown>, k) &&
        deepEqual(
          (a as Record<string, unknown>)[k],
          (b as Record<string, unknown>)[k],
        ),
    );
  }
  return false;
}

/**
 * Register a TI source descriptor (called by each per-source file at load).
 *
 * Fail-fast on a conflicting duplicate `sourcePolicyId` rather than silently
 * overwriting (unlike the bare `Map.set` in `SourcePolicyRegistry`): two source
 * files claiming the same id is a programming error, not a last-writer-wins
 * race. Re-registering the *exact same* descriptor (value-identical) is allowed
 * as idempotent, so a module re-evaluated by the test runner does not throw.
 */
export function registerTiSource(descriptor: TiSourceDescriptor): void {
  // Polarity invariants (#599). A negative (warninglist) source contributes
  // only a suppression signal: it can affect neither coverage nor the floor,
  // and its rows carry no `hit_type`. A positive source must declare a
  // `hitType`. Fail fast so a misconfigured source is caught at load.
  const polarity = descriptor.polarity ?? "positive";
  if (polarity === "negative") {
    if (descriptor.hitType !== undefined) {
      throw new Error(
        `Negative TI source "${descriptor.sourcePolicyId}" must not declare a ` +
          "hitType (negative rows carry no hit_type)",
      );
    }
    if (descriptor.deterministicCoverage || descriptor.floorEligible) {
      throw new Error(
        `Negative TI source "${descriptor.sourcePolicyId}" must set ` +
          "deterministicCoverage:false and floorEligible:false",
      );
    }
  } else if (descriptor.hitType === undefined) {
    throw new Error(
      `Positive TI source "${descriptor.sourcePolicyId}" must declare a hitType`,
    );
  }

  const existing = REGISTRY.get(descriptor.sourcePolicyId);
  if (existing) {
    if (deepEqual(existing, descriptor)) return;
    throw new Error(
      `Duplicate TI source registration for "${descriptor.sourcePolicyId}" ` +
        "with a conflicting descriptor",
    );
  }
  REGISTRY.set(descriptor.sourcePolicyId, descriptor);
}

/**
 * Every registered descriptor in a deterministic order (stable sort by
 * `sourcePolicyId`), so the derived policy list / catalog / fixture map and any
 * snapshot are reproducible regardless of source-file import order.
 */
export function allTiSourceDescriptors(): readonly TiSourceDescriptor[] {
  return [...REGISTRY.values()].sort((a, b) =>
    a.sourcePolicyId < b.sourcePolicyId
      ? -1
      : a.sourcePolicyId > b.sourcePolicyId
        ? 1
        : 0,
  );
}

/** Look up a registered descriptor by `sourcePolicyId` (undefined if unknown). */
export function getTiSourceDescriptor(
  sourcePolicyId: string,
): TiSourceDescriptor | undefined {
  return REGISTRY.get(sourcePolicyId);
}

/**
 * Remove a descriptor from the registry. Intended for tests that register a
 * throwaway fixture source and clean up after themselves; production code never
 * unregisters a source.
 */
export function unregisterTiSource(sourcePolicyId: string): void {
  REGISTRY.delete(sourcePolicyId);
}
