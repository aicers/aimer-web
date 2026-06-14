// RFC 0005 (#612) — full-pipeline drop-in parity: `PgCveCatalog` (ingested
// data) vs `FixtureCveCatalog` (equivalent in-memory data).
//
// The foundation (#601) + ingestion (#611) are only useful if the DB-backed
// catalog is a TRUE drop-in for the fixture: given equivalent data, the WHOLE
// pipeline — normalize → validate → enrich → status → landscape → render —
// must behave identically. This test seeds the `cve_snapshot` /
// `cve_fetch_state` tables and an equivalent `FixtureCveCatalog` from ONE
// shared dataset, then drives both catalogs through every pipeline stage and
// asserts identical results.
//
// `FixtureCveCatalog.landscape()` returns a pre-baked array (it does not
// derive), so the landscape stage is checked two ways: the hand-written
// EXPECTED_LANDSCAPE pins `PgCveCatalog`'s DERIVATION from the seed, and is
// reused as the fixture's landscape config so the downstream selection/render
// stages run on equal inputs through both catalogs.

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
import {
  ALL_CVE_SOURCES,
  type CveLandscapeRecord,
  type CveRecord,
  type CveSourceId,
} from "../catalog";
import {
  allAvailableSources,
  FixtureCveCatalog,
  type FixtureCveData,
} from "../fixture-catalog";
import {
  buildEventLandscapeEntries,
  buildStoryLandscapeFacts,
  selectEventLandscape,
  selectStoryLandscape,
} from "../landscape";
import { PgCveCatalog } from "../pg-catalog";
import { validateCveRefs } from "../validate";
import { cveRowState, formatCvePayload, formatCveSources } from "../view";

const FEED_MIGRATIONS_DIR = join(process.cwd(), "migrations", "feed");
const FEED_LOCK_ID = 6012;

const NOW = "2026-06-14T00:00:00Z";
const FRESH_DB = "2026-06-13T00:00:00Z"; // < 7 days before NOW
// The fixture must report the SAME `sourceUpdatedAt` PgCveCatalog derives from
// the `last_fetched_at` clock — which round-trips through pg as a Date and is
// emitted via `Date.toISOString()` (millisecond form).
const FRESH_ISO = new Date(FRESH_DB).toISOString();

// --- The single shared dataset --------------------------------------------

interface SnapshotSeed {
  cvssScore?: number;
  cwe?: string[];
  kevKnownExploited?: boolean;
  kevDateAdded?: string;
  inTheWild?: boolean;
  epssScore?: number;
  epssPercentile?: number;
  description?: string;
  publishedAt?: string;
}

/** Per-source snapshot rows to seed into the DB. */
const SNAPSHOT: Array<{
  source: CveSourceId;
  cve: string;
  data: SnapshotSeed;
}> = [
  // Full record: NVD + KEV + EPSS.
  {
    source: "nvd",
    cve: "CVE-2024-3400",
    data: {
      cvssScore: 10.0,
      cwe: ["CWE-77"],
      description: "PAN-OS GlobalProtect command injection.",
      publishedAt: "2024-04-12T00:00:00Z",
    },
  },
  {
    source: "kev",
    cve: "CVE-2024-3400",
    data: {
      kevKnownExploited: true,
      kevDateAdded: "2024-04-12",
      inTheWild: true,
      description: "CISA KEV shortDescription.",
    },
  },
  {
    source: "epss",
    cve: "CVE-2024-3400",
    data: { epssScore: 0.94, epssPercentile: 0.999 },
  },
  // NVD + high-EPSS (no KEV).
  {
    source: "nvd",
    cve: "CVE-2024-23897",
    data: {
      cvssScore: 9.8,
      description: "Jenkins CLI arbitrary file read.",
      publishedAt: "2024-01-24T00:00:00Z",
    },
  },
  {
    source: "epss",
    cve: "CVE-2024-23897",
    data: { epssScore: 0.62, epssPercentile: 0.978 },
  },
  // KEV-only.
  {
    source: "kev",
    cve: "CVE-2025-9999",
    data: {
      kevKnownExploited: true,
      kevDateAdded: "2025-05-01",
      inTheWild: true,
      description: "KEV-only entry.",
    },
  },
  // EPSS-only, low score → a lookup hit but NOT a landscape candidate.
  {
    source: "epss",
    cve: "CVE-2024-0001",
    data: { epssScore: 0.01, epssPercentile: 0.1 },
  },
];

