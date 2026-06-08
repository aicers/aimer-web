// #493 — per-customer baseline auto-analysis daily cap resolver.
//
// Mirrors `default-model.db.test.ts`: the three-tier resolution order
// (customer override → admin global → env), defensive coercion, and the
// `0` = tier-B-disabled semantics.

import { join } from "node:path";
import type { Pool } from "pg";
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from "vitest";

vi.mock("server-only", () => ({}));

import {
  closeAdminPool,
  createTestDatabase,
  dropTestDatabase,
  hasPostgres,
} from "@/lib/db/__tests__/db-test-helpers";
import { runMigrations } from "@/lib/db/migrate";
import {
  GLOBAL_BASELINE_CAP_KEY,
  resolveBaselineDailyCap,
} from "../baseline-daily-cap";

const AUTH_MIGRATIONS_DIR = join(process.cwd(), "migrations", "auth");
const AUTH_LOCK_ID = 2631;
const CUSTOMER_ID = "00000000-0000-0000-0000-0000000004c1";
const ACTOR = "00000000-0000-0000-0000-0000000004c2";

describe.skipIf(!hasPostgres)("resolveBaselineDailyCap (three-tier)", () => {
  let dbName: string;
  let pool: Pool;
  const prevEnv = process.env.BASELINE_AUTO_ANALYSIS_DAILY_CAP;

  beforeAll(async () => {
    const db = await createTestDatabase("baseline_cap_auth");
    dbName = db.dbName;
    pool = db.pool;
    await runMigrations(pool, AUTH_MIGRATIONS_DIR, AUTH_LOCK_ID);
    await pool.query(
      `INSERT INTO customers (id, external_key, name, database_status, timezone)
       VALUES ($1, 'baseline-cap', 'Cap Co', 'active', 'Asia/Seoul')`,
      [CUSTOMER_ID],
    );
  }, 60_000);

  afterAll(async () => {
    await dropTestDatabase(dbName, pool);
    await closeAdminPool();
  }, 30_000);

  afterEach(async () => {
    await pool.query("DELETE FROM customer_baseline_analysis_cap");
    await pool.query("DELETE FROM system_settings WHERE key = $1", [
      GLOBAL_BASELINE_CAP_KEY,
    ]);
    if (prevEnv === undefined)
      delete process.env.BASELINE_AUTO_ANALYSIS_DAILY_CAP;
    else process.env.BASELINE_AUTO_ANALYSIS_DAILY_CAP = prevEnv;
  });

  it("falls back to env (default 0) when nothing is configured", async () => {
    delete process.env.BASELINE_AUTO_ANALYSIS_DAILY_CAP;
    expect(await resolveBaselineDailyCap(CUSTOMER_ID, pool)).toBe(0);
    process.env.BASELINE_AUTO_ANALYSIS_DAILY_CAP = "7";
    expect(await resolveBaselineDailyCap(CUSTOMER_ID, pool)).toBe(7);
  });

  it("admin global overrides env", async () => {
    process.env.BASELINE_AUTO_ANALYSIS_DAILY_CAP = "7";
    await pool.query(
      `INSERT INTO system_settings (key, value, updated_at)
       VALUES ($1, '12'::jsonb, NOW())`,
      [GLOBAL_BASELINE_CAP_KEY],
    );
    expect(await resolveBaselineDailyCap(CUSTOMER_ID, pool)).toBe(12);
  });

  it("per-customer override wins over global + env", async () => {
    process.env.BASELINE_AUTO_ANALYSIS_DAILY_CAP = "7";
    await pool.query(
      `INSERT INTO system_settings (key, value, updated_at)
       VALUES ($1, '12'::jsonb, NOW())`,
      [GLOBAL_BASELINE_CAP_KEY],
    );
    await pool.query(
      `INSERT INTO customer_baseline_analysis_cap
         (customer_id, daily_cap, updated_by)
       VALUES ($1, 3, $2)`,
      [CUSTOMER_ID, ACTOR],
    );
    expect(await resolveBaselineDailyCap(CUSTOMER_ID, pool)).toBe(3);
  });

  it("a per-customer cap of 0 (tier B disabled) is honored, not treated as unset", async () => {
    process.env.BASELINE_AUTO_ANALYSIS_DAILY_CAP = "7";
    await pool.query(
      `INSERT INTO customer_baseline_analysis_cap
         (customer_id, daily_cap, updated_by)
       VALUES ($1, 0, $2)`,
      [CUSTOMER_ID, ACTOR],
    );
    expect(await resolveBaselineDailyCap(CUSTOMER_ID, pool)).toBe(0);
  });

  it("a malformed global value falls through to env", async () => {
    process.env.BASELINE_AUTO_ANALYSIS_DAILY_CAP = "7";
    await pool.query(
      `INSERT INTO system_settings (key, value, updated_at)
       VALUES ($1, '"not-a-number"'::jsonb, NOW())`,
      [GLOBAL_BASELINE_CAP_KEY],
    );
    expect(await resolveBaselineDailyCap(CUSTOMER_ID, pool)).toBe(7);
  });
});
