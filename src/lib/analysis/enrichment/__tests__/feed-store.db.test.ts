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
import { importFeedSnapshot, importRawFeedPayload } from "../feed-import";
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

  // -------------------------------------------------------------------------
  // RFC 0003 F5 (#599) — polarity column + hit_type CHECK + round-trip
  // -------------------------------------------------------------------------

  it("defaults polarity to 'positive' for an existing-style import", async () => {
    await importFeedSnapshot(feedPool, {
      sourcePolicyId: "abuse.ch/feodo",
      entityType: "IP",
      hitType: "deterministic_ioc",
      rows: [{ matchValue: "45.66.230.5" }],
    });
    const { rows } = await feedPool.query<{
      polarity: string;
      hit_type: string;
    }>(
      `SELECT polarity, hit_type FROM ioc_feed_snapshot
        WHERE source_policy_id = 'abuse.ch/feodo'`,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].polarity).toBe("positive");
    expect(rows[0].hit_type).toBe("deterministic_ioc");
  });

  it("round-trips a negative import: polarity='negative', hit_type NULL, no match", async () => {
    // A negative (warninglist) import stamps every row negative with NULL
    // hit_type, regardless of any hitType passed.
    await importFeedSnapshot(feedPool, {
      sourcePolicyId: "misp/warninglists",
      entityType: "IP",
      polarity: "negative",
      classification: "public-dns",
      rows: [{ matchValue: "8.8.8.8" }],
    });
    const { rows } = await feedPool.query<{
      polarity: string;
      hit_type: string | null;
    }>(
      `SELECT polarity, hit_type FROM ioc_feed_snapshot
        WHERE source_policy_id = 'misp/warninglists'`,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].polarity).toBe("negative");
    expect(rows[0].hit_type).toBeNull();

    // `match` returns the row with hitType undefined (negative rows carry none).
    const store = new PgFeedStore(feedPool);
    const matches = await store.match(
      "misp/warninglists",
      normalizeIp("8.8.8.8"),
    );
    expect(matches).toHaveLength(1);
    expect(matches[0].hitType).toBeUndefined();
    expect(matches[0].classification).toBe("public-dns");
  });

  it("round-trips polarity through the shared RawFeedPayload import path", async () => {
    // The descriptor → catalog → RawFeedPayload → importRawFeedPayload path
    // that fixture / upload / self-fetch all converge on must mark rows
    // negative with NULL hit_type.
    await importRawFeedPayload(feedPool, {
      sourcePolicyId: "misp/warninglists",
      parse: "ip-blocklist",
      entityType: "IP",
      polarity: "negative",
      content: "8.8.4.4\n",
      provenance: { mode: "manual-upload", origin: "test" },
    });
    const { rows } = await feedPool.query<{
      polarity: string;
      hit_type: string | null;
      match_value: string;
    }>(
      `SELECT polarity, hit_type, match_value FROM ioc_feed_snapshot
        WHERE source_policy_id = 'misp/warninglists'`,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].polarity).toBe("negative");
    expect(rows[0].hit_type).toBeNull();
    expect(rows[0].match_value).toBe("8.8.4.4");
  });

  it("CHECK rejects a positive row with NULL hit_type", async () => {
    await expect(
      feedPool.query(
        `INSERT INTO ioc_feed_snapshot
           (source_policy_id, entity_type, match_value, hit_type, polarity)
         VALUES ('bad/pos', 'IP', '1.1.1.1', NULL, 'positive')`,
      ),
    ).rejects.toThrow();
  });

  it("CHECK rejects a negative row that carries a hit_type", async () => {
    await expect(
      feedPool.query(
        `INSERT INTO ioc_feed_snapshot
           (source_policy_id, entity_type, match_value, hit_type, polarity)
         VALUES ('bad/neg', 'IP', '1.1.1.1', 'deterministic_ioc', 'negative')`,
      ),
    ).rejects.toThrow();
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
