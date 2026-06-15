// RFC 0003 F4 fan-out (#629) — Meta Threat Research vendor-repo import (DB).
//
// Drives the merged vendor-repo engine (#603) END-TO-END through the real
// import path — `importVendorRepo` (NOT `seedFixtureFeeds`) over the committed
// `meta-fixture/` tree using the real descriptor — so the central CIB downgrade
// is asserted against the STORED snapshot: every row lands as `soft_reputation`
// in `ioc_feed_snapshot`, never `deterministic_ioc`, even though the import is
// driven with a DETERMINISTIC default `hitType` on purpose (see the call site).
// This is the CIB-guard showcase: influence-ops attribution can never become a
// deterministic / floor hit, no matter what the caller defaults to.

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
  FixtureVendorRepoProvider,
  importVendorRepo,
} from "../feed-vendor-repo";
import "../sources/index";
import { getTiSourceDescriptor } from "../sources/registry";

const FEED_MIGRATIONS_DIR = join(process.cwd(), "migrations", "feed");
const FEED_LOCK_ID = 6293;
const SOURCE_ID = "meta/threat-research";
const FRESH = "2026-06-14T00:00:00.000Z";
const FIXTURE_ROOT = join(
  process.cwd(),
  "src",
  "lib",
  "analysis",
  "enrichment",
  "feeds",
  "meta-fixture",
);

interface SnapshotRow {
  match_value: string | null;
  entity_type: string;
  hit_type: string;
  classification: string | null;
}

async function readSnapshot(pool: Pool): Promise<SnapshotRow[]> {
  const { rows } = await pool.query<SnapshotRow>(
    `SELECT match_value, entity_type, hit_type, classification
       FROM ioc_feed_snapshot WHERE source_policy_id = $1
       ORDER BY match_value`,
    [SOURCE_ID],
  );
  return rows;
}

describe.skipIf(!hasPostgres)("meta vendor-repo import (DB)", () => {
  let feedDbName: string;
  let feedPool: Pool;

  beforeEach(async () => {
    if (feedPool) {
      await dropTestDatabase(feedDbName, feedPool, "feed");
    }
    const feed = await createTestDatabase("ti_feed_meta", "feed");
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

  it("imports every allowlisted CSV into ONE snapshot, all rows soft_reputation", async () => {
    const d = getTiSourceDescriptor(SOURCE_ID);
    if (!d?.vendorRepo) throw new Error("meta descriptor missing vendorRepo");
    const provider = new FixtureVendorRepoProvider(FIXTURE_ROOT);
    const result = await importVendorRepo(feedPool, provider, {
      sourcePolicyId: d.sourcePolicyId,
      entityType: d.entityType,
      // Drive the import with a DETERMINISTIC default on purpose, NOT the
      // descriptor's `soft_reputation`. The descriptor default is already soft,
      // so the stored-row assertion below would pass trivially even if the
      // central import path ignored `deterministicAllowed`. Forcing a
      // `deterministic_ioc` default makes the CIB guard load-bearing: the only
      // way every stored row can still be `soft_reputation` is the central
      // `deterministicAllowed: false` downgrade overriding it.
      hitType: "deterministic_ioc",
      classification: d.classification,
      vendorRepo: d.vendorRepo,
      sourceUpdatedAt: FRESH,
    });
    expect(result.rowCount).toBe(4);
    // Only the two CSVs were fetched; everything else allowlist-skipped.
    expect(result.fetched).toHaveLength(2);

    const rows = await readSnapshot(feedPool);
    const values = rows.map((r) => r.match_value);
    // Both CSVs aggregated into one snapshot (non-clobbering).
    expect(values).toContain("cib-network.example");
    expect(values).toContain("https://legacy-malware.example/payload.bin");
    expect(values).toContain("c2-legacy.example");
    expect(rows).toHaveLength(4);

    // THE guard, asserted against the stored snapshot: EVERY row is
    // soft_reputation, never deterministic — CIB content can never drive a
    // known_ioc_hit.
    for (const row of rows) {
      expect(row.hit_type).toBe("soft_reputation");
    }

    // The CIB count / narrative sentinels never reached the snapshot.
    const joined = values.join(" ");
    expect(joined).not.toContain("Accounts");
    expect(joined).not.toContain("should-never-be-fetched");
  });
});
