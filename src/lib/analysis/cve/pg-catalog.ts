// RFC 0005 — DB-backed `CveCatalog` over the CVE snapshot (#601).
//
// `PgCveCatalog` is the production catalog: a drop-in for `FixtureCveCatalog`
// reading the `cve_snapshot` + `cve_fetch_state` tables (dedicated feed DB,
// #601). It produces the SAME `CveRecord` / `CveSourceOutcome` /
// `CveLandscapeRecord` shapes the fixture does, so `validateCveRefs` /
// `computeCveStatus` / the landscape selection / the chip render are unchanged.
//
// Two axes are kept strictly separate, the same false-clean distinction #590
// established:
//   - AVAILABILITY (answered) — whether a source has ever successfully
//     fetched, read from `cve_fetch_state.last_fetched_at`. `lookup` returns
//     facts from EVERY answered source, including a STALE one; only
//     never-fetched / unavailable sources are excluded. A miss here means the
//     id is genuinely absent (existence-validation drop), never "could not
//     consult" — that is reported only via `sourceOutcomes`.
//   - FRESHNESS — derived downstream by `computeCveStatus` from the same
//     `last_fetched_at` clock (NOT the per-CVE upstream `published_at`), so a
//     daily-revalidated unchanged source reads fresh.
//
// CVE never flows through the IOC dispatch/floor pipeline — this is its own
// catalog (the #588/#590 boundary).

import "server-only";

import type { Pool } from "pg";
import {
  ALL_CVE_SOURCES,
  type CveCatalog,
  type CveLandscapeRecord,
  type CveRecord,
  type CveSourceId,
  type CveSourceOutcome,
} from "./catalog";
import { HIGH_EPSS_THRESHOLD } from "./landscape";

function toIso(value: Date | string | null | undefined): string | undefined {
  if (value == null) return undefined;
  return value instanceof Date ? value.toISOString() : value;
}

function isCveSource(value: string): value is CveSourceId {
  return (ALL_CVE_SOURCES as readonly string[]).includes(value);
}

/** One `cve_snapshot` row, as read from the feed DB. */
interface SnapshotRow {
  source_id: CveSourceId;
  cve: string;
  cvss_score: number | null;
  cwe: string[] | null;
  kev_known_exploited: boolean | null;
  kev_date_added: string | null;
  in_the_wild: boolean | null;
  epss_score: number | null;
  epss_percentile: number | null;
  description: string | null;
  published_at: Date | null;
}

const SNAPSHOT_COLUMNS = `source_id, cve, cvss_score, cwe, kev_known_exploited,
  kev_date_added, in_the_wild, epss_score, epss_percentile, description,
  published_at`;

export class PgCveCatalog implements CveCatalog {
  constructor(private readonly pool: Pool) {}

  /**
   * Per-source availability/freshness from `cve_fetch_state`. A source with a
   * successful fetch (`last_fetched_at` set, by a 200 or 304) is `answered`
   * and carries that clock as `sourceUpdatedAt` (the freshness input to
   * `computeCveStatus`); a never-fetched source (no row, or a row that has
   * only ever failed) is `answered: false`. Enumerated over the canonical
   * `ALL_CVE_SOURCES`, so a source absent from `cve_fetch_state` is reported
   * (`answered: false`), never silently dropped.
   */
  async sourceOutcomes(): Promise<CveSourceOutcome[]> {
    const { rows } = await this.pool.query<{
      source_id: string;
      last_fetched_at: Date | null;
    }>(`SELECT source_id, last_fetched_at FROM cve_fetch_state`);
    const byId = new Map(rows.map((r) => [r.source_id, r.last_fetched_at]));
    return ALL_CVE_SOURCES.map((source) => {
      const lastFetchedAt = byId.get(source) ?? null;
      const answered = lastFetchedAt != null;
      return {
        source,
        answered,
        sourceUpdatedAt: answered ? toIso(lastFetchedAt) : undefined,
      };
    });
  }

  /**
   * The set of sources that have EVER successfully fetched (`last_fetched_at`
   * set) — the availability gate for `lookup` / `landscape`. Answered ≠ fresh:
   * a stale source is still answered, so its facts are still returned.
   */
  private async answeredSources(): Promise<Set<CveSourceId>> {
    const { rows } = await this.pool.query<{ source_id: string }>(
      `SELECT source_id FROM cve_fetch_state WHERE last_fetched_at IS NOT NULL`,
    );
    return new Set(rows.map((r) => r.source_id).filter(isCveSource));
  }