/** The same dataset as the fixture's per-CVE records. */
const FIXTURE_RECORDS: Record<string, FixtureCveData> = {
  "CVE-2024-3400": {
    cvss: 10.0,
    cwe: ["CWE-77"],
    summary: "PAN-OS GlobalProtect command injection.",
    kev: true,
    kevDateAdded: "2024-04-12",
    inTheWild: true,
    epss: 0.94,
    epssPercentile: 0.999,
  },
  "CVE-2024-23897": {
    cvss: 9.8,
    summary: "Jenkins CLI arbitrary file read.",
    epss: 0.62,
    epssPercentile: 0.978,
  },
  "CVE-2025-9999": {
    kev: true,
    kevDateAdded: "2025-05-01",
    inTheWild: true,
  },
  "CVE-2024-0001": { epss: 0.01, epssPercentile: 0.1 },
};

/**
 * `PgCveCatalog.landscape()`'s expected DERIVATION from the seed (ordered by
 * canonical id). Pins the derivation AND seeds the fixture so the downstream
 * landscape stages run on equal inputs.
 */
const EXPECTED_LANDSCAPE: CveLandscapeRecord[] = [
  {
    cve: "CVE-2024-23897",
    publishedAt: new Date("2024-01-24T00:00:00Z").toISOString(),
    kev: false,
    kevDateAdded: undefined,
    epss: 0.62,
    epssPercentile: 0.978,
    description: "Jenkins CLI arbitrary file read.",
  },
  {
    cve: "CVE-2024-3400",
    publishedAt: new Date("2024-04-12T00:00:00Z").toISOString(),
    kev: true,
    kevDateAdded: "2024-04-12",
    epss: 0.94,
    epssPercentile: 0.999,
    description: "CISA KEV shortDescription.",
  },
  {
    cve: "CVE-2025-9999",
    publishedAt: "2025-05-01",
    kev: true,
    kevDateAdded: "2025-05-01",
    epss: null,
    epssPercentile: null,
    description: "KEV-only entry.",
  },
];

// Refs fed through validation: lowercase (normalize), a KEV-only id, an
// EPSS-only id, a hallucinated absent id, and a duplicate.
const RAW_REFS = [
  "cve-2024-3400",
  "CVE-2024-23897",
  "CVE-2025-9999",
  "CVE-2024-0001",
  "CVE-2099-99999",
  "CVE-2024-3400",
];

// A wide window so the recency filter does not drop the (older) seed dates;
// the point here is selection/ordering parity, not the window math.
const LANDSCAPE_OPTS = { now: NOW, windowDays: 1_000_000 };

function renderViews(refs: readonly CveRecord[]): Array<{
  state: ReturnType<typeof cveRowState>;
  payload: string;
  sources: string;
}> {
  return refs.map((r) => ({
    state: cveRowState({ refs: [r], status: "complete", significant: true }),
    payload: formatCvePayload(r),
    sources: formatCveSources(r),
  }));
}

