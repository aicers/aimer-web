// RFC 0003 F4 (#603) — vendor-repo importer DB tests.
//
// Exercises `importVendorRepo` against a real feed DB over the committed
// fixture tree (no network). Proves the acceptance criteria that need the
// PERSISTED rows read back:
//   - per-source BATCH import: every allowlisted file's rows land in one
//     snapshot replace (no last-file-wins clobber),
//   - the CIB downgrade guard: a `deterministicAllowed: false` file's rows are
//     stored as `soft_reputation` even though the source default is
//     `deterministic_ioc` (verify the stored `hit_type`, not mere exclusion),
//   - report context (actor/campaign/family/reportUrl) persisted on each row,
//   - the binary sentinel / rule file / CIB folder never reach the snapshot.

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
import type { VendorRepoConfig } from "../feed-source";
import {
  FixtureVendorRepoProvider,
  importVendorRepo,
  type VendorRepoCollectInput,
} from "../feed-vendor-repo";

const FEED_MIGRATIONS_DIR = join(process.cwd(), "migrations", "feed");
const FEED_LOCK_ID = 6031;

const FIXTURE_ROOT = join(
  process.cwd(),
  "src",
  "lib",
  "analysis",
  "enrichment",
  "feeds",
  "vendor-fixture",
);

const VENDOR_CONFIG: VendorRepoConfig = {
  owner: "vendor",
  repo: "ioc-reports",
  ref: "main",
  files: [
    {
      label: "iocs-csv",
      pathPattern: "reports/[^/]+/[^/]+/iocs\\.csv$",
      parse: "csv-column",
      parseConfig: {
        kind: "csv-column",
        columns: [{ name: "url", entityType: "URL" }],
        commentPrefix: "#",
      },
      entityType: "URL",
      contentClass: "malware",
    },
    {
      label: "prose-note",
      pathPattern: "reports/[^/]+/[^/]+/notes\\.md$",
      parse: "free-text",
      parseConfig: { kind: "free-text", refang: true },
      entityType: "DOMAIN",
      contentClass: "malware",
    },
    {
      label: "low-trust-list",
      pathPattern: "reports/softsource/[^/]+/indicators\\.txt$",
      parse: "generic-list",
      parseConfig: { kind: "generic-list", refang: true },
      entityType: "DOMAIN",
      contentClass: "low-trust",
      deterministicAllowed: false,
    },
  ],
  deterministicAllowed: true,
  contextPattern: "^reports/(?<actor>[^/]+)/(?<campaign>[^/]+)/",
  reportUrlTemplate: "https://vendor.test/reports/{actor}/{campaign}",
  context: { malwareFamily: "Snake" },
};

const COLLECT_INPUT: VendorRepoCollectInput = {
  sourcePolicyId: "vendor/ioc-reports",
  entityType: "URL",
  hitType: "deterministic_ioc",
  classification: "vendor_report",
  vendorRepo: VENDOR_CONFIG,
  sourceVersion: "fixture-v1",
  sourceUpdatedAt: "2026-06-14T00:00:00.000Z",
};

interface SnapshotRow {
  match_value: string | null;
  entity_type: string;
  hit_type: string;
  classification: string | null;
  context: unknown;
}

async function readSnapshot(pool: Pool): Promise<SnapshotRow[]> {
  const { rows } = await pool.query<SnapshotRow>(
    `SELECT match_value, entity_type, hit_type, classification, context
       FROM ioc_feed_snapshot WHERE source_policy_id = $1
       ORDER BY match_value`,
    [COLLECT_INPUT.sourcePolicyId],
  );
  return rows;
}