  /**
   * Look up one canonical CVE id, merging the per-source snapshot rows of the
   * ANSWERED sources into one `CveRecord`. A stale-but-answered source's facts
   * ARE returned (staleness surfaces only via {@link sourceOutcomes}); only
   * never-fetched / unavailable sources are excluded. Returns `null` only when
   * no answered source carries the id — the existence-validation miss
   * `validateCveRefs` drops, never a silent "could not consult".
   */
  async lookup(cve: string): Promise<CveRecord | null> {
    const answered = await this.answeredSources();
    if (answered.size === 0) return null;

    const { rows } = await this.pool.query<SnapshotRow>(
      `SELECT ${SNAPSHOT_COLUMNS} FROM cve_snapshot WHERE cve = $1`,
      [cve],
    );
    const bySource = new Map<CveSourceId, SnapshotRow>();
    for (const row of rows) {
      if (answered.has(row.source_id)) bySource.set(row.source_id, row);
    }
    // No ANSWERED source carries the id → existence miss (null). An
    // unanswered source's row, if any, is intentionally excluded above so it
    // is never mistaken for an existence hit.
    if (bySource.size === 0) return null;

    const nvd = bySource.get("nvd");
    const kevRow = bySource.get("kev");
    const epssRow = bySource.get("epss");

    const cvss =
      nvd && nvd.cvss_score != null
        ? {
            score: nvd.cvss_score,
            cwe: nvd.cwe ?? undefined,
            source: "nvd" as const,
          }
        : null;
    const kev =
      kevRow && kevRow.kev_known_exploited != null
        ? {
            knownExploited: kevRow.kev_known_exploited,
            dateAdded: kevRow.kev_date_added ?? undefined,
            source: "kev" as const,
          }
        : null;
    const epss =
      epssRow && epssRow.epss_score != null
        ? {
            score: epssRow.epss_score,
            percentile: epssRow.epss_percentile ?? 0,
            source: "epss" as const,
          }
        : null;
    // `summary` stays NVD-gated (merged #590 policy): null unless NVD carries
    // its CVSS summary. The landscape `description` is the distinct,
    // source-local field (see `landscape`).
    const summary = nvd && nvd.description != null ? nvd.description : null;
    const inTheWild =
      kevRow && kevRow.in_the_wild != null ? kevRow.in_the_wild : null;

    // Cite EVERY contributing source in citation order — exactly the fixture's
    // derivation: `summary` is an NVD datum and `inTheWild` a KEV datum, so a
    // summary-only / in-the-wild-only record still names its source.
    const sources: CveSourceId[] = [];
    if (cvss !== null || summary !== null) sources.push("nvd");
    if (kev !== null || inTheWild !== null) sources.push("kev");
    if (epss !== null) sources.push("epss");

    return { cve, cvss, kev, epss, summary, inTheWild, sources };
  }

  /**
   * Recent-CVE landscape candidates derived from the snapshot of the ANSWERED
   * sources: every CVE that is in CISA KEV OR carries a high EPSS score
   * (≥ {@link HIGH_EPSS_THRESHOLD}). The recency window + cap are applied
   * DOWNSTREAM (`selectStoryLandscape` / `selectEventLandscape`); this returns
   * the raw candidate universe deterministically (ordered by id).
   *
   * `description` is built from the source-local description of the
   * contributing source — a KEV-only candidate uses CISA's `shortDescription`,
   * not an NVD summary it lacks. `publishedAt` drives recency: the upstream
   * `published_at`, falling back to the KEV date-added when no publish date is
   * recorded.
   */
  async landscape(): Promise<CveLandscapeRecord[]> {
    const answered = await this.answeredSources();
    if (answered.size === 0) return [];

    const { rows } = await this.pool.query<SnapshotRow>(
      `SELECT ${SNAPSHOT_COLUMNS} FROM cve_snapshot
        WHERE source_id = ANY($1::text[])`,
      [[...answered]],
    );

    const byCve = new Map<string, Map<CveSourceId, SnapshotRow>>();
    for (const row of rows) {
      let sources = byCve.get(row.cve);
      if (!sources) {
        sources = new Map();
        byCve.set(row.cve, sources);
      }
      sources.set(row.source_id, row);
    }

    const out: CveLandscapeRecord[] = [];
    for (const [cve, sources] of byCve) {
      const nvd = sources.get("nvd");
      const kevRow = sources.get("kev");
      const epssRow = sources.get("epss");

      const kev = kevRow?.kev_known_exploited === true;
      const epss = epssRow?.epss_score ?? null;
      const epssPercentile = epssRow?.epss_percentile ?? null;

      // Candidate iff a KEV entry or a high-EPSS score — the landscape's two
      // candidacy signals (NVD carries none of its own).
      const isCandidate = kev || (epss !== null && epss >= HIGH_EPSS_THRESHOLD);
      if (!isCandidate) continue;

      const kevDateAdded = kevRow?.kev_date_added ?? undefined;
      // Recency: the upstream publication date, else the KEV date-added so a
      // KEV-only candidate is still placeable in the window.
      const publishedAt =
        toIso(nvd?.published_at) ??
        toIso(kevRow?.published_at) ??
        toIso(epssRow?.published_at) ??
        kevDateAdded ??
        "";
      // Source-local description: a KEV candidate cites CISA's
      // shortDescription, otherwise NVD's summary, otherwise any available.
      const description = kev
        ? (kevRow?.description ??
          nvd?.description ??
          epssRow?.description ??
          "")
        : (nvd?.description ??
          kevRow?.description ??
          epssRow?.description ??
          "");

      out.push({
        cve,
        publishedAt,
        kev,
        kevDateAdded,
        epss,
        epssPercentile,
        description,
      });
    }

    // Deterministic output (downstream selection re-sorts, but a stable
    // candidate order keeps the catalog itself reproducible).
    out.sort((a, b) => a.cve.localeCompare(b.cve));
    return out;
  }
}
