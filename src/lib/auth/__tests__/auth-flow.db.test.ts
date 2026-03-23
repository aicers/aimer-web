import type { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  closeAdminPool,
  createTestDatabase,
  dropTestDatabase,
} from "../../db/__tests__/db-test-helpers";

const hasPostgres = !!process.env.DATABASE_ADMIN_URL;

describe.skipIf(!hasPostgres)("auth flow integration", () => {
  let pool: Pool;
  let dbName: string;

  beforeAll(async () => {
    const result = await createTestDatabase("auth_flow", "auth");
    pool = result.pool;
    dbName = result.dbName;
  });

  afterAll(async () => {
    await dropTestDatabase(dbName, pool, "auth");
    await closeAdminPool();
  });

  describe("account upsert", () => {
    it("creates a new account on first sign-in", async () => {
      const result = await pool.query<{
        id: string;
        status: string;
        token_version: number;
      }>(
        `INSERT INTO accounts (oidc_issuer, oidc_subject, username, display_name, email, last_sign_in_at)
         VALUES ($1, $2, $3, $4, $5, NOW())
         ON CONFLICT (oidc_issuer, oidc_subject) DO UPDATE SET
           username = EXCLUDED.username,
           display_name = EXCLUDED.display_name,
           email = EXCLUDED.email,
           last_sign_in_at = NOW(),
           updated_at = NOW()
         RETURNING id, status, token_version`,
        [
          "http://localhost:8080/realms/aimer",
          "user-001",
          "testuser",
          "Test User",
          "test@example.com",
        ],
      );

      expect(result.rows).toHaveLength(1);
      expect(result.rows[0].status).toBe("active");
      expect(result.rows[0].token_version).toBe(0);
    });

    it("updates existing account on subsequent sign-in", async () => {
      const result = await pool.query<{
        id: string;
        display_name: string;
      }>(
        `INSERT INTO accounts (oidc_issuer, oidc_subject, username, display_name, email, last_sign_in_at)
         VALUES ($1, $2, $3, $4, $5, NOW())
         ON CONFLICT (oidc_issuer, oidc_subject) DO UPDATE SET
           username = EXCLUDED.username,
           display_name = EXCLUDED.display_name,
           email = EXCLUDED.email,
           last_sign_in_at = NOW(),
           updated_at = NOW()
         RETURNING id, display_name`,
        [
          "http://localhost:8080/realms/aimer",
          "user-001",
          "testuser",
          "Updated Name",
          "test@example.com",
        ],
      );

      expect(result.rows[0].display_name).toBe("Updated Name");
    });
  });

  describe("session lifecycle", () => {
    let accountId: string;
    let sid: string;

    beforeAll(async () => {
      const acct = await pool.query<{ id: string }>(
        `SELECT id FROM accounts WHERE oidc_subject = $1`,
        ["user-001"],
      );
      accountId = acct.rows[0].id;
    });

    it("creates a session", async () => {
      const result = await pool.query<{ sid: string }>(
        `INSERT INTO sessions (account_id, auth_context, ip_address, user_agent)
         VALUES ($1, 'general', '127.0.0.1', 'test-agent')
         RETURNING sid`,
        [accountId],
      );
      expect(result.rows).toHaveLength(1);
      sid = result.rows[0].sid;
    });

    it("revokes a session", async () => {
      await pool.query(`UPDATE sessions SET revoked = true WHERE sid = $1`, [
        sid,
      ]);
      const result = await pool.query<{ revoked: boolean }>(
        `SELECT revoked FROM sessions WHERE sid = $1`,
        [sid],
      );
      expect(result.rows[0].revoked).toBe(true);
    });
  });

  describe("token_version invalidation", () => {
    it("bumps token_version", async () => {
      const before = await pool.query<{ token_version: number }>(
        `SELECT token_version FROM accounts WHERE oidc_subject = $1`,
        ["user-001"],
      );

      await pool.query(
        `UPDATE accounts SET token_version = token_version + 1
         WHERE oidc_subject = $1`,
        ["user-001"],
      );

      const after = await pool.query<{ token_version: number }>(
        `SELECT token_version FROM accounts WHERE oidc_subject = $1`,
        ["user-001"],
      );

      expect(after.rows[0].token_version).toBe(
        before.rows[0].token_version + 1,
      );
    });
  });

  describe("standard check (customer access)", () => {
    it("returns 0 for account with no memberships or assignments", async () => {
      const acct = await pool.query<{ id: string }>(
        `SELECT id FROM accounts WHERE oidc_subject = $1`,
        ["user-001"],
      );
      const accountId = acct.rows[0].id;

      const result = await pool.query<{ total: number }>(
        `SELECT COUNT(*)::int AS total FROM (
           SELECT account_id FROM account_customer_memberships WHERE account_id = $1
           UNION ALL
           SELECT account_id FROM analyst_customer_assignments WHERE account_id = $1
         ) AS combined`,
        [accountId],
      );

      expect(result.rows[0].total).toBe(0);
    });

    it("returns 1+ after adding a membership", async () => {
      const acct = await pool.query<{ id: string }>(
        `SELECT id FROM accounts WHERE oidc_subject = $1`,
        ["user-001"],
      );
      const accountId = acct.rows[0].id;

      // Create a customer
      const cust = await pool.query<{ id: string }>(
        `INSERT INTO customers (external_key, name) VALUES ('cust-1', 'Test Customer') RETURNING id`,
      );
      const customerId = cust.rows[0].id;

      // Get the 'User' role (general context, builtin)
      const role = await pool.query<{ id: number }>(
        `SELECT id FROM roles WHERE name = 'User' AND auth_context = 'general'`,
      );
      const roleId = role.rows[0].id;

      // Add membership
      await pool.query(
        `INSERT INTO account_customer_memberships (account_id, customer_id, role_id)
         VALUES ($1, $2, $3)`,
        [accountId, customerId, roleId],
      );

      const result = await pool.query<{ total: number }>(
        `SELECT COUNT(*)::int AS total FROM (
           SELECT account_id FROM account_customer_memberships WHERE account_id = $1
           UNION ALL
           SELECT account_id FROM analyst_customer_assignments WHERE account_id = $1
         ) AS combined`,
        [accountId],
      );

      expect(result.rows[0].total).toBe(1);
    });
  });
});
