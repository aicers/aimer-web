// RFC 0003 Tier-1 feed-refresh (#566) — manual-upload import DB tests.
//
// Exercises the manual-upload path against a real feed DB (ioc_feed_snapshot):
//   - an uploaded payload imports the expected rows for its source,
//   - a second upload REPLACES (not appends) the source's snapshot,
//   - other sources are untouched,
//   - two concurrent same-source uploads serialize (the source-scoped
//     advisory lock holds the replace-not-append guarantee — no duplicates).

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
import { importRawFeedPayload } from "../feed-import";
import { buildManualUploadPayload } from "../feed-upload";

const FEED_MIGRATIONS_DIR = join(process.cwd(), "migrations", "feed");
const FEED_LOCK_ID = 2611;

const UPLOADED_AT = "2026-06-12T00:00:00.000Z";

async function upload(
  pool: Pool,
  sourcePolicyId: string,
  filename: string,
  content: string,
) {
  return importRawFeedPayload(
    pool,
    buildManualUploadPayload({
      sourcePolicyId,
      filename,
      content,
      uploadedAt: UPLOADED_AT,
    }),
  );
}

async function rowsFor(pool: Pool, sourcePolicyId: string): Promise<string[]> {
  const { rows } = await pool.query<{ match_value: string | null }>(
    `SELECT match_value FROM ioc_feed_snapshot
      WHERE source_policy_id = $1 ORDER BY match_value`,
    [sourcePolicyId],
  );
  return rows.map((r) => r.match_value ?? "");
}

describe.skipIf(!hasPostgres)("manual-upload feed import (DB)", () => {
  let feedDbName: string;
  let feedPool: Pool;

  beforeEach(async () => {
    if (feedPool) {
      await dropTestDatabase(feedDbName, feedPool, "feed");
    }
    const feed = await createTestDatabase("ti_feed_upload", "feed");
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

  it("imports the expected rows for an uploaded source", async () => {
    const result = await upload(
      feedPool,
      "abuse.ch/feodo",
      "feodo.txt",
      "45.66.230.5\n198.51.100.7\n",
    );
    expect(result.rowCount).toBe(2);
    expect(await rowsFor(feedPool, "abuse.ch/feodo")).toEqual([
      "198.51.100.7",
      "45.66.230.5",
    ]);
  });

  it("a second upload replaces (not appends) the source snapshot", async () => {
    await upload(
      feedPool,
      "abuse.ch/feodo",
      "feodo.txt",
      "45.66.230.5\n198.51.100.7\n",
    );
    await upload(feedPool, "abuse.ch/feodo", "feodo.txt", "203.0.113.9\n");

    expect(await rowsFor(feedPool, "abuse.ch/feodo")).toEqual(["203.0.113.9"]);
  });

  it("leaves other sources untouched", async () => {
    await upload(feedPool, "abuse.ch/feodo", "feodo.txt", "45.66.230.5\n");
    await upload(
      feedPool,
      "spamhaus/drop",
      "drop.txt",
      "203.0.113.0/24 ; SBL123\n",
    );

    // Re-uploading feodo must not affect spamhaus/drop rows.
    await upload(feedPool, "abuse.ch/feodo", "feodo.txt", "198.51.100.7\n");

    expect(await rowsFor(feedPool, "abuse.ch/feodo")).toEqual(["198.51.100.7"]);
    const { rows } = await feedPool.query<{ cidr: string }>(
      `SELECT cidr::text AS cidr FROM ioc_feed_snapshot
        WHERE source_policy_id = 'spamhaus/drop'`,
    );
    expect(rows.map((r) => r.cidr)).toEqual(["203.0.113.0/24"]);
  });

  it("serializes two concurrent same-source uploads (replace-not-append)", async () => {
    await Promise.all([
      upload(
        feedPool,
        "abuse.ch/feodo",
        "a.txt",
        "45.66.230.5\n198.51.100.7\n",
      ),
      upload(
        feedPool,
        "abuse.ch/feodo",
        "b.txt",
        "45.66.230.5\n198.51.100.7\n203.0.113.9\n",
      ),
    ]);

    const values = await rowsFor(feedPool, "abuse.ch/feodo");
    // The later commit fully replaced the earlier one: the result is exactly
    // ONE of the two uploads (2 or 3 rows), never their union (5) and never
    // with duplicates.
    expect([2, 3]).toContain(values.length);
    expect(new Set(values).size).toBe(values.length);
  });
});
