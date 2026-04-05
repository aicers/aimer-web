import { randomUUID } from "node:crypto";
import { join } from "node:path";
import type { Pool } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  closeAdminPool,
  createTestDatabase,
  dropTestDatabase,
  hasPostgres,
} from "@/lib/db/__tests__/db-test-helpers";
import { withTransaction } from "@/lib/db/client";
import { runMigrations } from "@/lib/db/migrate";

// ---------------------------------------------------------------------------
// DB-backed integration tests for the 3-admin concurrent cap.
//
// Covers verification items from Discussion #9:
//   - 39-1: 3-person limit
//   - 39-2: 3-person limit concurrency
//
// These tests use a real PostgreSQL database to verify that the advisory
// lock serializes designation requests and prevents exceeding the cap.
// ---------------------------------------------------------------------------

const MIGRATIONS_DIR = join(process.cwd(), "migrations", "auth");
const LOCK_ID = 1040;
const MAX_ADMINS = 3;
const ADMIN_DESIGNATION_LOCK_ID = 1100;

describe.skipIf(!hasPostgres)("admin designation concurrent cap (DB)", () => {
  let pool: Pool;
  let dbName: string;
  const accountIds: string[] = [];

  beforeAll(async () => {
    const result = await createTestDatabase("admincap", "auth");
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

  beforeEach(async () => {
    // Clean up any previously created test accounts
    if (accountIds.length > 0) {
      await pool.query(`DELETE FROM sessions WHERE account_id = ANY($1)`, [
        accountIds,
      ]);
      await pool.query(`DELETE FROM accounts WHERE id = ANY($1)`, [accountIds]);
      accountIds.length = 0;
    }
  });

  afterAll(async () => {
    if (accountIds.length > 0) {
      await pool.query(`DELETE FROM sessions WHERE account_id = ANY($1)`, [
        accountIds,
      ]);
      await pool.query(`DELETE FROM accounts WHERE id = ANY($1)`, [accountIds]);
    }
    await dropTestDatabase(dbName, pool, "auth");
    await closeAdminPool();
  });

  /** Insert a test account and return its ID. */
  async function createAccount(
    opts: { adminEligible?: boolean; suffix?: string } = {},
  ): Promise<string> {
    const id = randomUUID();
    const suffix = opts.suffix ?? id.slice(0, 8);
    await pool.query(
      `INSERT INTO accounts
         (id, oidc_issuer, oidc_subject, username, display_name, status, admin_eligible)
       VALUES ($1, 'test-issuer', $2, $3, $4, 'active', $5)`,
      [
        id,
        `oidc-${suffix}`,
        `user-${suffix}`,
        `User ${suffix}`,
        opts.adminEligible ?? false,
      ],
    );
    accountIds.push(id);
    return id;
  }

  /**
   * Simulate the designation transaction logic from the POST handler.
   * Returns "ok" on success, or the error message on failure.
   */
  async function designateAdmin(
    targetPool: Pool,
    targetAccountId: string,
  ): Promise<"ok" | string> {
    try {
      await withTransaction(targetPool, async (tx) => {
        await tx.query(`SELECT pg_advisory_xact_lock($1)`, [
          ADMIN_DESIGNATION_LOCK_ID,
        ]);

        const countResult = await tx.query<{ admin_count: string }>(
          `SELECT COUNT(*) AS admin_count FROM accounts
           WHERE admin_eligible = true`,
        );

        if (Number(countResult.rows[0].admin_count) >= MAX_ADMINS) {
          throw new Error(`Maximum number of admins (${MAX_ADMINS}) reached`);
        }

        const accountRows = await tx.query<{
          status: string;
          admin_eligible: boolean;
        }>(
          `SELECT status, admin_eligible FROM accounts
           WHERE id = $1 FOR UPDATE`,
          [targetAccountId],
        );

        if (accountRows.rows.length === 0) {
          throw new Error("Account not found");
        }

        const account = accountRows.rows[0];
        if (account.admin_eligible) {
          throw new Error("Account is already an admin");
        }
        if (account.status !== "active") {
          throw new Error("Only active accounts can be designated as admin");
        }

        await tx.query(
          `UPDATE accounts
           SET admin_eligible = true,
               admin_eligible_at = NOW(),
               updated_at = NOW()
           WHERE id = $1`,
          [targetAccountId],
        );
      });
      return "ok";
    } catch (err) {
      return (err as Error).message;
    }
  }

  // -----------------------------------------------------------------------
  // 39-1: 3-person limit
  // -----------------------------------------------------------------------

  it("rejects designation when 3 admins already exist", async () => {
    await createAccount({ adminEligible: true, suffix: "admin-1" });
    await createAccount({ adminEligible: true, suffix: "admin-2" });
    await createAccount({ adminEligible: true, suffix: "admin-3" });
    const candidate = await createAccount({ suffix: "candidate" });

    const result = await designateAdmin(pool, candidate);
    expect(result).toContain("Maximum");

    // Verify candidate was NOT promoted
    const row = await pool.query(
      `SELECT admin_eligible FROM accounts WHERE id = $1`,
      [candidate],
    );
    expect(row.rows[0].admin_eligible).toBe(false);
  });

  it("allows designation when under the cap", async () => {
    await createAccount({ adminEligible: true, suffix: "existing" });
    const candidate = await createAccount({ suffix: "new-admin" });

    const result = await designateAdmin(pool, candidate);
    expect(result).toBe("ok");

    const row = await pool.query(
      `SELECT admin_eligible FROM accounts WHERE id = $1`,
      [candidate],
    );
    expect(row.rows[0].admin_eligible).toBe(true);
  });

  // -----------------------------------------------------------------------
  // 39-2: 3-person limit concurrency
  // -----------------------------------------------------------------------

  it("concurrent designations do not exceed the 3-admin cap", async () => {
    // Start with 2 existing admins
    await createAccount({ adminEligible: true, suffix: "existing-a" });
    await createAccount({ adminEligible: true, suffix: "existing-b" });

    // Create 3 candidates
    const candidates = await Promise.all([
      createAccount({ suffix: "candidate-x" }),
      createAccount({ suffix: "candidate-y" }),
      createAccount({ suffix: "candidate-z" }),
    ]);

    // Fire all 3 designation requests concurrently.
    // The advisory lock serializes them: the first to acquire the lock
    // will see count=2 and succeed; the remaining will see count=3
    // and fail with the maximum-reached error.
    const results = await Promise.all(
      candidates.map((id) => designateAdmin(pool, id)),
    );

    const successes = results.filter((r) => r === "ok");
    const failures = results.filter((r) => r !== "ok");

    expect(successes).toHaveLength(1);
    expect(failures).toHaveLength(2);
    for (const f of failures) {
      expect(f).toContain("Maximum");
    }

    // Verify exactly 3 admins in the database
    const countResult = await pool.query<{ cnt: string }>(
      `SELECT COUNT(*) AS cnt FROM accounts WHERE admin_eligible = true`,
    );
    expect(Number(countResult.rows[0].cnt)).toBe(3);
  });

  it("concurrent designations with cap=3 starting from 0", async () => {
    // Start with no admins, create 5 candidates, fire all at once.
    // Exactly 3 should succeed.
    const candidates = await Promise.all(
      Array.from({ length: 5 }, (_, i) =>
        createAccount({ suffix: `batch-${i}` }),
      ),
    );

    const results = await Promise.all(
      candidates.map((id) => designateAdmin(pool, id)),
    );

    const successes = results.filter((r) => r === "ok");
    const failures = results.filter((r) => r !== "ok");

    expect(successes).toHaveLength(3);
    expect(failures).toHaveLength(2);

    const countResult = await pool.query<{ cnt: string }>(
      `SELECT COUNT(*) AS cnt FROM accounts WHERE admin_eligible = true`,
    );
    expect(Number(countResult.rows[0].cnt)).toBe(3);
  });
});
