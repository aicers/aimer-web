// RFC 0005 — composable CVE-source registration seam (#611).
//
// The single descriptor a core CVE source (NVD / CISA KEV / FIRST EPSS)
// declares, plus the lightweight registry it self-registers into. Mirroring
// the IOC TI source registry's intent (`enrichment/sources/registry.ts`): each
// source owns ONE per-source file under `./` that calls `registerCveSource(...)`
// at module load, so adding a source (#602: Project Zero / GitHub Advisory /
// OSV) is a FILE ADDITION, not an edit to a shared switch/array.
//
// Scope boundary with the closed `CveSourceId` union (RFC 0005 / #611):
// this registry is the source of truth for the *behavioral* per-source wiring
// (fetch/parse/freshness) ONLY. The TYPE-level set — `CveSourceId`,
// `ALL_CVE_SOURCES`, `CVE_SOURCE_LABELS` — lives in pure `../catalog.ts` and is
// NOT derived from this runtime registry; runtime enumeration
// (`sourceOutcomes` / `computeCveStatus` / `validate`) continues to use the
// `ALL_CVE_SOURCES` const. For the three core sources the registry and the
// const are simply kept CONSISTENT: registration fails fast if a descriptor's
// `id` is not a known `CveSourceId` or its `label` disagrees with
// `CVE_SOURCE_LABELS`. Adding a fourth source is therefore BOTH a registry
// file-addition here AND the closed-union edit in `catalog.ts` (#602's job).
//
// Pure module — no `server-only`, no DB, no HTTP. The descriptors carry data
// plus a PURE `parse` function, so the whole seam is unit-testable offline. The
// fetch engine (`../cve-fetch.ts`, server-only) imports the `./` barrel for the
// registration side effects and drives these descriptors.

import {
  ALL_CVE_SOURCES,
  CVE_SOURCE_LABELS,
  type CveSourceId,
} from "../catalog";

/**
 * Common cadence/staleness magnitudes for CVE sources. NVD / KEV / EPSS all
 * publish at least daily; refresh is daily + backlog-tolerant, so the hard
 * cadence floor is a day (the schedule may ask for less-frequent, never more).
 */
export const ONE_DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Staleness bound (ms): a CVE source snapshot older than this reads `stale`.
 * Mirrors `status.ts`'s `DEFAULT_CVE_SOURCE_MAX_AGE_MS` (7 days) so the
 * descriptor-level freshness and the coverage-status freshness agree.
 */
export const CVE_SOURCE_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * One snapshot row a source's parser emits — a partial `cve_snapshot` row
 * carrying only the columns the source populates (the rest stay NULL). The
 * import replaces ALL of a source's rows with these (replace-only, #601 schema).
 */
export interface CveSnapshotInsertRow {
  /** Canonical CVE id (`CVE-YYYY-N{4,}`). */
  cve: string;
  // NVD columns.
  cvssScore?: number | null;
  cwe?: string[] | null;
  cvssVector?: string | null;
  // CISA KEV columns.
  kevKnownExploited?: boolean | null;
  kevDateAdded?: string | null;
  inTheWild?: boolean | null;
  // FIRST EPSS columns.
  epssScore?: number | null;
  epssPercentile?: number | null;
  // Source-local description + upstream publish date (landscape recency).
  description?: string | null;
  publishedAt?: string | null;
}

/** What a source's pure `parse` returns. */
export interface CveParseResult {
  rows: CveSnapshotInsertRow[];
  /**
   * Total available results across ALL pages, for a paged bulk-sync source
   * (NVD). The engine pages until `startIndex >= totalResults`. Undefined for
   * single-shot sources (KEV / EPSS), where the one response is the whole feed.
   */
  totalResults?: number;
}

/** Self-fetch HTTP config for a CVE source (mirrors `TiSourceFetchConfig`). */
export interface CveFetchConfig {
  /**
   * Base URL fetched over HTTP. For a paged source the engine appends the
   * `resultsPerPage` / `startIndex` query params; single-shot sources fetch it
   * verbatim. Never carries a secret — an API key is sent as a HEADER, not in
   * the URL path (unlike the IOC URLhaus Auth-Key), so this URL is display-safe.
   */
  url: string;
  /**
   * Hard cadence floor (ms): nothing fetches this source more often than this.
   * CVE sources are daily, so the floor is a day — the schedule's `intervalMs`
   * is clamped UP to it.
   */
  cadenceFloorMs: number;
  /**
   * `feed_source_secret.key_name` of the OPTIONAL API key this source can use
   * (NVD: `nvd`), stored via the existing Transit envelope. Absent for the
   * keyless sources (KEV / EPSS). The key is optional even when named: the
   * source fetches keyless (rate-paced) when it is unset.
   */
  authKeyName?: string;
  /**
   * HTTP header the API key is sent under (NVD: `apiKey`). Present only with
   * `authKeyName`. When the key is unset the header is simply omitted (keyless).
   */
  authKeyHeader?: string;
  /**
   * The body is gzip-compressed (FIRST EPSS ships a `.csv.gz`). The engine
   * decompresses before handing the text to `parse`.
   */
  gzip?: boolean;
  /**
   * Paged bulk-sync (NVD API). The engine fetches pages of `resultsPerPage`,
   * sleeping `interPageDelayMs` between requests (rate-pacing — NVD allows only
   * 5 req/30s keyless), accumulating rows until the parser's `totalResults` is
   * covered. Absent for single-shot sources.
   */
  paging?: {
    resultsPerPage: number;
    interPageDelayMs: number;
  };
}

