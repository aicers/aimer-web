import type { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  closeAdminPool,
  createTestDatabase,
  dropTestDatabase,
} from "../../db/__tests__/db-test-helpers";
import { withTransaction } from "../../db/client";

const hasPostgres = !!process.env.DATABASE_ADMIN_URL;

describe.skipIf(!hasPostgres)("staged events DB integration", () => {
  let pool: Pool;
  let dbName: string;
  let accountId: string;
  let customerId: string;
  let customerIdB: string;
  let sessionId: string;

  beforeAll(async () => {
    const result = await createTestDatabase("staged_events", "auth");
    pool = result.pool;
    dbName = result.dbName;

    // Seed data
    const acct = await pool.query<{ id: string }>(
      `INSERT INTO accounts (oidc_issuer, oidc_subject, username, display_name, email)
       VALUES ('test-issuer', 'staged-user', 'stageduser', 'Staged User', 'staged@test.com')
       RETURNING id`,
    );
    accountId = acct.rows[0].id;

    const custA = await pool.query<{ id: string }>(
      `INSERT INTO customers (external_key, name, status, database_status)
       VALUES ('ext-staged-a', 'Customer A', 'active', 'active')
       RETURNING id`,
    );
    customerId = custA.rows[0].id;

    const custB = await pool.query<{ id: string }>(
      `INSERT INTO customers (external_key, name, status, database_status)
       VALUES ('ext-staged-b', 'Customer B', 'active', 'active')
       RETURNING id`,
    );
    customerIdB = custB.rows[0].id;

    // Create a session for tests
    const sess = await pool.query<{ sid: string }>(
      `INSERT INTO sessions (account_id, auth_context, ip_address, user_agent)
       VALUES ($1, 'general', '127.0.0.1', 'test')
       RETURNING sid`,
      [accountId],
    );
    sessionId = sess.rows[0].sid;
  });

  afterAll(async () => {
    await dropTestDatabase(dbName, pool, "auth");
    await closeAdminPool();
  });

  // -- Helper to insert a staged payload --

  async function insertPayload(opts?: {
    sessionId?: string;
    expiresInterval?: string;
  }): Promise<string> {
    const sid = opts?.sessionId ?? sessionId;
    const interval = opts?.expiresInterval ?? "1 hour";
    const result = await pool.query<{ id: string }>(
      `INSERT INTO staged_event_payloads
         (session_id, aice_id, payload_hash, payload, wrapped_dek, event_count, schema_version, expires_at)
       VALUES ($1, 'aice-test', 'hash-abc', $2, 'vault:v1:wrappedkey', 10, '1.0', NOW() + INTERVAL '${interval}')
       RETURNING id`,
      [sid, Buffer.from("encrypted-payload-data")],
    );
    return result.rows[0].id;
  }

  async function insertCustomerRow(
    payloadId: string,
    custId: string,
    status = "pending",
  ): Promise<void> {
    await pool.query(
      `INSERT INTO staged_event_customers (payload_id, customer_id, status)
       VALUES ($1, $2, $3)`,
      [payloadId, custId, status],
    );
  }

  // -- List staged events --

  describe("listStagedEventsBySession", () => {
    it("returns payloads with customer summaries", async () => {
      const payloadId = await insertPayload();
      await insertCustomerRow(payloadId, customerId);
      await insertCustomerRow(payloadId, customerIdB);

      // Query manually (module uses server-only import)
      const rows = await pool.query<{
        payload_id: string;
        customer_id: string;
        customer_name: string;
        status: string;
      }>(
        `SELECT p.id AS payload_id, sec.customer_id, c.name AS customer_name, sec.status
         FROM staged_event_payloads p
         JOIN staged_event_customers sec ON sec.payload_id = p.id
         JOIN customers c ON c.id = sec.customer_id
         WHERE p.session_id = $1
         ORDER BY c.name`,
        [sessionId],
      );

      expect(rows.rows.length).toBeGreaterThanOrEqual(2);
      const forPayload = rows.rows.filter((r) => r.payload_id === payloadId);
      expect(forPayload).toHaveLength(2);
      expect(forPayload.map((r) => r.status)).toEqual(["pending", "pending"]);
    });
  });

  // -- Update customer status --

  describe("updateCustomerStatus", () => {
    it("approves a pending customer", async () => {
      const payloadId = await insertPayload();
      await insertCustomerRow(payloadId, customerId);

      const result = await withTransaction(pool, async (client) => {
        const res = await client.query<{ status: string; approved_at: Date }>(
          `UPDATE staged_event_customers
           SET status = 'approved', approved_at = NOW()
           WHERE payload_id = $1 AND customer_id = $2 AND status = 'pending'
           RETURNING status, approved_at`,
          [payloadId, customerId],
        );
        return res;
      });

      expect(result.rows).toHaveLength(1);
      expect(result.rows[0].status).toBe("approved");
      expect(result.rows[0].approved_at).toBeInstanceOf(Date);
    });

    it("rejects a pending customer", async () => {
      const payloadId = await insertPayload();
      await insertCustomerRow(payloadId, customerId);

      const result = await withTransaction(pool, async (client) => {
        const res = await client.query<{ status: string }>(
          `UPDATE staged_event_customers
           SET status = 'rejected'
           WHERE payload_id = $1 AND customer_id = $2 AND status = 'pending'
           RETURNING status`,
          [payloadId, customerId],
        );
        return res;
      });

      expect(result.rows).toHaveLength(1);
      expect(result.rows[0].status).toBe("rejected");
    });

    it("does not update non-pending rows", async () => {
      const payloadId = await insertPayload();
      await insertCustomerRow(payloadId, customerId, "approved");

      const result = await pool.query(
        `UPDATE staged_event_customers
         SET status = 'rejected'
         WHERE payload_id = $1 AND customer_id = $2 AND status = 'pending'
         RETURNING status`,
        [payloadId, customerId],
      );

      expect(result.rows).toHaveLength(0);
    });

    it("respects unique constraint on (payload_id, customer_id)", async () => {
      const payloadId = await insertPayload();
      await insertCustomerRow(payloadId, customerId);

      await expect(
        pool.query(
          `INSERT INTO staged_event_customers (payload_id, customer_id, status)
           VALUES ($1, $2, 'pending')`,
          [payloadId, customerId],
        ),
      ).rejects.toThrow();
    });
  });

  // -- Expire staged events --

  describe("expireStagedEvents", () => {
    it("marks pending customers as expired when payload has expired", async () => {
      const payloadId = await insertPayload({ expiresInterval: "-1 second" });
      await insertCustomerRow(payloadId, customerId);

      const result = await pool.query(
        `UPDATE staged_event_customers
         SET status = 'expired'
         FROM staged_event_payloads
         WHERE staged_event_customers.payload_id = staged_event_payloads.id
           AND staged_event_payloads.expires_at <= NOW()
           AND staged_event_customers.status = 'pending'`,
      );

      expect(result.rowCount).toBeGreaterThanOrEqual(1);

      const check = await pool.query<{ status: string }>(
        `SELECT status FROM staged_event_customers WHERE payload_id = $1 AND customer_id = $2`,
        [payloadId, customerId],
      );
      expect(check.rows[0].status).toBe("expired");
    });

    it("does not expire customers on non-expired payloads", async () => {
      const payloadId = await insertPayload({ expiresInterval: "1 hour" });
      await insertCustomerRow(payloadId, customerIdB);

      await pool.query(
        `UPDATE staged_event_customers
         SET status = 'expired'
         FROM staged_event_payloads
         WHERE staged_event_customers.payload_id = staged_event_payloads.id
           AND staged_event_payloads.expires_at <= NOW()
           AND staged_event_customers.status = 'pending'`,
      );

      const check = await pool.query<{ status: string }>(
        `SELECT status FROM staged_event_customers WHERE payload_id = $1 AND customer_id = $2`,
        [payloadId, customerIdB],
      );
      expect(check.rows[0].status).toBe("pending");
    });
  });

  // -- Cleanup terminal payloads --

  describe("cleanupTerminalPayloads", () => {
    it("deletes payloads where all customers are terminal", async () => {
      const payloadId = await insertPayload();
      await insertCustomerRow(payloadId, customerId, "approved");
      await insertCustomerRow(payloadId, customerIdB, "rejected");

      const result = await pool.query(
        `DELETE FROM staged_event_payloads
         WHERE id IN (
           SELECT p.id
           FROM staged_event_payloads p
           WHERE NOT EXISTS (
             SELECT 1 FROM staged_event_customers c
             WHERE c.payload_id = p.id AND c.status = 'pending'
           )
           AND EXISTS (
             SELECT 1 FROM staged_event_customers c2
             WHERE c2.payload_id = p.id
           )
         )
         RETURNING id`,
      );

      const deleted = result.rows.map((r: { id: string }) => r.id);
      expect(deleted).toContain(payloadId);
    });

    it("preserves payloads with pending customers", async () => {
      const payloadId = await insertPayload();
      await insertCustomerRow(payloadId, customerId, "approved");
      await insertCustomerRow(payloadId, customerIdB, "pending");

      const result = await pool.query(
        `DELETE FROM staged_event_payloads
         WHERE id = $1
           AND id IN (
             SELECT p.id
             FROM staged_event_payloads p
             WHERE NOT EXISTS (
               SELECT 1 FROM staged_event_customers c
               WHERE c.payload_id = p.id AND c.status = 'pending'
             )
             AND EXISTS (
               SELECT 1 FROM staged_event_customers c2
               WHERE c2.payload_id = p.id
             )
           )
         RETURNING id`,
        [payloadId],
      );

      expect(result.rows).toHaveLength(0);
    });
  });

  // -- Manual upload staging --

  describe("manual upload staging", () => {
    it("stages a payload with no connection_id and creates customer rows", async () => {
      const payloadId = await insertPayload();
      await insertCustomerRow(payloadId, customerId);

      // Verify connection_id is NULL for this payload
      const check = await pool.query<{ connection_id: string | null }>(
        `SELECT connection_id FROM staged_event_payloads WHERE id = $1`,
        [payloadId],
      );
      expect(check.rows[0].connection_id).toBeNull();

      // Verify customer row
      const custCheck = await pool.query<{
        customer_id: string;
        status: string;
      }>(
        `SELECT customer_id, status FROM staged_event_customers WHERE payload_id = $1`,
        [payloadId],
      );
      expect(custCheck.rows.length).toBeGreaterThanOrEqual(1);
    });
  });

  // -- wrapped_dek column --

  describe("wrapped_dek column", () => {
    it("stores and retrieves wrapped DEK", async () => {
      const result = await pool.query<{ wrapped_dek: string }>(
        `INSERT INTO staged_event_payloads
           (session_id, aice_id, payload_hash, payload, wrapped_dek, event_count, schema_version, expires_at)
         VALUES ($1, 'aice-test', 'hash-dek', $2, 'vault:v1:testkey123', 5, '1.0', NOW() + INTERVAL '1 hour')
         RETURNING wrapped_dek`,
        [sessionId, Buffer.from("ciphertext-data")],
      );
      expect(result.rows[0].wrapped_dek).toBe("vault:v1:testkey123");
    });

    it("rejects NULL wrapped_dek", async () => {
      await expect(
        pool.query(
          `INSERT INTO staged_event_payloads
             (session_id, aice_id, payload_hash, payload, wrapped_dek, event_count, schema_version, expires_at)
           VALUES ($1, 'aice-test', 'hash-null', $2, NULL, 5, '1.0', NOW() + INTERVAL '1 hour')`,
          [sessionId, Buffer.from("data")],
        ),
      ).rejects.toThrow();
    });
  });

  // -- Edge cases: mixed customer statuses --

  describe("mixed customer statuses on single payload", () => {
    it("one approved + one pending = payload NOT cleaned up", async () => {
      const payloadId = await insertPayload();
      await insertCustomerRow(payloadId, customerId, "approved");
      await insertCustomerRow(payloadId, customerIdB, "pending");

      const result = await pool.query(
        `SELECT p.id FROM staged_event_payloads p
         WHERE p.id = $1
           AND NOT EXISTS (
             SELECT 1 FROM staged_event_customers c
             WHERE c.payload_id = p.id AND c.status = 'pending'
           )`,
        [payloadId],
      );
      expect(result.rows).toHaveLength(0); // pending still exists
    });

    it("one approved + one rejected = all terminal, eligible for cleanup", async () => {
      const payloadId = await insertPayload();
      await insertCustomerRow(payloadId, customerId, "approved");
      await insertCustomerRow(payloadId, customerIdB, "rejected");

      const result = await pool.query(
        `SELECT p.id FROM staged_event_payloads p
         WHERE p.id = $1
           AND NOT EXISTS (
             SELECT 1 FROM staged_event_customers c
             WHERE c.payload_id = p.id AND c.status = 'pending'
           )
           AND EXISTS (
             SELECT 1 FROM staged_event_customers c2
             WHERE c2.payload_id = p.id
           )`,
        [payloadId],
      );
      expect(result.rows).toHaveLength(1);
    });

    it("one approved + one expired = all terminal, eligible for cleanup", async () => {
      const payloadId = await insertPayload();
      await insertCustomerRow(payloadId, customerId, "approved");
      await insertCustomerRow(payloadId, customerIdB, "expired");

      const result = await pool.query(
        `SELECT p.id FROM staged_event_payloads p
         WHERE p.id = $1
           AND NOT EXISTS (
             SELECT 1 FROM staged_event_customers c
             WHERE c.payload_id = p.id AND c.status = 'pending'
           )
           AND EXISTS (
             SELECT 1 FROM staged_event_customers c2
             WHERE c2.payload_id = p.id
           )`,
        [payloadId],
      );
      expect(result.rows).toHaveLength(1);
    });
  });

  // -- CASCADE deletion --

  describe("CASCADE deletion", () => {
    it("deleting a payload cascades to staged_event_customers", async () => {
      const payloadId = await insertPayload();
      await insertCustomerRow(payloadId, customerId, "approved");
      await insertCustomerRow(payloadId, customerIdB, "rejected");

      await pool.query(`DELETE FROM staged_event_payloads WHERE id = $1`, [
        payloadId,
      ]);

      const check = await pool.query(
        `SELECT COUNT(*) AS cnt FROM staged_event_customers WHERE payload_id = $1`,
        [payloadId],
      );
      expect(Number(check.rows[0].cnt)).toBe(0);
    });
  });

  // -- Session isolation --

  describe("session isolation", () => {
    it("payloads from different sessions are not mixed", async () => {
      // Create a second session
      const sess2 = await pool.query<{ sid: string }>(
        `INSERT INTO sessions (account_id, auth_context, ip_address, user_agent)
         VALUES ($1, 'general', '127.0.0.1', 'test')
         RETURNING sid`,
        [accountId],
      );
      const sessionId2 = sess2.rows[0].sid;

      const payload1 = await insertPayload({ sessionId });
      const payload2 = await insertPayload({ sessionId: sessionId2 });
      await insertCustomerRow(payload1, customerId);
      await insertCustomerRow(payload2, customerId);

      // Query session 1
      const rows1 = await pool.query(
        `SELECT p.id FROM staged_event_payloads p
         JOIN staged_event_customers sec ON sec.payload_id = p.id
         WHERE p.session_id = $1`,
        [sessionId],
      );
      const ids1 = rows1.rows.map((r: { id: string }) => r.id);
      expect(ids1).toContain(payload1);
      expect(ids1).not.toContain(payload2);

      // Query session 2
      const rows2 = await pool.query(
        `SELECT p.id FROM staged_event_payloads p
         JOIN staged_event_customers sec ON sec.payload_id = p.id
         WHERE p.session_id = $1`,
        [sessionId2],
      );
      const ids2 = rows2.rows.map((r: { id: string }) => r.id);
      expect(ids2).toContain(payload2);
      expect(ids2).not.toContain(payload1);
    });
  });

  // -- Status CHECK constraint --

  describe("status CHECK constraint", () => {
    it("rejects invalid status values", async () => {
      const payloadId = await insertPayload();
      await expect(
        pool.query(
          `INSERT INTO staged_event_customers (payload_id, customer_id, status)
           VALUES ($1, $2, 'invalid_status')`,
          [payloadId, customerId],
        ),
      ).rejects.toThrow();
    });
  });
});
