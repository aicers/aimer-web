// RFC 0003 F4 fan-out (#623) — Unit 42 vendor-repo fixture-mode seeding (DB).
//
// Integration gap #1: a vendor-repo source declares a `fixtureDir`, not a flat
// `fixtureFile`, so the flat `FixtureFeedSource` path never seeds it. With
// `deterministicCoverage: true`, an unseeded source would probe `present:false`
// → coverage `unavailable`/`unknown` in any fixture-backed stack. This test
// proves `seedFixtureFeeds` walks the committed `unit42-fixture/` tree through
// the vendor-repo engine so the source is PRESENT (coverage-deterministic), with
// its rows context-stamped and the non-IOC files never imported.

import type { Pool } from "pg";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { join } from "node:path";
import {
  closeAdminPool,
  createTestDatabase,
  dropTestDatabase,
  hasPostgres,
} from "@/lib/db/__tests__/db-test-helpers";
import { runMigrations } from "@/lib/db/migrate";
import { PgFeedStore } from "../feed-store";
import { seedFixtureFeeds } from "../fixture-feeds";

const FEED_MIGRATIONS_DIR = join(process.cwd(), "migrations", "feed");
const FEED_LOCK_ID = 6232;
const SOURCE_ID = "unit42/threat-intel";
const FRESH = "2026-06-14T00:00:00.000Z";

interface SnapshotRow {
  match_value: string | null;
  entity_type: string;
  hit_type: string;
  context: { campaign?: string; reportUrl?: string } | null;
}

async function readSnapshot(pool: Pool): Promise<SnapshotRow[]> {
  const { rows } = await pool.query<SnapshotRow>(
    `SELECT match_value, entity_type, hit_type, context
       FROM ioc_feed_snapshot WHERE source_policy_id = $1
       ORDER BY match_value`,
    [SOURCE_ID],
  );
  return rows;
}

describe.skipIf(!hasPostgres)("unit42 vendor-repo fixture seeding (DB)", () => {
  let feedDbName: string;
  let feedPool: Pool;

  beforeEach(async () => {
    if (feedPool) {
      await dropTestDatabase(feedDbName, feedPool, "feed");
    }
    const feed = await createTestDatabase("ti_feed_unit42", "feed");
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

  it("seeds the vendor-repo tree via fixtureDir (coverage-deterministic)", async () => {
    await seedFixtureFeeds(feedPool, { sourceUpdatedAt: FRESH });

    // The source is PRESENT — coverage resolves deterministically rather than
    // sitting at `unavailable`/`unknown`.
    const store = new PgFeedStore(feedPool);
    const probe = await store.probe(SOURCE_ID);
    expect(probe.present).toBe(true);
    expect(probe.sourceUpdatedAt).toBe(FRESH);

    const rows = await readSnapshot(feedPool);
    const values = rows.map((r) => r.match_value);
    // Both `.txt` files aggregated into one snapshot (non-clobbering).
    expect(values).toContain("https://malware.unit42.test/payload");
    expect(values).toContain("185.178.208.153");
    expect(values).toContain("phish.unit42.test");
    expect(values).toContain(
      "1111111111111111111111111111111111111111111111111111111111111111",
    );
    expect(rows).toHaveLength(6);

    // The .pdf / .py / .md sentinels never reached the snapshot.
    expect(values.join(" ")).not.toContain("should-never-be-fetched");
    expect(values.join(" ")).not.toContain("not-a-real.dll");

    // Rows carry their file's blob reportUrl + cluster campaign.
    const byValue = new Map(rows.map((r) => [r.match_value, r]));
    expect(byValue.get("185.178.208.153")?.context?.campaign).toBe(
      "CL-STA-0910",
    );
    expect(byValue.get("185.178.208.153")?.context?.reportUrl).toContain(
      "/CL-STA-0910-iocs.txt",
    );
    expect(byValue.get("185.178.208.153")?.entity_type).toBe("IP");
    expect(byValue.get("https://malware.unit42.test/payload")?.hit_type).toBe(
      "deterministic_ioc",
    );
  });
});
