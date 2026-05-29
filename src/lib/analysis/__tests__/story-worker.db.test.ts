// Issue #343 — canonical story version tie-break DB test.
//
// `loadCanonicalMembers` must resolve the canonical story version with
// the same compound key the rest of the pipeline uses
// (`received_at DESC, story_version DESC`, documented at
// reconcile.ts:569). `story.received_at` defaults to NOW(), which
// Postgres fixes to the transaction start time, so two
// `(story_id, story_version)` rows inserted in a single transaction tie
// on `received_at` by construction. This test pins that tie and asserts
// the worker picks the lexicographically greater `story_version` — the
// same row reconcile / ingest-hooks would treat as canonical. A mocked
// pool cannot prove this; only a real Postgres round-trip exercises the
// SQL `ORDER BY`.
//
// Why the seq-scan pool: with the default planner the `story` primary
// key `(story_id, story_version)` is the only usable index, so Postgres
// reads rows already ordered by `story_version` and the tie resolves to
// the highest version *by coincidence* — `received_at DESC` alone and
// the compound key return the same row, so the test could not tell the
// fix from the bug. That PK-ordering coincidence is exactly the masking
// the issue calls out. Disabling index scans forces a heap scan in
// insertion order; inserting the LOWER version first then makes the
// `received_at`-only query surface the wrong row, so only the
// `story_version DESC` tie-break yields the canonical version. The test
// therefore fails against the pre-fix `ORDER BY received_at DESC` and
// passes against the compound key.

import { join } from "node:path";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  closeAdminPool,
  createTestDatabase,
  dropTestDatabase,
  hasPostgres,
} from "@/lib/db/__tests__/db-test-helpers";
import { runMigrations } from "@/lib/db/migrate";

vi.mock("server-only", () => ({}));

const { __testables } = await import("../story-worker");
const { loadCanonicalMembers } = __testables;

const CUSTOMER_MIGRATIONS_DIR = join(process.cwd(), "migrations", "customer");
const CUSTOMER_LOCK_ID = 2103;

describe.skipIf(!hasPostgres)(
  "loadCanonicalMembers canonical tie-break",
  () => {
    let customerDbName: string;
    let customerPool: Pool;
    // A pool with index/bitmap scans disabled so the planner cannot lean
    // on the `(story_id, story_version)` primary key to pre-order rows.
    // See the file header for why this is required to actually exercise
    // the `story_version DESC` tie-break.
    let seqScanPool: Pool;

    beforeAll(async () => {
      const cust = await createTestDatabase("analysis_story_worker_cust");
      customerDbName = cust.dbName;
      customerPool = cust.pool;
      await runMigrations(
        customerPool,
        CUSTOMER_MIGRATIONS_DIR,
        CUSTOMER_LOCK_ID,
      );
      seqScanPool = new Pool({
        connectionString: cust.url,
        options:
          "-c enable_indexscan=off -c enable_bitmapscan=off -c enable_indexonlyscan=off",
      });
    });

    afterAll(async () => {
      await seqScanPool.end();
      await dropTestDatabase(customerDbName, customerPool);
      await closeAdminPool();
    });

    it("returns the highest story_version when received_at ties within one transaction", async () => {
      const storyId = "424242";
      // Insert two versions for the same story_id inside ONE transaction.
      // Postgres now() (the received_at default) returns the transaction
      // start time and is fixed for the whole transaction, so both rows
      // share an identical received_at — a guaranteed tie, not a race.
      // The LOWER version (v1) is inserted FIRST so that under the
      // forced heap scan the `received_at`-only ordering would surface v1
      // (the wrong row); only the `story_version DESC` tie-break promotes
      // v2.
      const client = await customerPool.connect();
      try {
        await client.query("BEGIN");
        for (const version of ["v1", "v2"]) {
          await client.query(
            `INSERT INTO story
             (story_id, story_version, kind,
              time_window_start, time_window_end,
              summary_payload, known_ioc_hit, source_aice_id)
           VALUES ($1::bigint, $2, 'auto_correlated',
                   '2026-05-26T10:00:00Z'::timestamptz,
                   '2026-05-26T10:05:00Z'::timestamptz,
                   '{}'::jsonb, $3, 'aice-1')`,
            [storyId, version, version === "v2"],
          );
          await client.query(
            `INSERT INTO story_member
             (story_id, story_version, member_event_key, role, event)
           VALUES ($1::bigint, $2, $3::numeric, 'primary', $4::jsonb)`,
            [storyId, version, version === "v2" ? "2002" : "1001", "{}"],
          );
        }
        await client.query("COMMIT");
      } catch (err) {
        await client.query("ROLLBACK");
        throw err;
      } finally {
        client.release();
      }

      // Both versions must share the same received_at (the tie premise).
      const { rows: receivedAt } = await customerPool.query<{
        distinct: string;
      }>(
        `SELECT COUNT(DISTINCT received_at)::text AS distinct
         FROM story WHERE story_id = $1::bigint`,
        [storyId],
      );
      expect(receivedAt[0].distinct).toBe("1");

      const canonical = await loadCanonicalMembers(seqScanPool, storyId);
      expect(canonical).not.toBeNull();
      // Lexicographically greater version wins the tie — matches the
      // reconcile / ingest-hooks convention.
      expect(canonical?.storyVersion).toBe("v2");
      expect(canonical?.knownIocHit).toBe(true);
      // Members returned belong to the canonical version only.
      expect(canonical?.members.map((m) => m.member_event_key)).toEqual([
        "2002",
      ]);
    });
  },
);
