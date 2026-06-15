// RFC 0003 F4 fan-out (#628) — Huntress vendor-repo fixture-mode seeding (DB).
//
// Like Unit 42 (#623), Huntress declares a `fixtureDir`, not a flat
// `fixtureFile`, so the flat `FixtureFeedSource` path never seeds it. With
// `deterministicCoverage: true`, an unseeded source would probe `present:false`
// → coverage `unavailable`/`unknown` in any fixture-backed stack. This proves
// `seedFixtureFeeds` walks the committed `huntress-fixture/` tree through the
// vendor-repo engine so the source is PRESENT (coverage-deterministic), its rows
// aggregate across BOTH CSVs into ONE snapshot, the four junk-type false
// positives never land, and the rule/script files are never imported.

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
const SOURCE_ID = "huntress/threat-intel";
const FRESH = "2026-06-14T00:00:00.000Z";

interface SnapshotRow {
  match_value: string | null;
  entity_type: string;
  hit_type: string;
  context: { campaign?: string } | null;
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

describe.skipIf(!hasPostgres)(
  "huntress vendor-repo fixture seeding (DB)",
  () => {
    let feedDbName: string;
    let feedPool: Pool;

    beforeEach(async () => {
      if (feedPool) {
        await dropTestDatabase(feedDbName, feedPool, "feed");
      }
      const feed = await createTestDatabase("ti_feed_huntress", "feed");
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

      // The source is PRESENT — coverage resolves deterministically.
      const store = new PgFeedStore(feedPool);
      const probe = await store.probe(SOURCE_ID);
      expect(probe.present).toBe(true);
      expect(probe.sourceUpdatedAt).toBe(FRESH);

      const rows = await readSnapshot(feedPool);
      const values = rows.map((r) => r.match_value);
      // Both CSVs aggregated into ONE snapshot (non-clobbering).
      expect(values).toContain("45.137.21.8");
      expect(values).toContain("193.233.202.17");
      expect(values).toContain("gentlemen-leak.example");
      expect(values).toContain("https://gentlemen-leak.example/login");
      expect(values).toContain("rat-c2.example");
      // Mixed-case incident CSV aggregated too.
      expect(values).toContain("185.234.72.19");
      expect(values).toContain("kali365-panel.example");

      // The four junk-type false positives never reached the snapshot.
      const joined = values.join(" ");
      expect(joined).not.toContain("huntress.com/blog");
      expect(joined).not.toContain("BlackByte");
      expect(joined).not.toContain("00f2a1b3c4d5e6f7a8b9c0d1e2f3a4b5");
      expect(joined).not.toContain("window.open");
      // A CIDR-shaped `ip` row never leaks its bare network address as a host.
      expect(joined).not.toContain("43.173.64.0");
      // The rule / script sentinels never reached the snapshot.
      expect(joined).not.toContain("should-never-be-fetched");
      expect(joined).not.toContain("never-fetched-host");
      expect(joined).not.toContain("script-sentinel");

      // Rows carry their filename-derived incident campaign + deterministic hit.
      const byValue = new Map(rows.map((r) => [r.match_value, r]));
      expect(byValue.get("45.137.21.8")?.context?.campaign).toBe("gentlemen");
      expect(byValue.get("rat-c2.example")?.context?.campaign).toBe(
        "fileless-loader-rat",
      );
      expect(byValue.get("185.234.72.19")?.context?.campaign).toBe(
        "kali365-IoCs",
      );
      expect(byValue.get("45.137.21.8")?.entity_type).toBe("IP");
      expect(byValue.get("gentlemen-leak.example")?.hit_type).toBe(
        "deterministic_ioc",
      );
    });
  },
);