describe.skipIf(!hasPostgres)("vendor-repo importer (DB)", () => {
  let feedDbName: string;
  let feedPool: Pool;

  beforeEach(async () => {
    if (feedPool) {
      await dropTestDatabase(feedDbName, feedPool, "feed");
    }
    const feed = await createTestDatabase("ti_feed_vendor", "feed");
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

  it("batch-imports every allowlisted file into one snapshot (non-clobbering)", async () => {
    const provider = new FixtureVendorRepoProvider(FIXTURE_ROOT);
    const result = await importVendorRepo(feedPool, provider, COLLECT_INPUT);
    expect(result.rowCount).toBe(8);

    const rows = await readSnapshot(feedPool);
    const values = rows.map((r) => r.match_value);
    // Rows from all three allowlisted files are present together — proof the
    // many files did not clobber each other (no per-file replace loop).
    expect(values).toContain("https://c2.turla.test/gate.php"); // iocs.csv
    expect(values).toContain("https://panel.turla.test/login"); // iocs.csv
    expect(values).toContain("cdn.turla.test"); // notes.md free-text
    expect(values).toContain("185.100.87.202"); // notes.md free-text
    expect(values).toContain("evil.lowtrust.test"); // indicators.txt
    expect(values).toContain("drop.lowtrust.test"); // indicators.txt

    // The binary sentinel / rule file / CIB folder never reached the snapshot.
    expect(values.join(" ")).not.toContain("social.example");
    expect(result.skipped).toContain("reports/turla/snake/sample.exe");
  });

  it("persists the CIB-style downgrade as soft_reputation (stored hit_type)", async () => {
    const provider = new FixtureVendorRepoProvider(FIXTURE_ROOT);
    await importVendorRepo(feedPool, provider, COLLECT_INPUT);
    const rows = await readSnapshot(feedPool);
    const byValue = new Map(rows.map((r) => [r.match_value, r]));

    // deterministicAllowed:false file → soft_reputation despite the source
    // default of deterministic_ioc.
    expect(byValue.get("evil.lowtrust.test")?.hit_type).toBe("soft_reputation");
    expect(byValue.get("drop.lowtrust.test")?.hit_type).toBe("soft_reputation");
    // Genuine malware-report rows keep the deterministic default.
    expect(byValue.get("https://c2.turla.test/gate.php")?.hit_type).toBe(
      "deterministic_ioc",
    );
    expect(byValue.get("cdn.turla.test")?.hit_type).toBe("deterministic_ioc");
    // Each row carries its file's entity type, not the snapshot default — a
    // generic-list DOMAIN file under a URL-default source stays DOMAIN.
    expect(byValue.get("evil.lowtrust.test")?.entity_type).toBe("DOMAIN");
    expect(byValue.get("185.100.87.202")?.entity_type).toBe("IP");
    expect(byValue.get("https://c2.turla.test/gate.php")?.entity_type).toBe(
      "URL",
    );
  });

  it("persists report context on each row (actor/campaign/family/reportUrl)", async () => {
    const provider = new FixtureVendorRepoProvider(FIXTURE_ROOT);
    await importVendorRepo(feedPool, provider, COLLECT_INPUT);
    const rows = await readSnapshot(feedPool);
    const csvRow = rows.find(
      (r) => r.match_value === "https://c2.turla.test/gate.php",
    );
    expect(csvRow?.context).toEqual({
      actor: "turla",
      campaign: "snake",
      malwareFamily: "Snake",
      reportUrl: "https://vendor.test/reports/turla/snake",
    });
  });

  it("re-import replaces in place (single per-source snapshot, idempotent)", async () => {
    const provider1 = new FixtureVendorRepoProvider(FIXTURE_ROOT);
    const first = await importVendorRepo(feedPool, provider1, COLLECT_INPUT);
    const provider2 = new FixtureVendorRepoProvider(FIXTURE_ROOT);
    const second = await importVendorRepo(feedPool, provider2, COLLECT_INPUT);

    // Re-importing the same tree neither appends nor changes the content hash.
    expect(second.rowCount).toBe(first.rowCount);
    expect(second.feedHash).toBe(first.feedHash);
    const { rows } = await feedPool.query<{ cnt: string }>(
      `SELECT COUNT(*)::text AS cnt FROM ioc_feed_snapshot WHERE source_policy_id = $1`,
      [COLLECT_INPUT.sourcePolicyId],
    );
    expect(Number(rows[0].cnt)).toBe(8);
  });
});
