import type { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  closeAdminPool,
  createTestDatabase,
  dropTestDatabase,
} from "../../db/__tests__/db-test-helpers";
import { countAccessibleCustomers } from "../account";

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

  // -- Account upsert --

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
           username = EXCLUDED.username, display_name = EXCLUDED.display_name,
           email = EXCLUDED.email, last_sign_in_at = NOW(), updated_at = NOW()
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
      const result = await pool.query<{ display_name: string }>(
        `INSERT INTO accounts (oidc_issuer, oidc_subject, username, display_name, email, last_sign_in_at)
         VALUES ($1, $2, $3, $4, $5, NOW())
         ON CONFLICT (oidc_issuer, oidc_subject) DO UPDATE SET
           username = EXCLUDED.username, display_name = EXCLUDED.display_name,
           email = EXCLUDED.email, last_sign_in_at = NOW(), updated_at = NOW()
         RETURNING display_name`,
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

  // -- Session lifecycle --

  describe("session lifecycle", () => {
    let accountId: string;
    let sid: string;

    beforeAll(async () => {
      const acct = await pool.query<{ id: string }>(
        `SELECT id FROM accounts WHERE oidc_subject = 'user-001'`,
      );
      accountId = acct.rows[0].id;
    });

    it("creates a session", async () => {
      const result = await pool.query<{ sid: string }>(
        `INSERT INTO sessions (account_id, auth_context, ip_address, user_agent)
         VALUES ($1, 'general', '127.0.0.1', 'test-agent') RETURNING sid`,
        [accountId],
      );
      expect(result.rows).toHaveLength(1);
      sid = result.rows[0].sid;
    });

    it("verifyJwtFull query returns valid session", async () => {
      const rows = await pool.query<{
        revoked: boolean;
        needs_reauth: boolean;
        account_status: string;
        account_token_version: number;
      }>(
        `SELECT s.revoked, s.needs_reauth,
                a.status AS account_status,
                a.token_version AS account_token_version
         FROM sessions s
         JOIN accounts a ON a.id = s.account_id
         WHERE s.sid = $1`,
        [sid],
      );
      expect(rows.rows).toHaveLength(1);
      expect(rows.rows[0].revoked).toBe(false);
      expect(rows.rows[0].needs_reauth).toBe(false);
      expect(rows.rows[0].account_status).toBe("active");
    });

    it("detects revoked session", async () => {
      await pool.query(`UPDATE sessions SET revoked = true WHERE sid = $1`, [
        sid,
      ]);
      const rows = await pool.query<{ revoked: boolean }>(
        `SELECT revoked FROM sessions WHERE sid = $1`,
        [sid],
      );
      expect(rows.rows[0].revoked).toBe(true);
    });

    it("detects needs_reauth flag", async () => {
      // Create fresh session for this test
      const result = await pool.query<{ sid: string }>(
        `INSERT INTO sessions (account_id, auth_context, ip_address, user_agent, needs_reauth)
         VALUES ($1, 'general', '127.0.0.1', 'test', true) RETURNING sid`,
        [accountId],
      );
      const rows = await pool.query<{ needs_reauth: boolean }>(
        `SELECT needs_reauth FROM sessions WHERE sid = $1`,
        [result.rows[0].sid],
      );
      expect(rows.rows[0].needs_reauth).toBe(true);
    });

    it("detects suspended account status", async () => {
      await pool.query(
        `UPDATE accounts SET status = 'suspended' WHERE oidc_subject = 'user-001'`,
      );
      const rows = await pool.query<{ account_status: string }>(
        `SELECT a.status AS account_status FROM accounts a WHERE a.oidc_subject = 'user-001'`,
      );
      expect(rows.rows[0].account_status).toBe("suspended");
      // Restore
      await pool.query(
        `UPDATE accounts SET status = 'active' WHERE oidc_subject = 'user-001'`,
      );
    });

    it("detects token_version mismatch after bump", async () => {
      const before = await pool.query<{ token_version: number }>(
        `SELECT token_version FROM accounts WHERE oidc_subject = 'user-001'`,
      );
      await pool.query(
        `UPDATE accounts SET token_version = token_version + 1 WHERE oidc_subject = 'user-001'`,
      );
      const after = await pool.query<{ token_version: number }>(
        `SELECT token_version FROM accounts WHERE oidc_subject = 'user-001'`,
      );
      expect(after.rows[0].token_version).toBe(
        before.rows[0].token_version + 1,
      );
    });

    it("returns empty for non-existent session", async () => {
      const rows = await pool.query(
        `SELECT s.sid FROM sessions s WHERE s.sid = '00000000-0000-0000-0000-000000000000'`,
      );
      expect(rows.rows).toHaveLength(0);
    });
  });

  // -- Session policy (idle/absolute timeout) --

  describe("session timeout tracking", () => {
    let accountId: string;

    beforeAll(async () => {
      const acct = await pool.query<{ id: string }>(
        `SELECT id FROM accounts WHERE oidc_subject = 'user-001'`,
      );
      accountId = acct.rows[0].id;
    });

    it("updates last_active_at", async () => {
      const result = await pool.query<{ sid: string }>(
        `INSERT INTO sessions (account_id, auth_context, ip_address, user_agent)
         VALUES ($1, 'general', '127.0.0.1', 'test') RETURNING sid`,
        [accountId],
      );
      const sid = result.rows[0].sid;

      // Wait briefly and update
      await pool.query(
        `UPDATE sessions SET last_active_at = NOW() WHERE sid = $1`,
        [sid],
      );

      const rows = await pool.query<{ created_at: Date; last_active_at: Date }>(
        `SELECT created_at, last_active_at FROM sessions WHERE sid = $1`,
        [sid],
      );
      expect(rows.rows[0].last_active_at.getTime()).toBeGreaterThanOrEqual(
        rows.rows[0].created_at.getTime(),
      );
    });

    it("can detect idle timeout via timestamp comparison", async () => {
      const result = await pool.query<{ sid: string }>(
        `INSERT INTO sessions (account_id, auth_context, ip_address, user_agent,
                               last_active_at)
         VALUES ($1, 'general', '127.0.0.1', 'test',
                 NOW() - INTERVAL '31 minutes')
         RETURNING sid`,
        [accountId],
      );
      const sid = result.rows[0].sid;

      const rows = await pool.query<{ last_active_at: Date }>(
        `SELECT last_active_at FROM sessions WHERE sid = $1`,
        [sid],
      );
      const lastActive = Math.floor(
        rows.rows[0].last_active_at.getTime() / 1000,
      );
      const now = Math.floor(Date.now() / 1000);
      const idleSeconds = 30 * 60; // 30 min default

      expect(now - lastActive).toBeGreaterThan(idleSeconds);
    });
  });

  // -- Customer access check --

  describe("customer access (countAccessibleCustomers)", () => {
    let accountId: string;

    beforeAll(async () => {
      const acct = await pool.query<{ id: string }>(
        `SELECT id FROM accounts WHERE oidc_subject = 'user-001'`,
      );
      accountId = acct.rows[0].id;
    });

    it("returns 0 for account with no memberships or assignments", async () => {
      // Create a fresh account with no memberships
      const acct = await pool.query<{ id: string }>(
        `INSERT INTO accounts (oidc_issuer, oidc_subject, username, display_name)
         VALUES ('test-issuer', 'no-access-user', 'nouser', 'No Access')
         RETURNING id`,
      );
      const total = await countAccessibleCustomers(pool, acct.rows[0].id);
      expect(total).toBe(0);
    });

    it("returns 1+ after adding a membership", async () => {
      // Check if customer already exists from previous test run
      let customerId: string;
      const existing = await pool.query<{ id: string }>(
        `SELECT id FROM customers WHERE external_key = 'cust-1'`,
      );
      if (existing.rows.length > 0) {
        customerId = existing.rows[0].id;
      } else {
        const cust = await pool.query<{ id: string }>(
          `INSERT INTO customers (external_key, name) VALUES ('cust-1', 'Test Customer') RETURNING id`,
        );
        customerId = cust.rows[0].id;
      }

      const role = await pool.query<{ id: number }>(
        `SELECT id FROM roles WHERE name = 'User' AND auth_context = 'general'`,
      );

      // Upsert membership
      await pool.query(
        `INSERT INTO account_customer_memberships (account_id, customer_id, role_id)
         VALUES ($1, $2, $3)
         ON CONFLICT (account_id, customer_id) DO NOTHING`,
        [accountId, customerId, role.rows[0].id],
      );

      const total = await countAccessibleCustomers(pool, accountId);
      expect(total).toBeGreaterThanOrEqual(1);
    });

    it("does not count analyst assignments when analyst_eligible = false (#266)", async () => {
      // A stale analyst_customer_assignments row must not qualify an
      // account for sign-in once its analyst eligibility is revoked.
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
  });

  // -- Sign-out-all: revoke all + bump token_version --

  describe("sign-out-all", () => {
    let accountId: string;

    beforeAll(async () => {
      const acct = await pool.query<{ id: string }>(
        `SELECT id FROM accounts WHERE oidc_subject = 'user-001'`,
      );
      accountId = acct.rows[0].id;
    });

    it("revokes all sessions for an account", async () => {
      // Create two active sessions
      await pool.query(
        `INSERT INTO sessions (account_id, auth_context, ip_address, user_agent)
         VALUES ($1, 'general', '1.1.1.1', 'browser1')`,
        [accountId],
      );
      await pool.query(
        `INSERT INTO sessions (account_id, auth_context, ip_address, user_agent)
         VALUES ($1, 'general', '2.2.2.2', 'browser2')`,
        [accountId],
      );

      // Revoke all
      const result = await pool.query(
        `UPDATE sessions SET revoked = true WHERE account_id = $1 AND revoked = false`,
        [accountId],
      );
      expect(result.rowCount).toBeGreaterThanOrEqual(2);

      // Verify none are active
      const active = await pool.query<{ count: number }>(
        `SELECT COUNT(*)::int AS count FROM sessions WHERE account_id = $1 AND revoked = false`,
        [accountId],
      );
      expect(active.rows[0].count).toBe(0);
    });

    it("bumps token_version to invalidate JWTs", async () => {
      const before = await pool.query<{ token_version: number }>(
        `SELECT token_version FROM accounts WHERE id = $1`,
        [accountId],
      );

      await pool.query(
        `UPDATE accounts SET token_version = token_version + 1, updated_at = NOW() WHERE id = $1`,
        [accountId],
      );

      const after = await pool.query<{ token_version: number }>(
        `SELECT token_version FROM accounts WHERE id = $1`,
        [accountId],
      );
      expect(after.rows[0].token_version).toBe(
        before.rows[0].token_version + 1,
      );
    });
  });

  // -- Same-account enforcement --

  describe("same-account enforcement", () => {
    let accountAId: string;
    let accountBId: string;

    beforeAll(async () => {
      const acctA = await pool.query<{ id: string }>(
        `SELECT id FROM accounts WHERE oidc_subject = 'user-001'`,
      );
      accountAId = acctA.rows[0].id;

      // Create account B
      const acctB = await pool.query<{ id: string }>(
        `INSERT INTO accounts (oidc_issuer, oidc_subject, username, display_name)
         VALUES ('test-issuer', 'user-002', 'userB', 'User B')
         ON CONFLICT (oidc_issuer, oidc_subject) DO UPDATE SET username = 'userB'
         RETURNING id`,
      );
      accountBId = acctB.rows[0].id;
    });

    it("revokes all sessions for previous account on different-account sign-in", async () => {
      // Create sessions for account A (both general and admin)
      await pool.query(
        `INSERT INTO sessions (account_id, auth_context, ip_address, user_agent)
         VALUES ($1, 'general', '1.1.1.1', 'test')`,
        [accountAId],
      );
      await pool.query(
        `INSERT INTO sessions (account_id, auth_context, ip_address, user_agent)
         VALUES ($1, 'admin', '1.1.1.1', 'test')`,
        [accountAId],
      );

      // Simulate different-account enforcement: revoke all of A's sessions
      await pool.query(
        `UPDATE sessions SET revoked = true WHERE account_id = $1 AND revoked = false`,
        [accountAId],
      );

      // Verify A has no active sessions
      const activeA = await pool.query<{ count: number }>(
        `SELECT COUNT(*)::int AS count FROM sessions
         WHERE account_id = $1 AND revoked = false`,
        [accountAId],
      );
      expect(activeA.rows[0].count).toBe(0);

      // Create session for account B (the new account)
      const sessionB = await pool.query<{ sid: string }>(
        `INSERT INTO sessions (account_id, auth_context, ip_address, user_agent)
         VALUES ($1, 'general', '1.1.1.1', 'test')
         RETURNING sid`,
        [accountBId],
      );
      expect(sessionB.rows).toHaveLength(1);
    });

    it("preserves sessions for same-account sign-in", async () => {
      // Create a general session for account B
      await pool.query(
        `INSERT INTO sessions (account_id, auth_context, ip_address, user_agent)
         VALUES ($1, 'general', '2.2.2.2', 'test')`,
        [accountBId],
      );

      // Account B signs in as admin (same account) — no revocation
      const activeB = await pool.query<{ count: number }>(
        `SELECT COUNT(*)::int AS count FROM sessions
         WHERE account_id = $1 AND revoked = false`,
        [accountBId],
      );
      expect(activeB.rows[0].count).toBeGreaterThanOrEqual(1);

      // Add admin session alongside
      await pool.query(
        `INSERT INTO sessions (account_id, auth_context, ip_address, user_agent)
         VALUES ($1, 'admin', '2.2.2.2', 'test')`,
        [accountBId],
      );

      // Both sessions coexist
      const contexts = await pool.query<{ auth_context: string }>(
        `SELECT DISTINCT auth_context FROM sessions
         WHERE account_id = $1 AND revoked = false`,
        [accountBId],
      );
      const ctxSet = new Set(contexts.rows.map((r) => r.auth_context));
      expect(ctxSet.has("general")).toBe(true);
      expect(ctxSet.has("admin")).toBe(true);
    });
  });
});
