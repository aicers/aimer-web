import { join } from "node:path";
import type { Pool, PoolClient } from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  closeAdminPool,
  createTestDatabase,
  dropTestDatabase,
  hasPostgres,
} from "@/lib/db/__tests__/db-test-helpers";
import { withTransaction } from "@/lib/db/client";
import { runMigrations } from "@/lib/db/migrate";

vi.mock("server-only", () => ({}));

// Bypass OpenBao Transit — round-trip the map as plaintext JSON so the
// DB primitive can be exercised without a running Transit instance.
vi.mock("@/lib/redaction/envelope-adapter", () => ({
  encryptRedactionMap: async (_customerId: string, map: unknown) => ({
    ciphertext: Buffer.from(JSON.stringify(map), "utf8"),
    wrappedDek: "test-wrap",
  }),
  decryptRedactionMap: async (_customerId: string, ciphertext: Buffer) =>
    JSON.parse(ciphertext.toString("utf8")),
}));

const { readMapWithLock, writeMap } = await import("../map-write");

const CUSTOMER_MIGRATIONS_DIR = join(process.cwd(), "migrations", "customer");
const LOCK_ID_CUSTOMER = 1002;

const CUSTOMER_ID = "11111111-2222-3333-4444-555555555555";
const AICE_ID = "aice-map-write";

describe.skipIf(!hasPostgres)("readMapWithLock / writeMap", () => {
  let dbName: string;
  let pool: Pool;

  beforeAll(async () => {
    const db = await createTestDatabase("map_write");
    dbName = db.dbName;
    pool = db.pool;
    await runMigrations(pool, CUSTOMER_MIGRATIONS_DIR, LOCK_ID_CUSTOMER);
  });

  afterAll(async () => {
    await dropTestDatabase(dbName, pool);
    await closeAdminPool();
  });

  it("returns null when no row exists yet for (aice_id, event_key)", async () => {
    await withTransaction(pool, async (client) => {
      const existing = await readMapWithLock(
        client as unknown as PoolClient,
        CUSTOMER_ID,
        AICE_ID,
        "100",
      );
      expect(existing).toBeNull();
    });
  });

  it("writeMap UPSERTs and a subsequent readMapWithLock returns the same map", async () => {
    const map = {
      "<<REDACTED_IP_001>>": { kind: "ip" as const, value: "10.0.0.1" },
    };
    await withTransaction(pool, async (client) => {
      await readMapWithLock(
        client as unknown as PoolClient,
        CUSTOMER_ID,
        AICE_ID,
        "200",
      );
      await writeMap(
        client as unknown as PoolClient,
        CUSTOMER_ID,
        AICE_ID,
        "200",
        map,
      );
    });

    await withTransaction(pool, async (client) => {
      const reread = await readMapWithLock(
        client as unknown as PoolClient,
        CUSTOMER_ID,
        AICE_ID,
        "200",
      );
      expect(reread).toEqual(map);
    });
  });

  it("repeat writeMap with same content within one transaction is idempotent on row content", async () => {
    const map = {
      "<<REDACTED_EMAIL_001>>": { kind: "email" as const, value: "a@b.c" },
    };

    await withTransaction(pool, async (client) => {
      await readMapWithLock(
        client as unknown as PoolClient,
        CUSTOMER_ID,
        AICE_ID,
        "300",
      );
      await writeMap(
        client as unknown as PoolClient,
        CUSTOMER_ID,
        AICE_ID,
        "300",
        map,
      );
      await writeMap(
        client as unknown as PoolClient,
        CUSTOMER_ID,
        AICE_ID,
        "300",
        map,
      );
    });

    const { rows } = await pool.query<{ ciphertext: Buffer }>(
      `SELECT ciphertext FROM event_redaction_map
       WHERE aice_id = $1 AND event_key = $2::numeric`,
      [AICE_ID, "300"],
    );
    expect(rows).toHaveLength(1);
    expect(JSON.parse(rows[0].ciphertext.toString("utf8"))).toEqual(map);
  });

  it("two concurrent transactions for the same (aice_id, event_key) serialise on the advisory lock", async () => {
    // T1 acquires the lock, holds the transaction open, T2 must wait
    // until T1 commits before its readMapWithLock returns.
    let t1Committed = false;
    const t1Done = (async () => {
      await withTransaction(pool, async (client) => {
        await readMapWithLock(
          client as unknown as PoolClient,
          CUSTOMER_ID,
          AICE_ID,
          "400",
        );
        await writeMap(
          client as unknown as PoolClient,
          CUSTOMER_ID,
          AICE_ID,
          "400",
          {
            "<<REDACTED_IP_001>>": { kind: "ip", value: "10.0.0.1" },
          },
        );
        // Hold the transaction open long enough that T2 has definitely
        // queued behind the advisory lock.
        await new Promise((resolve) => setTimeout(resolve, 150));
        t1Committed = true;
      });
    })();

    // Give T1 a head start to acquire the lock before T2 starts.
    await new Promise((resolve) => setTimeout(resolve, 25));

    let observedT1Committed = false;
    const t2Done = (async () => {
      await withTransaction(pool, async (client) => {
        const existing = await readMapWithLock(
          client as unknown as PoolClient,
          CUSTOMER_ID,
          AICE_ID,
          "400",
        );
        // If serialisation works, by the time readMapWithLock returns
        // T1 has committed and the existing map reflects T1's write.
        observedT1Committed = t1Committed;
        expect(existing).toEqual({
          "<<REDACTED_IP_001>>": { kind: "ip", value: "10.0.0.1" },
        });
      });
    })();

    await Promise.all([t1Done, t2Done]);
    expect(observedT1Committed).toBe(true);
  });
});
