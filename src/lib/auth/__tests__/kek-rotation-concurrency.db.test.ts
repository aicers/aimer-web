// DB integration test for the rotation-vs-ingestion race window in
// `rewrapCustomerEvents`. Documented in RFC 0001 §"KEK rotation
// handoff": rotation must hold FOR UPDATE inside a per-batch
// transaction so a concurrent ingestion UPSERT against a row the
// cursor has already returned waits for the rewrap to commit.

import { join } from "node:path";
import { Client, type Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  closeAdminPool,
  createTestDatabase,
  dropTestDatabase,
  hasPostgres,
} from "../../db/__tests__/db-test-helpers";
import { runMigrations } from "../../db/migrate";

const CUSTOMER_MIGRATIONS_DIR = join(process.cwd(), "migrations", "customer");
const LOCK_ID = 1080;

describe.skipIf(!hasPostgres)("rewrap concurrency vs ingestion UPSERT", () => {
  let pool: Pool;
  let dbName: string;
  let url: string;

  beforeAll(async () => {
    const result = await createTestDatabase("rewrap_concurrency");
    pool = result.pool;
    dbName = result.dbName;
    url = result.url;

    await runMigrations(pool, CUSTOMER_MIGRATIONS_DIR, LOCK_ID);

    await pool.query(
      `INSERT INTO event_redaction_map (aice_id, event_key, ciphertext, wrapped_dek)
       VALUES ('aice-x', 1, decode('00', 'hex'), 'wrap-v1')`,
    );
  });

  afterAll(async () => {
    await dropTestDatabase(dbName, pool);
    await closeAdminPool();
  });

  it("blocks ingestion UPSERT until the rotation's batch commits", async () => {
    // Simulator A: rotation holding FOR UPDATE on the row.
    const rotation = new Client({ connectionString: url });
    await rotation.connect();
    await rotation.query("BEGIN");
    await rotation.query(
      `SELECT aice_id, event_key, wrapped_dek
       FROM event_redaction_map
       WHERE aice_id = 'aice-x' AND event_key = 1
       FOR UPDATE`,
    );

    // Simulator B: ingestion trying to UPSERT the same row.
    const ingest = new Client({ connectionString: url });
    await ingest.connect();
    let ingestionResolved = false;
    const ingestionPromise = ingest
      .query(
        `INSERT INTO event_redaction_map (aice_id, event_key, ciphertext, wrapped_dek)
         VALUES ('aice-x', 1, decode('11', 'hex'), 'wrap-from-ingest')
         ON CONFLICT (aice_id, event_key)
         DO UPDATE SET ciphertext = EXCLUDED.ciphertext,
                       wrapped_dek = EXCLUDED.wrapped_dek,
                       updated_at = NOW()`,
      )
      .then(() => {
        ingestionResolved = true;
      });

    // Give the second client a moment to hit the lock.
    await new Promise((r) => setTimeout(r, 150));
    expect(ingestionResolved).toBe(false);

    // Rotation rewraps and commits.
    await rotation.query(
      `UPDATE event_redaction_map SET wrapped_dek = 'wrap-v2'
       WHERE aice_id = 'aice-x' AND event_key = 1`,
    );
    await rotation.query("COMMIT");

    await ingestionPromise;
    expect(ingestionResolved).toBe(true);

    // Ingestion's UPSERT is the most recent writer, so the row
    // reflects its content (ciphertext + wrapped_dek match the
    // UPSERT). The key property is that the pair is consistent —
    // no torn write where ciphertext is the new DEK's output but
    // wrapped_dek still points at the old DEK.
    const { rows } = await pool.query<{
      ciphertext: Buffer;
      wrapped_dek: string;
    }>(
      `SELECT ciphertext, wrapped_dek FROM event_redaction_map
       WHERE aice_id = 'aice-x' AND event_key = 1`,
    );
    expect(rows[0].wrapped_dek).toBe("wrap-from-ingest");
    expect(rows[0].ciphertext.toString("hex")).toBe("11");

    await rotation.end();
    await ingest.end();
  });
});