/**
 * Everything one core CVE source declares to self-register: its id/label (kept
 * consistent with the closed union), freshness, fetch config, and a PURE parser
 * turning fetched text into snapshot rows.
 */
export interface CveSourceDescriptor {
  /** Closed-union source id (`nvd` | `kev` | `epss`). */
  id: CveSourceId;
  /** Human-facing citation label — must equal `CVE_SOURCE_LABELS[id]`. */
  label: string;
  /** Staleness bound (ms) — a snapshot older than this is `stale`. */
  maxAge: number;
  /** Self-fetch HTTP config. */
  fetch: CveFetchConfig;
  /**
   * Pure parser: fetched (decompressed) text → snapshot rows. Exposed on the
   * descriptor so ingestion tests can parse a pinned fixture WITHOUT the engine
   * or any network. A malformed entry is skipped, not fatal (a very-recent NVD
   * CVE lacking CVSS yields a row with `cvssScore: null`, never an error).
   */
  parse: (content: string) => CveParseResult;
}

/** `id → descriptor`; populated by per-source module side effects. */
const REGISTRY = new Map<CveSourceId, CveSourceDescriptor>();

/** Structural equality so re-registering an identical descriptor is idempotent. */
function shallowDescriptorEqual(
  a: CveSourceDescriptor,
  b: CveSourceDescriptor,
): boolean {
  return (
    a.id === b.id &&
    a.label === b.label &&
    a.maxAge === b.maxAge &&
    a.parse === b.parse &&
    JSON.stringify(a.fetch) === JSON.stringify(b.fetch)
  );
}

/**
 * Register a CVE source descriptor (called by each per-source file at load).
 *
 * Fails fast on a descriptor whose `id` is not a known `CveSourceId`, or whose
 * `label` disagrees with `CVE_SOURCE_LABELS[id]` — the registry must stay
 * consistent with the pure type-level set, never drift from it. A conflicting
 * duplicate `id` throws (two files claiming one source is a programming error);
 * a value-identical re-registration is idempotent so a module re-evaluated by
 * the test runner does not throw.
 */
export function registerCveSource(descriptor: CveSourceDescriptor): void {
  if (!(ALL_CVE_SOURCES as readonly string[]).includes(descriptor.id)) {
    throw new Error(
      `Unknown CVE source id "${descriptor.id}" — it must be a member of the ` +
        "closed CveSourceId union (catalog.ts)",
    );
  }
  const expectedLabel = CVE_SOURCE_LABELS[descriptor.id];
  if (descriptor.label !== expectedLabel) {
    throw new Error(
      `CVE source "${descriptor.id}" label "${descriptor.label}" disagrees ` +
        `with CVE_SOURCE_LABELS ("${expectedLabel}")`,
    );
  }

  const existing = REGISTRY.get(descriptor.id);
  if (existing) {
    if (shallowDescriptorEqual(existing, descriptor)) return;
    throw new Error(
      `Duplicate CVE source registration for "${descriptor.id}" with a ` +
        "conflicting descriptor",
    );
  }
  REGISTRY.set(descriptor.id, descriptor);
}

/**
 * Every registered descriptor in `ALL_CVE_SOURCES` citation order (NVD, KEV,
 * EPSS) — the *enumeration accessor* this issue owns and #612 consumes to
 * surface CVE sources to the F2 selection model. Ordering by the const (not the
 * registry's insertion order) keeps it deterministic regardless of import order.
 */
export function allCveSourceDescriptors(): readonly CveSourceDescriptor[] {
  const out: CveSourceDescriptor[] = [];
  for (const id of ALL_CVE_SOURCES) {
    const descriptor = REGISTRY.get(id);
    if (descriptor) out.push(descriptor);
  }
  return out;
}

/** Look up a registered descriptor by id (undefined if not registered). */
export function getCveSourceDescriptor(
  id: string,
): CveSourceDescriptor | undefined {
  return REGISTRY.get(id as CveSourceId);
}

/**
 * Remove a descriptor from the registry. For tests that register a throwaway
 * source and clean up after themselves; production code never unregisters.
 */
export function unregisterCveSource(id: CveSourceId): void {
  REGISTRY.delete(id);
}
