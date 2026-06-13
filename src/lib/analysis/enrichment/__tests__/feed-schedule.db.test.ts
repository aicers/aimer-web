// RFC 0003 self-fetch scheduler (3b, #570) — schedule storage DB tests.
//
// Exercises `setSelfFetchSchedule` / `readSelfFetchSchedule` against a real
// auth DB `system_settings` table: write → read round-trip, the
// disabled-by-default read for an unset key, defensive coercion of a malformed
// stored row, and that an audited write fires `auditLog`. The authorization
// check and audit sink are mocked so this test stays focused on the storage
// contract (route-level authz is covered by the route test).

import { join } from "node:path";
import type { Pool, PoolClient } from "pg";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

vi.mock("server-only", () => ({}));

const mockAuditLog = vi.fn();
vi.mock("@/lib/audit", () => ({
  auditLog: (...a: unknown[]) => mockAuditLog(...a),
}));
vi.mock("@/lib/auth/authorization", () => ({
  assertAuthorized: vi.fn(async () => new Set(["ti-feed:write"])),
}));

import {
  closeAdminPool,
  createTestDatabase,
  dropTestDatabase,
  hasPostgres,
} from "@/lib/db/__tests__/db-test-helpers";
import { runMigrations } from "@/lib/db/migrate";
import {
  readSelfFetchSchedule,
  setSelfFetchSchedule,
  TI_FEED_SCHEDULE_KEY,
} from "../feed-schedule";

const MIGRATIONS_DIR = join(process.cwd(), "migrations", "auth");
const LOCK_ID = 5701;
const ACCOUNT_ID = "00000000-0000-0000-0000-000000000099";

describe.skipIf(!hasPostgres)("self-fetch schedule storage (DB)", () => {
  let pool: Pool;
  let dbName: string;

  async function withClient<T>(fn: (c: PoolClient) => Promise<T>): Promise<T> {
    const client = await pool.connect();
    try {
      return await fn(client);
    } finally {
      client.release();
    }
  }

  beforeAll(async () => {
    const result = await createTestDatabase("self_fetch_schedule", "auth");
    pool = result.pool;
    dbName = result.dbName;
    await pool.query(`
      DO $$ BEGIN
        IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'aimer_auth') THEN
          CREATE ROLE aimer_auth LOGIN PASSWORD 'changeme';
        END IF;
      END $$
    `);
    await runMigrations(pool, MIGRATIONS_DIR, LOCK_ID);
  });

  afterAll(async () => {
    await dropTestDatabase(dbName, pool, "auth");
    await closeAdminPool();
  });

  beforeEach(async () => {
    vi.clearAllMocks();
    await pool.query(`DELETE FROM system_settings WHERE key = $1`, [
      TI_FEED_SCHEDULE_KEY,
    ]);
  });

  it("reads disabled when the key is unset", async () => {
    expect(await readSelfFetchSchedule(pool)).toEqual({ enabled: false });
  });

  it("round-trips a write through system_settings + audits it", async () => {
    const saved = await withClient((c) =>
      setSelfFetchSchedule(c, ACCOUNT_ID, {
        enabled: true,
        intervalMs: 600000,
      }),
    );
    expect(saved).toEqual({ enabled: true, intervalMs: 600000 });
    expect(await readSelfFetchSchedule(pool)).toEqual({
      enabled: true,
      intervalMs: 600000,
    });
    expect(mockAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({
        actorId: ACCOUNT_ID,
        action: "system.ti_feed_self_fetch_schedule_updated",
        targetType: "system_settings",
        targetId: TI_FEED_SCHEDULE_KEY,
      }),
    );
  });

  it("overwrites a prior schedule (enabled → disabled)", async () => {
    await withClient((c) =>
      setSelfFetchSchedule(c, ACCOUNT_ID, { enabled: true, intervalMs: 60000 }),
    );
    await withClient((c) =>
      setSelfFetchSchedule(c, ACCOUNT_ID, { enabled: false }),
    );
    expect(await readSelfFetchSchedule(pool)).toEqual({ enabled: false });
  });

  it("defensively coerces a malformed stored row to disabled", async () => {
    await pool.query(
      `INSERT INTO system_settings (key, value, updated_at)
       VALUES ($1, $2::jsonb, NOW())
       ON CONFLICT (key) DO UPDATE SET value = $2::jsonb`,
      [TI_FEED_SCHEDULE_KEY, JSON.stringify({ enabled: "nope" })],
    );
    expect(await readSelfFetchSchedule(pool)).toEqual({ enabled: false });
  });
});
