import { join } from "node:path";
import type { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  closeAdminPool,
  createTestDatabase,
  dropTestDatabase,
  hasPostgres,
} from "@/lib/db/__tests__/db-test-helpers";
import { runMigrations } from "@/lib/db/migrate";
import { consumePhase2Jti } from "../jti-replay";

const AUTH_MIGRATIONS_DIR = join(process.cwd(), "migrations", "auth");
const LOCK_ID_AUTH = 1000;

describe.skipIf(!hasPostgres)("consumePhase2Jti", () => {
  let dbName: string;
  let pool: Pool;

  beforeAll(async () => {
    const db = await createTestDatabase("phase2_jti");
    dbName = db.dbName;
    pool = db.pool;
    await runMigrations(pool, AUTH_MIGRATIONS_DIR, LOCK_ID_AUTH);
  });

  afterAll(async () => {
    await dropTestDatabase(dbName, pool);
    await closeAdminPool();
  });

  it("inserts the jti on first call and rejects the second", async () => {
    const jti = "550e8400-e29b-41d4-a716-446655440000";
    const first = await consumePhase2Jti(pool, jti);
    expect(first).toBe("consumed");
    const second = await consumePhase2Jti(pool, jti);
    expect(second).toBe("replay");
  });

  it("treats distinct jtis independently", async () => {
    const a = await consumePhase2Jti(pool, "jti-A");
    const b = await consumePhase2Jti(pool, "jti-B");
    expect(a).toBe("consumed");
    expect(b).toBe("consumed");
  });

  it("ships an index on consumed_at for the retention sweep", async () => {
    const { rows } = await pool.query(
      "SELECT indexname FROM pg_indexes WHERE tablename = 'phase2_consumed_jtis' ORDER BY indexname",
    );
    const names = rows.map((r) => r.indexname);
    expect(names).toContain("phase2_consumed_jtis_consumed_at_idx");
  });
});
