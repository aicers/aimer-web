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
import { countAccessibleCustomers } from "../account";

// ---------------------------------------------------------------------------
// DB-backed integration tests for src/lib/auth/account.ts (#266).
//
// Unlike auth-flow.db.test.ts (which clones a pre-migrated template1 and is
// gated on DATABASE_ADMIN_URL, so it does NOT run in CI), this suite uses the
// shared `hasPostgres` gate and migrates its own fresh database — the same
// pattern as schema.db.test.ts — so the sign-in qualification gate is
// exercised in CI, not just locally.
// ---------------------------------------------------------------------------

const MIGRATIONS_DIR = join(process.cwd(), "migrations", "auth");
const LOCK_ID = 1050;

describe.skipIf(!hasPostgres)("countAccessibleCustomers (DB)", () => {
  let pool: Pool;
  let dbName: string;

  beforeAll(async () => {
    const result = await createTestDatabase("account", "auth");
    pool = result.pool;
    dbName = result.dbName;
    await runMigrations(pool, MIGRATIONS_DIR, LOCK_ID);
  });

  afterAll(async () => {
    await dropTestDatabase(dbName, pool, "auth");
    await closeAdminPool();
  });

  it("does not count analyst assignments when analyst_eligible = false (#266)", async () => {
    // A stale analyst_customer_assignments row must not qualify an account
    // for sign-in once its analyst eligibility is revoked.
    const cust = await pool.query<{ id: string }>(
      `INSERT INTO customers (external_key, name) VALUES ('cust-analyst-gate', 'Analyst Gate') RETURNING id`,
    );
    const customerId = cust.rows[0].id;
    const acct = await pool.query<{ id: string }>(
      `INSERT INTO accounts (oidc_issuer, oidc_subject, username, display_name, analyst_eligible)
       VALUES ('test-issuer', 'analyst-gate-user', 'agate', 'Analyst Gate', false)
       RETURNING id`,
    );
    const analystId = acct.rows[0].id;

    await pool.query(
      `INSERT INTO analyst_customer_assignments (account_id, customer_id, assigned_by)
       VALUES ($1, $2, $1)`,
      [analystId, customerId],
    );

    // Stale assignment + analyst_eligible = false → still denied.
    expect(await countAccessibleCustomers(pool, analystId)).toBe(0);

    // Flip eligibility on → the same assignment now qualifies.
    await pool.query(
      `UPDATE accounts SET analyst_eligible = true WHERE id = $1`,
      [analystId],
    );
    expect(await countAccessibleCustomers(pool, analystId)).toBe(1);
  });

  it("counts direct memberships regardless of analyst eligibility", async () => {
    // A plain member (no analyst eligibility) is still counted via the
    // membership branch, confirming the analyst gate does not over-restrict.
    const cust = await pool.query<{ id: string }>(
      `INSERT INTO customers (external_key, name) VALUES ('cust-member-only', 'Member Only') RETURNING id`,
    );
    const customerId = cust.rows[0].id;
    const acct = await pool.query<{ id: string }>(
      `INSERT INTO accounts (oidc_issuer, oidc_subject, username, display_name, analyst_eligible)
       VALUES ('test-issuer', 'member-only-user', 'memb', 'Member Only', false)
       RETURNING id`,
    );
    const memberId = acct.rows[0].id;
    const role = await pool.query<{ id: string }>(
      `SELECT id FROM roles WHERE name = 'User' AND auth_context = 'general' LIMIT 1`,
    );

    await pool.query(
      `INSERT INTO account_customer_memberships (account_id, customer_id, role_id)
       VALUES ($1, $2, $3)`,
      [memberId, customerId, role.rows[0].id],
    );

    expect(await countAccessibleCustomers(pool, memberId)).toBe(1);
  });
});
