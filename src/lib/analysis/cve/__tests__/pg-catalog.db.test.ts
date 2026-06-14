// RFC 0005 (#601) — `PgCveCatalog` against a seeded CVE snapshot (DB).
//
// Seeds `cve_snapshot` + `cve_fetch_state` directly (no ingestion — that is
// #611) and asserts the DB catalog is a drop-in for `FixtureCveCatalog`:
//   - `lookup` merges nvd/kev/epss into one `CveRecord`; a KEV-only CVE has
//     `cvss: null`; an absent CVE returns `null`; a CVE whose only
//     contributing source is unavailable returns `null` while `sourceOutcomes`
//     reports it could-not-consult; a STALE-but-answered source still returns
//     its facts (staleness surfaces only via `sourceOutcomes`).
//   - `sourceOutcomes` drives `computeCveStatus` (complete vs unknown/stale),
//     and a daily-revalidated unchanged source reads `fresh`.
//   - `landscape` derives recent-KEV + high-EPSS candidates deterministically.

import { join } from "node:path";
import type { Pool } from "pg";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import {
  closeAdminPool,
  createTestDatabase,
  dropTestDatabase,
  hasPostgres,
} from "@/lib/db/__tests__/db-test-helpers";
import { runMigrations } from "@/lib/db/migrate";
import { ALL_CVE_SOURCES, type CveSourceId } from "../catalog";
import { PgCveCatalog } from "../pg-catalog";
import { computeCveStatus } from "../status";

const FEED_MIGRATIONS_DIR = join(process.cwd(), "migrations", "feed");
const FEED_LOCK_ID = 6011;

const NOW = "2026-06-14T00:00:00Z";
const FRESH = "2026-06-13T00:00:00Z"; // < 7 days before NOW
const STALE = "2026-01-01T00:00:00Z"; // > 7 days before NOW
const ALL = new Set<CveSourceId>(ALL_CVE_SOURCES);

interface SnapshotSeed {
  cvssScore?: number;
  cwe?: string[];
  cvssVector?: string;
  kevKnownExploited?: boolean;
  kevDateAdded?: string;
  inTheWild?: boolean;
  epssScore?: number;
  epssPercentile?: number;
  description?: string;
  publishedAt?: string;
}

