import type { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  closeAdminPool,
  createTestDatabase,
  dropTestDatabase,
} from "../../db/__tests__/db-test-helpers";

const hasPostgres = !!process.env.DATABASE_ADMIN_URL;

describe.skipIf(!hasPostgres)("bridge DB integration", () => {
  let pool: Pool;
  let dbName: string;
  let accountId: string;
  let customerId: string;
  let customerIdB: string;

  beforeAll(async () => {
    const result = await createTestDatabase("bridge", "auth");
    pool = result.pool;
    dbName = result.dbName;

    // Seed: account, customers, environment, trust registry, memberships
    const acct = await pool.query<{ id: string }>(
      `INSERT INTO accounts (oidc_issuer, oidc_subject, username, display_name, email)
       VALUES ('test-issuer', 'bridge-user', 'bridgeuser', 'Bridge User', 'bridge@test.com')
       RETURNING id`,
    );
    accountId = acct.rows[0].id;

    const custA = await pool.query<{ id: string }>(
      `INSERT INTO customers (external_key, name, status, database_status)
       VALUES ('ext-cust-a', 'Customer A', 'active', 'active')
       RETURNING id`,
    );
    customerId = custA.rows[0].id;

    const custB = await pool.query<{ id: string }>(
      `INSERT INTO customers (external_key, name, status, database_status)
       VALUES ('ext-cust-b', 'Customer B', 'active', 'active')
       RETURNING id`,
    );
    customerIdB = custB.rows[0].id;

    // Environment
    await pool.query(
      `INSERT INTO aice_environments (aice_id, name, status)
       VALUES ('aice-test-1', 'Test AICE', 'active')`,
    );

    // Link customers to environment
    await pool.query(
      `INSERT INTO aice_environment_customers (aice_id, customer_id)
       VALUES ('aice-test-1', $1), ('aice-test-1', $2)`,
      [customerId, customerIdB],
    );

    // Trust registry
    await pool.query(
      `INSERT INTO trust_registry (aice_id, issuer, kid, public_key)
       VALUES ('aice-test-1', 'https://aice.test', 'key-1', $1)`,
      [JSON.stringify({ kty: "EC", crv: "P-256" })],
    );

    // Membership for account → customer A
    const userRole = await pool.query<{ id: number }>(
      `SELECT id FROM roles WHERE name = 'User' AND auth_context = 'general'`,
    );
    await pool.query(
      `INSERT INTO account_customer_memberships (account_id, customer_id, role_id)
       VALUES ($1, $2, $3)`,
      [accountId, customerId, userRole.rows[0].id],
    );
    // Membership for account → customer B
    await pool.query(
      `INSERT INTO account_customer_memberships (account_id, customer_id, role_id)
       VALUES ($1, $2, $3)`,
      [accountId, customerIdB, userRole.rows[0].id],
    );
  });

  afterAll(async () => {
    await dropTestDatabase(dbName, pool, "auth");
    await closeAdminPool();
  });

  // -- Pending connections --

  describe("pending connections", () => {
    it("creates a pending connection with jti", async () => {
      const result = await pool.query<{
        connection_id: string;
        status: string;
      }>(
        `INSERT INTO pending_connections (jti, issuer, aice_id, customer_ids, sub, expires_at)
         VALUES ('jti-db-1', 'https://aice.test', 'aice-test-1', $1, 'user-1', NOW() + INTERVAL '5 minutes')
         RETURNING connection_id, status`,
        [["ext-cust-a"]],
      );
      expect(result.rows).toHaveLength(1);
      expect(result.rows[0].status).toBe("pending");
    });

    it("rejects duplicate jti (replay prevention)", async () => {
      await expect(
        pool.query(
          `INSERT INTO pending_connections (jti, issuer, aice_id, customer_ids, sub, expires_at)
           VALUES ('jti-db-1', 'https://aice.test', 'aice-test-1', $1, 'user-2', NOW() + INTERVAL '5 minutes')`,
          [["ext-cust-a"]],
        ),
      ).rejects.toThrow(/pending_connections_jti_key/);
    });

    it("atomically consumes a pending connection", async () => {
      // Insert
      const ins = await pool.query<{ connection_id: string }>(
        `INSERT INTO pending_connections (jti, issuer, aice_id, customer_ids, sub, expires_at)
         VALUES ('jti-consume-1', 'https://aice.test', 'aice-test-1', $1, 'user-1', NOW() + INTERVAL '5 minutes')
         RETURNING connection_id`,
        [["ext-cust-a"]],
      );
      const connId = ins.rows[0].connection_id;

      // Consume
      const consumed = await pool.query<{ status: string }>(
        `UPDATE pending_connections SET status = 'consumed'
         WHERE connection_id = $1 AND status = 'pending' AND expires_at > NOW()
         RETURNING status`,
        [connId],
      );
      expect(consumed.rows).toHaveLength(1);
      expect(consumed.rows[0].status).toBe("consumed");

      // Second consume attempt returns nothing
      const second = await pool.query(
        `UPDATE pending_connections SET status = 'consumed'
         WHERE connection_id = $1 AND status = 'pending' AND expires_at > NOW()
         RETURNING status`,
        [connId],
      );
      expect(second.rows).toHaveLength(0);
    });

    it("does not consume expired connections", async () => {
      const ins = await pool.query<{ connection_id: string }>(
        `INSERT INTO pending_connections (jti, issuer, aice_id, customer_ids, sub, expires_at)
         VALUES ('jti-expired-1', 'https://aice.test', 'aice-test-1', $1, 'user-1', NOW() - INTERVAL '1 second')
         RETURNING connection_id`,
        [["ext-cust-a"]],
      );
      const connId = ins.rows[0].connection_id;

      const consumed = await pool.query(
        `UPDATE pending_connections SET status = 'consumed'
         WHERE connection_id = $1 AND status = 'pending' AND expires_at > NOW()
         RETURNING status`,
        [connId],
      );
      expect(consumed.rows).toHaveLength(0);
    });
  });

  // -- Bridge session creation --

  describe("bridge session", () => {
    it("creates session with bridge_aice_id and bridge_customer_ids", async () => {
      const session = await pool.query<{
        sid: string;
        bridge_aice_id: string;
        bridge_customer_ids: string[];
      }>(
        `INSERT INTO sessions (account_id, auth_context, bridge_aice_id, bridge_customer_ids, ip_address, user_agent)
         VALUES ($1, 'general', 'aice-test-1', $2, '127.0.0.1', 'test')
         RETURNING sid, bridge_aice_id, bridge_customer_ids`,
        [accountId, [customerId, customerIdB]],
      );
      expect(session.rows).toHaveLength(1);
      expect(session.rows[0].bridge_aice_id).toBe("aice-test-1");
      expect(session.rows[0].bridge_customer_ids).toEqual([
        customerId,
        customerIdB,
      ]);
    });

    it("rejects admin session with bridge context", async () => {
      await expect(
        pool.query(
          `INSERT INTO sessions (account_id, auth_context, bridge_aice_id, bridge_customer_ids, ip_address, user_agent)
           VALUES ($1, 'admin', 'aice-test-1', $2, '127.0.0.1', 'test')`,
          [accountId, [customerId]],
        ),
      ).rejects.toThrow();
    });

    it("rejects bridge_aice_id without bridge_customer_ids", async () => {
      await expect(
        pool.query(
          `INSERT INTO sessions (account_id, auth_context, bridge_aice_id, ip_address, user_agent)
           VALUES ($1, 'general', 'aice-test-1', '127.0.0.1', 'test')`,
          [accountId],
        ),
      ).rejects.toThrow();
    });
  });

  // -- Customer mapping --

  describe("customer mapping via aice_environment_customers", () => {
    it("maps external_key to internal customer_id", async () => {
      const result = await pool.query<{
        customer_id: string;
        external_key: string;
        customer_status: string;
        env_status: string;
      }>(
        `SELECT DISTINCT c.id AS customer_id,
                c.external_key,
                c.status AS customer_status,
                ae.status AS env_status
         FROM aice_environment_customers aec
         JOIN customers c ON c.id = aec.customer_id
         JOIN aice_environments ae ON ae.aice_id = aec.aice_id
         WHERE aec.aice_id = 'aice-test-1'
           AND c.external_key = ANY($1::text[])`,
        [["ext-cust-a", "ext-cust-b"]],
      );
      expect(result.rows).toHaveLength(2);
      const keys = result.rows.map((r) => r.external_key).sort();
      expect(keys).toEqual(["ext-cust-a", "ext-cust-b"]);
      for (const row of result.rows) {
        expect(row.customer_status).toBe("active");
        expect(row.env_status).toBe("active");
      }
    });

    it("returns nothing for unknown external_key", async () => {
      const result = await pool.query(
        `SELECT c.id FROM aice_environment_customers aec
         JOIN customers c ON c.id = aec.customer_id
         WHERE aec.aice_id = 'aice-test-1'
           AND c.external_key = ANY($1::text[])`,
        [["nonexistent-key"]],
      );
      expect(result.rows).toHaveLength(0);
    });
  });

  // -- Staged events --

  describe("staged event payloads", () => {
    it("stores and links staged events to session", async () => {
      // Create connection
      const conn = await pool.query<{ connection_id: string }>(
        `INSERT INTO pending_connections (jti, issuer, aice_id, customer_ids, sub, expires_at)
         VALUES ('jti-staged-1', 'https://aice.test', 'aice-test-1', $1, 'user-1', NOW() + INTERVAL '5 minutes')
         RETURNING connection_id`,
        [["ext-cust-a"]],
      );
      const connId = conn.rows[0].connection_id;

      // Stage payload
      const staged = await pool.query<{ id: string }>(
        `INSERT INTO staged_event_payloads (connection_id, aice_id, payload_hash, payload, event_count, schema_version, expires_at)
         VALUES ($1, 'aice-test-1', 'hash123', $2, 5, '1.0', NOW() + INTERVAL '5 minutes')
         RETURNING id`,
        [connId, Buffer.from("test payload")],
      );
      expect(staged.rows).toHaveLength(1);

      // Create session
      const session = await pool.query<{ sid: string }>(
        `INSERT INTO sessions (account_id, auth_context, bridge_aice_id, bridge_customer_ids, ip_address, user_agent)
         VALUES ($1, 'general', 'aice-test-1', $2, '127.0.0.1', 'test')
         RETURNING sid`,
        [accountId, [customerId]],
      );
      const sid = session.rows[0].sid;

      // Link
      await pool.query(
        `UPDATE staged_event_payloads SET session_id = $1 WHERE connection_id = $2`,
        [sid, connId],
      );

      // Verify link
      const linked = await pool.query<{ session_id: string }>(
        `SELECT session_id FROM staged_event_payloads WHERE id = $1`,
        [staged.rows[0].id],
      );
      expect(linked.rows[0].session_id).toBe(sid);
    });
  });

  // -- Cleanup --

  describe("expired connection cleanup", () => {
    it("deletes connections past the 24-hour grace period", async () => {
      // Insert an old expired connection
      await pool.query(
        `INSERT INTO pending_connections (jti, issuer, aice_id, customer_ids, sub, expires_at)
         VALUES ('jti-old-1', 'https://aice.test', 'aice-test-1', $1, 'user-1', NOW() - INTERVAL '25 hours')`,
        [["ext-cust-a"]],
      );

      const result = await pool.query(
        `DELETE FROM pending_connections
         WHERE expires_at < NOW() - INTERVAL '24 hours'
         RETURNING connection_id`,
      );
      expect(result.rowCount).toBeGreaterThanOrEqual(1);
    });

    it("preserves connections within the 24-hour grace period", async () => {
      // Insert a recently expired connection (within grace period)
      await pool.query(
        `INSERT INTO pending_connections (jti, issuer, aice_id, customer_ids, sub, expires_at)
         VALUES ('jti-recent-1', 'https://aice.test', 'aice-test-1', $1, 'user-1', NOW() - INTERVAL '1 hour')`,
        [["ext-cust-a"]],
      );

      const result = await pool.query(
        `DELETE FROM pending_connections
         WHERE jti = 'jti-recent-1' AND expires_at < NOW() - INTERVAL '24 hours'
         RETURNING connection_id`,
      );
      expect(result.rowCount).toBe(0);

      // Verify it still exists (jti still blocks replay)
      const exists = await pool.query(
        `SELECT 1 FROM pending_connections WHERE jti = 'jti-recent-1'`,
      );
      expect(exists.rows).toHaveLength(1);
    });
  });

  // -- Trust registry --

  describe("trust registry", () => {
    it("stores and retrieves keys", async () => {
      const result = await pool.query<{
        aice_id: string;
        kid: string;
        enabled: boolean;
      }>(
        `SELECT aice_id, kid, enabled FROM trust_registry
         WHERE aice_id = 'aice-test-1' AND issuer = 'https://aice.test'`,
      );
      expect(result.rows).toHaveLength(1);
      expect(result.rows[0].kid).toBe("key-1");
      expect(result.rows[0].enabled).toBe(true);
    });

    it("supports multiple kids per issuer (key rotation)", async () => {
      await pool.query(
        `INSERT INTO trust_registry (aice_id, issuer, kid, public_key)
         VALUES ('aice-test-1', 'https://aice.test', 'key-2', $1)`,
        [JSON.stringify({ kty: "EC", crv: "P-256", x: "rotated" })],
      );

      const result = await pool.query(
        `SELECT kid FROM trust_registry
         WHERE aice_id = 'aice-test-1' AND issuer = 'https://aice.test' AND enabled = true
         ORDER BY kid`,
      );
      expect(result.rows).toHaveLength(2);
    });

    it("disabled key not returned when filtering by enabled", async () => {
      await pool.query(
        `INSERT INTO trust_registry (aice_id, issuer, kid, public_key, enabled)
         VALUES ('aice-test-1', 'https://aice.test', 'key-disabled', $1, false)`,
        [JSON.stringify({ kty: "EC", crv: "P-256" })],
      );

      const result = await pool.query(
        `SELECT kid FROM trust_registry
         WHERE aice_id = 'aice-test-1' AND issuer = 'https://aice.test' AND enabled = true`,
      );
      const kids = result.rows.map((r: { kid: string }) => r.kid);
      expect(kids).not.toContain("key-disabled");
    });
  });
});
