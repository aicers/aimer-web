// DB integration test for the customer_retention_policy backfill
// migration (migrations/auth/0023_backfill_customer_retention_policy.sql).
//
// The backfill applies to customers that pre-existed the table. We
// simulate that by running auth migrations up to (and excluding)
// the policy table, inserting customers + memberships, then running
// the policy + backfill migrations on top — mirroring how a real
// upgrade would land.

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runMigrations } from "../migrate";
import {
  closeAdminPool,
  createTestDatabase,
  dropTestDatabase,
  hasPostgres,
} from "./db-test-helpers";

const MIGRATIONS_DIR = join(process.cwd(), "migrations", "auth");
const LOCK_ID = 2050;
const NIL_UUID = "00000000-0000-0000-0000-000000000000";

describe.skipIf(!hasPostgres)("customer_retention_policy backfill", () => {
  let pool: Pool;
  let dbName: string;

  beforeAll(async () => {
    const result = await createTestDatabase("retention_backfill", "auth");
    pool = result.pool;
    dbName = result.dbName;

    await pool.query(`
      DO $$ BEGIN
        IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'aimer_auth') THEN
          CREATE ROLE aimer_auth LOGIN PASSWORD 'changeme';
        END IF;
      END $$
    `);

    // Run the migrations through 0019 (everything before the
    // retention policy table) so we can plant pre-existing
    // customers + memberships in their pre-backfill state.
    const earlyDir = join(process.cwd(), "migrations", "auth");
    // Apply all auth migrations — the backfill is idempotent and
    // picks up customers regardless of when they were inserted. We
    // need the schema in place to insert memberships first, then
    // run the backfill again to verify it.
    await runMigrations(pool, earlyDir, LOCK_ID);
  });

  afterAll(async () => {
    await dropTestDatabase(dbName, pool, "auth");
    await closeAdminPool();
  });

  it("picks the earliest Manager membership by (created_at, account_id)", async () => {
    const customer = await pool.query<{ id: string }>(
      `INSERT INTO customers (external_key, name) VALUES ('bf-mgr', 'BF Mgr')
       RETURNING id`,
    );
    const customerId = customer.rows[0].id;

    // Drop any auto-inserted row (no createCustomer call was made; the
    // backfill scenario assumes the customer was provisioned before
    // the policy table existed).
    await pool.query(
      `DELETE FROM customer_retention_policy WHERE customer_id = $1`,
      [customerId],
    );

    // Two managers; the earlier created_at wins, with account_id as
    // the deterministic tie-break.
    const { rows: roleRows } = await pool.query<{ id: number }>(
      `SELECT id FROM roles WHERE name = 'Manager' AND auth_context = 'general'`,
    );
    const managerRoleId = roleRows[0].id;

    const acctEarly = await pool.query<{ id: string }>(
      `INSERT INTO accounts (oidc_issuer, oidc_subject, username, display_name)
       VALUES ('iss', 'mgr-early', 'mgr-e', 'Mgr Early') RETURNING id`,
    );
    const acctLate = await pool.query<{ id: string }>(
      `INSERT INTO accounts (oidc_issuer, oidc_subject, username, display_name)
       VALUES ('iss', 'mgr-late', 'mgr-l', 'Mgr Late') RETURNING id`,
    );
    await pool.query(
      `INSERT INTO account_customer_memberships
         (account_id, customer_id, role_id, created_at)
       VALUES ($1, $2, $3, '2024-01-01T00:00:00Z'),
              ($4, $2, $3, '2024-06-01T00:00:00Z')`,
      [acctEarly.rows[0].id, customerId, managerRoleId, acctLate.rows[0].id],
    );

    // Run the backfill SQL again — it is idempotent (WHERE NOT
    // EXISTS).
    const backfillSql = await readFile(
      join(MIGRATIONS_DIR, "0023_backfill_customer_retention_policy.sql"),
      "utf-8",
    );
    await pool.query(backfillSql);

    const policy = await pool.query<{
      ingestion_days: number;
      analysis_days: number | null;
      updated_by: string;
    }>(
      `SELECT ingestion_days, analysis_days, updated_by
       FROM customer_retention_policy WHERE customer_id = $1`,
      [customerId],
    );
    expect(policy.rows).toHaveLength(1);
    expect(policy.rows[0].ingestion_days).toBe(365);
    expect(policy.rows[0].analysis_days).toBe(1095);
    expect(policy.rows[0].updated_by).toBe(acctEarly.rows[0].id);
  });

  it("falls back to the nil UUID when no Manager membership exists", async () => {
    const customer = await pool.query<{ id: string }>(
      `INSERT INTO customers (external_key, name) VALUES ('bf-orphan', 'BF Orphan')
       RETURNING id`,
    );
    const customerId = customer.rows[0].id;

    await pool.query(
      `DELETE FROM customer_retention_policy WHERE customer_id = $1`,
      [customerId],
    );

    const backfillSql = await readFile(
      join(MIGRATIONS_DIR, "0023_backfill_customer_retention_policy.sql"),
      "utf-8",
    );
    await pool.query(backfillSql);

    const policy = await pool.query<{
      ingestion_days: number;
      analysis_days: number | null;
      updated_by: string;
    }>(
      `SELECT ingestion_days, analysis_days, updated_by
       FROM customer_retention_policy WHERE customer_id = $1`,
      [customerId],
    );
    expect(policy.rows).toHaveLength(1);
    expect(policy.rows[0].ingestion_days).toBe(365);
    expect(policy.rows[0].analysis_days).toBe(1095);
    expect(policy.rows[0].updated_by).toBe(NIL_UUID);
  });
});