describe.skipIf(!hasPostgres)("CVE full-pipeline drop-in parity (DB)", () => {
  let feedDbName: string;
  let feedPool: Pool;
  let pgCatalog: PgCveCatalog;
  let fixtureCatalog: FixtureCveCatalog;

  beforeEach(async () => {
    if (feedPool) {
      await dropTestDatabase(feedDbName, feedPool, "feed");
    }
    const feed = await createTestDatabase("cve_parity", "feed");
    feedDbName = feed.dbName;
    feedPool = feed.pool;
    await runMigrations(feedPool, FEED_MIGRATIONS_DIR, FEED_LOCK_ID);

    for (const { source, cve, data } of SNAPSHOT) {
      await feedPool.query(
        `INSERT INTO cve_snapshot
           (source_id, cve, cvss_score, cwe, cvss_vector, kev_known_exploited,
            kev_date_added, in_the_wild, epss_score, epss_percentile,
            description, published_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12::timestamptz)`,
        [
          source,
          cve,
          data.cvssScore ?? null,
          data.cwe ?? null,
          null,
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
    for (const source of ALL_CVE_SOURCES) {
      await feedPool.query(
        `INSERT INTO cve_fetch_state
           (source_id, last_fetched_at, last_attempt_at, last_status, updated_at)
         VALUES ($1, $2::timestamptz, $2::timestamptz, 'ok', $2::timestamptz)`,
        [source, FRESH_DB],
      );
    }

    pgCatalog = new PgCveCatalog(feedPool);
    fixtureCatalog = new FixtureCveCatalog({
      sources: allAvailableSources(FRESH_ISO),
      records: FIXTURE_RECORDS,
      landscape: EXPECTED_LANDSCAPE,
    });
  });

  afterAll(async () => {
    if (feedPool) {
      await dropTestDatabase(feedDbName, feedPool, "feed");
    }
    await closeAdminPool();
  });

  it("sourceOutcomes are identical (availability + freshness)", async () => {
    const pg = await pgCatalog.sourceOutcomes();
    const fixture = await fixtureCatalog.sourceOutcomes();
    expect(pg).toEqual(fixture);
  });

  it("lookup yields identical CveRecords for every seeded CVE", async () => {
    for (const cve of Object.keys(FIXTURE_RECORDS)) {
      const pg = await pgCatalog.lookup(cve);
      const fixture = await fixtureCatalog.lookup(cve);
      expect(pg).toEqual(fixture);
    }
    // An absent id is a null miss in both.
    expect(await pgCatalog.lookup("CVE-2099-99999")).toBeNull();
    expect(await fixtureCatalog.lookup("CVE-2099-99999")).toBeNull();
  });

  it("validate → enrich → status is identical (incl. the hallucination drop)", async () => {
    const pg = await validateCveRefs(RAW_REFS, pgCatalog, { checkedAt: NOW });
    const fixture = await validateCveRefs(RAW_REFS, fixtureCatalog, {
      checkedAt: NOW,
    });
    expect(pg).toEqual(fixture);
    // Sanity: the pipeline actually did work — four enriched, one dropped as a
    // hallucination, and an authoritative `complete` status.
    expect(pg.valid.map((r) => r.cve)).toEqual([
      "CVE-2024-3400",
      "CVE-2024-23897",
      "CVE-2025-9999",
      "CVE-2024-0001",
    ]);
    expect(pg.dropped).toEqual([
      { id: "CVE-2099-99999", reason: "not_in_catalog" },
    ]);
    expect(pg.status.status).toBe("complete");
  });

  it("landscape derivation + selection + framing are identical", async () => {
    const pgLandscape = await pgCatalog.landscape();
    // PgCveCatalog derives exactly the hand-written expectation from the seed.
    expect(pgLandscape).toEqual(EXPECTED_LANDSCAPE);
    // And the fixture (pre-baked to the same) returns the same universe.
    const fixtureLandscape = await fixtureCatalog.landscape();
    expect(fixtureLandscape).toEqual(pgLandscape);

    // Downstream selection + prompt building, run through BOTH catalogs.
    const pgStory = buildStoryLandscapeFacts(
      selectStoryLandscape(pgLandscape, LANDSCAPE_OPTS),
    );
    const fixtureStory = buildStoryLandscapeFacts(
      selectStoryLandscape(fixtureLandscape, LANDSCAPE_OPTS),
    );
    expect(pgStory).toEqual(fixtureStory);
    expect(pgStory.length).toBeGreaterThan(1); // framing + >=1 entry

    const pgEvent = buildEventLandscapeEntries(
      selectEventLandscape(pgLandscape, LANDSCAPE_OPTS),
    );
    const fixtureEvent = buildEventLandscapeEntries(
      selectEventLandscape(fixtureLandscape, LANDSCAPE_OPTS),
    );
    expect(pgEvent).toEqual(fixtureEvent);
    // KEV-only slice: the two KEV candidates, NVD/EPSS-only ones excluded.
    expect(pgEvent.map((e) => e.cve)).toEqual([
      "CVE-2024-3400",
      "CVE-2025-9999",
    ]);
  });

  it("render (chip state + payload + sources) is identical", async () => {
    const pg = await validateCveRefs(RAW_REFS, pgCatalog, { checkedAt: NOW });
    const fixture = await validateCveRefs(RAW_REFS, fixtureCatalog, {
      checkedAt: NOW,
    });
    const pgViews = renderViews(pg.valid);
    const fixtureViews = renderViews(fixture.valid);
    expect(pgViews).toEqual(fixtureViews);
    // Every validated record renders as chips with a non-empty provenance.
    for (const v of pgViews) {
      expect(v.state.kind).toBe("chips");
      expect(v.sources.length).toBeGreaterThan(0);
    }
  });
});
