// RFC 0005 — CVE catalog interface + shared CVE types.
//
// This is the `CveCatalog` seam the whole CVE foundation is built
// against. The CVE source fan-out (NVD / CISA KEV / FIRST EPSS core;
// Project Zero / GitHub Advisory / OSV supplementary) implements the
// DB-backed catalog against THIS interface — a CVE source never flows
// through the IOC indicator/dispatch/floor pipeline (RFC 0003 F1 /
// `TiSourceDescriptor`). The fixture-backed catalog
// (`fixture-catalog.ts`) implements it for offline testing.
//
// Pure types + interface — no runtime behaviour, no DB, no HTTP. Mirrors
// the IOC enrichment layer's `SourceOutcome` + `computeCoverage` model
// (`src/lib/analysis/enrichment/{types,coverage}.ts`) so CVE validation
// can derive a coverage status the same way.

import type { CoverageStatus } from "../enrichment/types";

/**
 * The authoritative CVE catalogs aimer-web validates against. Mirrors the
 * RFC 0005 §"CVE sources" core set:
 *   - `nvd`  — NVD: CVSS base score + CWE.
 *   - `kev`  — CISA KEV: known-exploited-in-the-wild flag.
 *   - `epss` — FIRST EPSS: exploit-prediction score + percentile.
 * The supplementary sources (Project Zero / GitHub Advisory / OSV) fold
 * into these enrichment fields rather than adding new ids here in v1.
 */
export type CveSourceId = "nvd" | "kev" | "epss";

/** Every core source, in citation order. */
export const ALL_CVE_SOURCES: readonly CveSourceId[] = ["nvd", "kev", "epss"];

/** Human-facing citation label per source (rendered in the chip payload). */
export const CVE_SOURCE_LABELS: Record<CveSourceId, string> = {
  nvd: "NVD",
  kev: "CISA",
  epss: "FIRST",
};

/**
 * Per-source availability/freshness for one catalog snapshot — the CVE
 * analogue of the IOC `SourceOutcome`. Reported for EVERY consulted
 * source so a clean no-hit is distinguishable from a source that never
 * answered (the `complete`-vs-`unknown` distinction).
 */
export interface CveSourceOutcome {
  source: CveSourceId;
  /** `true` = the source snapshot was available to consult. */
  answered: boolean;
  /** Snapshot freshness; drives answered-fresh vs answered-stale. */
  sourceUpdatedAt?: string;
}

/** CVSS base score with its citing source (always NVD in v1). */
export interface CvssFact {
  score: number;
  /** CWE ids, when the snapshot carries them. */
  cwe?: string[];
  source: CveSourceId;
}

/** CISA KEV known-exploited flag with its citing source. */
export interface KevFact {
  knownExploited: boolean;
  /** When CISA added the CVE to the KEV catalog (ISO date). */
  dateAdded?: string;
  source: CveSourceId;
}

/** FIRST EPSS score + percentile with its citing source. */
export interface EpssFact {
  score: number;
  percentile: number;
  source: CveSourceId;
}

/**
 * The enrichment payload for one validated CVE — the structured record
 * stored on `cve_refs` and rendered as an expandable chip. Per-field
 * source attribution discharges the CC-BY / requested-attribution
 * obligations (GitHub Advisory, EPSS) by construction. A field is `null`
 * when no available source carried it (e.g. KEV was unavailable, or the
 * CVE is simply not in the KEV catalog).
 */
export interface CveRecord {
  /** Canonical CVE id (`CVE-YYYY-N{4,}`). */
  cve: string;
  cvss: CvssFact | null;
  kev: KevFact | null;
  epss: EpssFact | null;
  /** One-line summary from an available source. */
  summary: string | null;
  /** Observed exploited in the wild (KEV/threat-intel signal). */
  inTheWild: boolean | null;
  /**
   * The sources that actually contributed to this record, in citation
   * order — what the chip cites. Derived from the non-null facts above.
   */
  sources: CveSourceId[];
}

/**
 * One recent-CVE landscape candidate from the catalog (RFC 0005
 * §priming). Carries enough context for aimer-web to slice (KEV-only vs
 * high-EPSS), window by recency, and fold KEV/EPSS/recency into the
 * one-line description. Framed downstream as candidate context to verify,
 * never ground truth.
 */
export interface CveLandscapeRecord {
  cve: string;
  /** CVE publication date (ISO) — drives the recency window. */
  publishedAt: string;
  /** In the CISA KEV catalog. */
  kev: boolean;
  /** When CISA added it to KEV (ISO date), when known. */
  kevDateAdded?: string;
  epss: number | null;
  epssPercentile: number | null;
  /** One-line human description. */
  description: string;
}

/**
 * The DB-backed-or-fixture catalog the CVE foundation validates and
 * primes against. All lookups are async so the real (DB-snapshot) catalog
 * can issue queries; the fixture resolves synchronously.
 */
export interface CveCatalog {
  /**
   * Per-source availability/freshness for this catalog snapshot. The sole
   * input (alongside the F2-enabled source set) to the CVE coverage
   * status (`computeCveStatus`). A source missing from the array is
   * treated as `not_attempted`.
   */
  sourceOutcomes(): Promise<CveSourceOutcome[]>;
  /**
   * Look up one canonical CVE id. Returns the enrichment record limited
   * to AVAILABLE sources, or `null` when no available source carries the
   * id (the existence-validation miss `validateCveRefs` drops). A lookup
   * never silently treats an unavailable source as a miss — availability
   * is reported separately via {@link sourceOutcomes}.
   */
  lookup(cve: string): Promise<CveRecord | null>;
  /** Recent-CVE candidates for priming, drawn from available sources. */
  landscape(): Promise<CveLandscapeRecord[]>;
}

/** Re-export for convenience: CVE status reuses the IOC coverage enum. */
export type CveStatus = CoverageStatus;
