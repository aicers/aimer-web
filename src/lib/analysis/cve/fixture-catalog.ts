// RFC 0005 — fixture-backed `CveCatalog` (Scope 2).
//
// A pinned-data, in-memory `CveCatalog` so the entire CVE foundation
// (normalize → validate → enrich → status → landscape → render) is
// testable offline with NO source adapter. The DB-backed catalog (real
// NVD/KEV/EPSS snapshots) is implemented by the CVE source fan-out
// against the SAME `CveCatalog` interface.
//
// The fixture can simulate an UNAVAILABLE or STALE source (per-source
// `available` flag + `sourceUpdatedAt`) so the coverage-status path
// (`complete` vs `unknown`/`stale`) and the `could_not_consult` drop
// reason are testable. This module is pure — no `server-only`, no I/O —
// so it can be constructed directly from a config object in unit tests.
// The vendored-JSON loader lives in `config.ts` (server-only).

import {
  ALL_CVE_SOURCES,
  type CveCatalog,
  type CveLandscapeRecord,
  type CveRecord,
  type CveSourceId,
  type CveSourceOutcome,
} from "./catalog";

/** Per-source availability/freshness simulated by the fixture. */
export interface FixtureSourceConfig {
  /** `false` simulates an unavailable source (could-not-consult). */
  available: boolean;
  /** Snapshot freshness (ISO); omit to simulate an unvouched snapshot. */
  sourceUpdatedAt?: string;
}

/** Raw per-CVE fixture data; facts are attributed to their source. */
export interface FixtureCveData {
  /** NVD: CVSS base score. */
  cvss?: number;
  /** NVD: CWE ids. */
  cwe?: string[];
  /** NVD: one-line summary. */
  summary?: string;
  /** CISA KEV: known-exploited flag. */
  kev?: boolean;
  /** CISA KEV: date added (ISO). */
  kevDateAdded?: string;
  /** KEV/threat-intel: observed in the wild. */
  inTheWild?: boolean;
  /** FIRST EPSS: score. */
  epss?: number;
  /** FIRST EPSS: percentile. */
  epssPercentile?: number;
}

export interface FixtureCatalogConfig {
  sources: Record<CveSourceId, FixtureSourceConfig>;
  /** Keyed by canonical CVE id. */
  records: Record<string, FixtureCveData>;
  landscape: CveLandscapeRecord[];
}

/** Which sources carry any data for a record (before availability). */
function recordSources(data: FixtureCveData): Set<CveSourceId> {
  const s = new Set<CveSourceId>();
  if (
    data.cvss !== undefined ||
    data.cwe !== undefined ||
    data.summary !== undefined
  ) {
    s.add("nvd");
  }
  if (data.kev !== undefined || data.inTheWild !== undefined) s.add("kev");
  if (data.epss !== undefined) s.add("epss");
  return s;
}

export class FixtureCveCatalog implements CveCatalog {
  private readonly config: FixtureCatalogConfig;

  constructor(config: FixtureCatalogConfig) {
    this.config = config;
  }

  private available(source: CveSourceId): boolean {
    return this.config.sources[source]?.available === true;
  }

  sourceOutcomes(): Promise<CveSourceOutcome[]> {
    const outcomes: CveSourceOutcome[] = ALL_CVE_SOURCES.map((source) => {
      const cfg = this.config.sources[source];
      return {
        source,
        answered: cfg?.available === true,
        sourceUpdatedAt: cfg?.sourceUpdatedAt,
      };
    });
    return Promise.resolve(outcomes);
  }

  lookup(cve: string): Promise<CveRecord | null> {
    const data = this.config.records[cve];
    if (data === undefined) return Promise.resolve(null);

    const contributors = recordSources(data);
    const availableContributors = [...contributors].filter((s) =>
      this.available(s),
    );
    // Existence cannot be confirmed if every source that carries this CVE
    // is unavailable — a miss here surfaces as `could_not_consult`, never
    // a silent `not_in_catalog` (the status is `unknown` in that case).
    if (availableContributors.length === 0) return Promise.resolve(null);

    const cvss =
      this.available("nvd") && data.cvss !== undefined
        ? { score: data.cvss, cwe: data.cwe, source: "nvd" as const }
        : null;
    const kev =
      this.available("kev") && data.kev !== undefined
        ? {
            knownExploited: data.kev,
            dateAdded: data.kevDateAdded,
            source: "kev" as const,
          }
        : null;
    const epss =
      this.available("epss") && data.epss !== undefined
        ? {
            score: data.epss,
            percentile: data.epssPercentile ?? 0,
            source: "epss" as const,
          }
        : null;
    const summary =
      this.available("nvd") && data.summary !== undefined ? data.summary : null;
    const inTheWild =
      this.available("kev") && data.inTheWild !== undefined
        ? data.inTheWild
        : null;

    // Cite EVERY contributing source, in citation order — `summary` is an
    // NVD datum and `inTheWild` a KEV datum, so a record carrying only one
    // of those still names its validating source. Without this a
    // summary-only or in-the-wild-only record would render with no visible
    // provenance.
    const sources: CveSourceId[] = [];
    if (cvss !== null || summary !== null) sources.push("nvd");
    if (kev !== null || inTheWild !== null) sources.push("kev");
    if (epss !== null) sources.push("epss");

    return Promise.resolve({
      cve,
      cvss,
      kev,
      epss,
      summary,
      inTheWild,
      sources,
    });
  }

  landscape(): Promise<CveLandscapeRecord[]> {
    return Promise.resolve(this.config.landscape);
  }
}

/** Convenience: all core sources available and fresh at `sourceUpdatedAt`. */
export function allAvailableSources(
  sourceUpdatedAt: string,
): Record<CveSourceId, FixtureSourceConfig> {
  return {
    nvd: { available: true, sourceUpdatedAt },
    kev: { available: true, sourceUpdatedAt },
    epss: { available: true, sourceUpdatedAt },
  };
}
