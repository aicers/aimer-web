// RFC 0003 F6 (#594) — context round-trip through a real feed DB.
//
// Imports an `ioc_feed_snapshot` row whose `context` JSONB is populated, then
// reads it back via `PgFeedStore.match` and asserts the typed
// `EnrichmentContextPayload` lands on the match. Also asserts that a malformed
// stored context is dropped by the narrowing validator (never trusted as-is)
// and that a context-less row yields no `contextPayload`.

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
import { importFeedSnapshot } from "../feed-import";
import { PgFeedStore } from "../feed-store";
import { normalizeIp } from "../normalization";

const FEED_MIGRATIONS_DIR = join(process.cwd(), "migrations", "feed");
const FEED_LOCK_ID = 5942;

describe.skipIf(!hasPostgres)("PgFeedStore context round-trip (DB)", () => {
  let feedDbName: string;
  let feedPool: Pool;

  beforeEach(async () => {
    if (feedPool) {
      await dropTestDatabase(feedDbName, feedPool, "feed");
    }
    const feed = await createTestDatabase("ti_feed_store", "feed");
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

  it("carries a populated context onto the match", async () => {
    await importFeedSnapshot(feedPool, {
      sourcePolicyId: "vendor/unit42",
      entityType: "IP",
      hitType: "deterministic_ioc",
      classification: "c2",
      rows: [
        {
          matchValue: "45.66.230.5",
          context: {
            actor: "Sandworm",
            campaign: "BlackEnergy",
            malwareFamily: "Industroyer",
            reportUrl: "https://vendor.example/report",
            extra: { tlp: "amber" },
          },
        },
      ],
    });

    const store = new PgFeedStore(feedPool);
    const matches = await store.match(
      "vendor/unit42",
      normalizeIp("45.66.230.5"),
    );
    expect(matches).toHaveLength(1);
    expect(matches[0].contextPayload).toEqual({
      actor: "Sandworm",
      campaign: "BlackEnergy",
      malwareFamily: "Industroyer",
      reportUrl: "https://vendor.example/report",
      extra: { tlp: "amber" },
    });
  });

  it("yields no contextPayload for a context-less row", async () => {
    await importFeedSnapshot(feedPool, {
      sourcePolicyId: "abuse.ch/feodo",
      entityType: "IP",
      hitType: "deterministic_ioc",
      rows: [{ matchValue: "45.66.230.5" }],
    });

    const store = new PgFeedStore(feedPool);
    const matches = await store.match(
      "abuse.ch/feodo",
      normalizeIp("45.66.230.5"),
    );
    expect(matches).toHaveLength(1);
    expect(matches[0].contextPayload).toBeUndefined();
  });

  it("drops a malformed stored context (validator, not trusted as-is)", async () => {
    // Bypass the importer to write an unexpected shape directly, simulating a
    // hand-edited / drifted row.
    await feedPool.query(
      `INSERT INTO ioc_feed_snapshot
         (source_policy_id, entity_type, match_value, hit_type, context)
       VALUES ($1, 'IP', '45.66.230.5', 'deterministic_ioc', $2::jsonb)`,
      ["vendor/bad", JSON.stringify({ actor: 42, junk: "x" })],
    );

    const store = new PgFeedStore(feedPool);
    const matches = await store.match("vendor/bad", normalizeIp("45.66.230.5"));
    expect(matches).toHaveLength(1);
    expect(matches[0].contextPayload).toBeUndefined();
  });
});