describe.skipIf(!hasPostgres)("PgCveCatalog (DB)", () => {
  let feedDbName: string;
  let feedPool: Pool;

  beforeEach(async () => {
    if (feedPool) {
      await dropTestDatabase(feedDbName, feedPool, "feed");
    }
    const feed = await createTestDatabase("cve_catalog", "feed");
    feedDbName = feed.dbName;
    feedPool = feed.pool;
    await runMigrations(feedPool, FEED_MIGRATIONS_DIR, FEED_LOCK_ID);
  });

  afterAll(async () => {
    if (feedPool) {
      await dropTestDatabase(feedDbName, feedPool, "feed");
    }
    await closeAdminPool();
  });

  async function seedRow(
    sourceId: CveSourceId,
    cve: string,
    data: SnapshotSeed,
  ): Promise<void> {
    await feedPool.query(
      `INSERT INTO cve_snapshot
         (source_id, cve, cvss_score, cwe, cvss_vector, kev_known_exploited,
          kev_date_added, in_the_wild, epss_score, epss_percentile,
          description, published_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12::timestamptz)`,
      [
        sourceId,
        cve,
        data.cvssScore ?? null,
        data.cwe ?? null,
        data.cvssVector ?? null,
        data.kevKnownExploited ?? null,
        data.kevDateAdded ?? null,
        data.inTheWild ?? null,
        data.epssScore ?? null,
        data.epssPercentile ?? null,
        data.description ?? null,
        data.publishedAt ?? null,
      ],
    );
  }

  /** Mark a source successfully fetched at `at` (the freshness clock). */
  async function seedFetchOk(sourceId: CveSourceId, at: string): Promise<void> {
    await feedPool.query(
      `INSERT INTO cve_fetch_state
         (source_id, last_fetched_at, last_attempt_at, last_status, updated_at)
       VALUES ($1, $2::timestamptz, $2::timestamptz, 'ok', $2::timestamptz)`,
      [sourceId, at],
    );
  }

  /** Mark a source that has only ever failed (never successfully fetched). */
  async function seedFetchFailed(sourceId: CveSourceId): Promise<void> {
    await feedPool.query(
      `INSERT INTO cve_fetch_state
         (source_id, last_attempt_at, last_status, last_error, updated_at)
       VALUES ($1, $2::timestamptz, 'error', 'boom', $2::timestamptz)`,
      [sourceId, NOW],
    );
  }

  async function allFresh(): Promise<void> {
    for (const source of ALL_CVE_SOURCES) await seedFetchOk(source, FRESH);
  }

  // -------------------------------------------------------------------------
  // lookup
  // -------------------------------------------------------------------------

  it("merges nvd/kev/epss rows into one CveRecord", async () => {
    await allFresh();
    await seedRow("nvd", "CVE-2024-3400", {
      cvssScore: 10.0,
      cwe: ["CWE-77"],
      cvssVector: "CVSS:3.1/AV:N",
      description: "PAN-OS GlobalProtect command injection.",
      publishedAt: "2024-04-12T00:00:00Z",
    });
    await seedRow("kev", "CVE-2024-3400", {
      kevKnownExploited: true,
      kevDateAdded: "2024-04-12",
      inTheWild: true,
      description: "Palo Alto PAN-OS — actively exploited.",
    });
    await seedRow("epss", "CVE-2024-3400", {
      epssScore: 0.94,
      epssPercentile: 0.999,
    });

    const rec = await new PgCveCatalog(feedPool).lookup("CVE-2024-3400");
    expect(rec).not.toBeNull();
    expect(rec?.cve).toBe("CVE-2024-3400");
    expect(rec?.cvss).toEqual({
      score: 10.0,
      cwe: ["CWE-77"],
      source: "nvd",
    });
    expect(rec?.kev).toEqual({
      knownExploited: true,
      dateAdded: "2024-04-12",
      source: "kev",
    });
    expect(rec?.epss).toEqual({
      score: 0.94,
      percentile: 0.999,
      source: "epss",
    });
    // summary stays NVD-gated (the NVD row's description), not the KEV one.
    expect(rec?.summary).toBe("PAN-OS GlobalProtect command injection.");
    expect(rec?.inTheWild).toBe(true);
    expect(rec?.sources).toEqual(["nvd", "kev", "epss"]);
  });

  it("returns cvss: null with the KEV fact for a KEV-only CVE", async () => {
    await allFresh();
    await seedRow("kev", "CVE-2025-9999", {
      kevKnownExploited: true,
      kevDateAdded: "2025-05-01",
      inTheWild: true,
      description: "KEV-only entry.",
    });

    const rec = await new PgCveCatalog(feedPool).lookup("CVE-2025-9999");
    expect(rec?.cvss).toBeNull();
    expect(rec?.epss).toBeNull();
    expect(rec?.summary).toBeNull();
    expect(rec?.kev).toEqual({
      knownExploited: true,
      dateAdded: "2025-05-01",
      source: "kev",
    });
    expect(rec?.inTheWild).toBe(true);
    expect(rec?.sources).toEqual(["kev"]);
  });

  it("returns null for an absent CVE", async () => {
    await allFresh();
    await seedRow("nvd", "CVE-2024-3400", { cvssScore: 9.8 });
    expect(await new PgCveCatalog(feedPool).lookup("CVE-2000-0001")).toBeNull();
  });

  it("returns null when the only contributing source is unavailable, but reports it could-not-consult", async () => {
    // KEV never fetched (unavailable); the CVE exists only on the KEV row.
    await seedFetchOk("nvd", FRESH);
    await seedFetchOk("epss", FRESH);
    await seedFetchFailed("kev");
    await seedRow("kev", "CVE-2025-1234", {
      kevKnownExploited: true,
      kevDateAdded: "2025-05-01",
    });

    const catalog = new PgCveCatalog(feedPool);
    // Existence cannot be confirmed (could-not-consult), so lookup is null...
    expect(await catalog.lookup("CVE-2025-1234")).toBeNull();
    // ...and the availability is reported via sourceOutcomes, not a silent miss.
    const outcomes = await catalog.sourceOutcomes();
    expect(outcomes.find((o) => o.source === "kev")?.answered).toBe(false);
    // computeCveStatus collapses that into `unknown` (could-not-consult).
    expect(computeCveStatus(outcomes, ALL, NOW).status).toBe("unknown");
  });

  it("returns a stale-but-answered source's facts (staleness is not a lookup miss)", async () => {
    // KEV answered but stale; its facts must still be returned by lookup.
    await seedFetchOk("nvd", FRESH);
    await seedFetchOk("epss", FRESH);
    await seedFetchOk("kev", STALE);
    await seedRow("kev", "CVE-2024-3400", {
      kevKnownExploited: true,
      kevDateAdded: "2024-04-12",
      inTheWild: true,
    });

    const catalog = new PgCveCatalog(feedPool);
    const rec = await catalog.lookup("CVE-2024-3400");
    expect(rec?.kev?.knownExploited).toBe(true);
    expect(rec?.sources).toEqual(["kev"]);
    // Staleness surfaces only via sourceOutcomes → computeCveStatus = stale.
    const outcomes = await catalog.sourceOutcomes();
    expect(computeCveStatus(outcomes, ALL, NOW).status).toBe("stale");
  });

  // -------------------------------------------------------------------------
  // sourceOutcomes / computeCveStatus
  // -------------------------------------------------------------------------

  it("sourceOutcomes: available vs stale vs never-fetched, driving status", async () => {
    await seedFetchOk("nvd", FRESH);
    await seedFetchOk("kev", STALE);
    // epss never fetched (no row at all).

    const outcomes = await new PgCveCatalog(feedPool).sourceOutcomes();
    const byId = new Map(outcomes.map((o) => [o.source, o]));
    expect(byId.get("nvd")).toEqual({
      source: "nvd",
      answered: true,
      sourceUpdatedAt: new Date(FRESH).toISOString(),
    });
    expect(byId.get("kev")?.answered).toBe(true);
    expect(byId.get("epss")).toEqual({
      source: "epss",
      answered: false,
      sourceUpdatedAt: undefined,
    });
    // epss never attempted ⇒ unavailable ⇒ status unknown.
    expect(computeCveStatus(outcomes, ALL, NOW).status).toBe("unknown");
  });

  it("a daily-revalidated unchanged source reads fresh (clock bumped, no data change)", async () => {
    // All three revalidated within the window; no snapshot change needed.
    await allFresh();
    const outcomes = await new PgCveCatalog(feedPool).sourceOutcomes();
    expect(computeCveStatus(outcomes, ALL, NOW).status).toBe("complete");
  });

  it("a fetch row that only ever failed is answered: false", async () => {
    await seedFetchFailed("nvd");
    const outcomes = await new PgCveCatalog(feedPool).sourceOutcomes();
    expect(outcomes.find((o) => o.source === "nvd")).toEqual({
      source: "nvd",
      answered: false,
      sourceUpdatedAt: undefined,
    });
  });

  // -------------------------------------------------------------------------
  // landscape
  // -------------------------------------------------------------------------

  it("derives recent-KEV + high-EPSS candidates with source-local descriptions", async () => {
    await allFresh();
    // KEV candidate (no NVD row): description comes from CISA, not NVD.
    await seedRow("kev", "CVE-2024-3400", {
      kevKnownExploited: true,
      kevDateAdded: "2024-04-12",
      inTheWild: true,
      description: "CISA KEV shortDescription.",
      publishedAt: "2024-04-12T00:00:00Z",
    });
    // High-EPSS-only candidate (≥ 0.5): no KEV, description from NVD.
    await seedRow("nvd", "CVE-2024-23897", {
      cvssScore: 9.8,
      description: "Jenkins CLI arbitrary file read.",
      publishedAt: "2024-01-24T00:00:00Z",
    });
    await seedRow("epss", "CVE-2024-23897", {
      epssScore: 0.62,
      epssPercentile: 0.978,
    });
    // Low-EPSS, non-KEV → NOT a candidate.
    await seedRow("epss", "CVE-2024-0001", {
      epssScore: 0.01,
      epssPercentile: 0.1,
    });

    const records = await new PgCveCatalog(feedPool).landscape();
    const byCve = new Map(records.map((r) => [r.cve, r]));
    expect([...byCve.keys()].sort()).toEqual([
      "CVE-2024-23897",
      "CVE-2024-3400",
    ]);

    const kevOnly = byCve.get("CVE-2024-3400");
    expect(kevOnly?.kev).toBe(true);
    expect(kevOnly?.kevDateAdded).toBe("2024-04-12");
    expect(kevOnly?.epss).toBeNull();
    expect(kevOnly?.description).toBe("CISA KEV shortDescription.");
    expect(kevOnly?.publishedAt).toBe(
      new Date("2024-04-12T00:00:00Z").toISOString(),
    );

    const highEpss = byCve.get("CVE-2024-23897");
    expect(highEpss?.kev).toBe(false);
    expect(highEpss?.epss).toBe(0.62);
    expect(highEpss?.epssPercentile).toBe(0.978);
    expect(highEpss?.description).toBe("Jenkins CLI arbitrary file read.");
  });

  it("excludes never-fetched sources from lookup and landscape", async () => {
    // No fetch-state rows at all → no answered sources.
    await seedRow("kev", "CVE-2024-3400", {
      kevKnownExploited: true,
      kevDateAdded: "2024-04-12",
    });
    const catalog = new PgCveCatalog(feedPool);
    expect(await catalog.lookup("CVE-2024-3400")).toBeNull();
    expect(await catalog.landscape()).toEqual([]);
  });
});
