import { join } from "node:path";
import type { Pool, PoolClient } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  closeAdminPool,
  createTestDatabase,
  dropTestDatabase,
  hasPostgres,
} from "../../db/__tests__/db-test-helpers";
import { runMigrations } from "../../db/migrate";
import { createCustomer, updateCustomer } from "../customers";
import { HttpError } from "../errors";

const MIGRATIONS_DIR = join(process.cwd(), "migrations", "auth");
const LOCK_ID = 2000;

describe.skipIf(!hasPostgres)("customer creation (DB integration)", () => {
  let pool: Pool;
  let dbName: string;

  // Test fixtures
  let managerAccountId: string;
  let managerRoleId: number;

  beforeAll(async () => {
    const result = await createTestDatabase("customers", "auth");
    pool = result.pool;
    dbName = result.dbName;

    // Ensure runtime role exists
    await pool.query(`
      DO $$ BEGIN
        IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'aimer_auth') THEN
          CREATE ROLE aimer_auth LOGIN PASSWORD 'changeme';
        END IF;
      END $$
    `);

    // Apply auth migrations
    await runMigrations(pool, MIGRATIONS_DIR, LOCK_ID);

    // Lookup Manager role
    const roles = await pool.query<{ id: number }>(
      `SELECT id FROM roles WHERE name = 'Manager' AND auth_context = 'general'`,
    );
    managerRoleId = roles.rows[0].id;

    // Create an account to be designated as initial Manager
    const mgr = await pool.query<{ id: string }>(
      `INSERT INTO accounts (oidc_issuer, oidc_subject, username, display_name, email)
       VALUES ('test-issuer', 'manager-001', 'manager', 'Manager', 'manager@example.com')
       RETURNING id`,
    );
    managerAccountId = mgr.rows[0].id;
  });

  afterAll(async () => {
    await dropTestDatabase(dbName, pool, "auth");
    await closeAdminPool();
  });

  async function runInTransaction<T>(
    fn: (client: PoolClient) => Promise<T>,
  ): Promise<T> {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const result = await fn(client);
      await client.query("COMMIT");
      return result;
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }
  }

  // =========================================================================
  // Happy path
  // =========================================================================

  it("creates customer and initial Manager membership atomically", async () => {
    const result = await runInTransaction((client) =>
      createCustomer(client, {
        name: "Acme Corp",
        externalKey: "acme-001",
        managerAccountId,
      }),
    );

    expect(result.id).toBeDefined();
    expect(result.name).toBe("Acme Corp");
    expect(result.externalKey).toBe("acme-001");
    expect(result.status).toBe("active");
    expect(result.databaseStatus).toBe("provisioning");

    // Verify customer row
    const cust = await pool.query<{ name: string; status: string }>(
      `SELECT name, status FROM customers WHERE id = $1`,
      [result.id],
    );
    expect(cust.rows).toHaveLength(1);
    expect(cust.rows[0].name).toBe("Acme Corp");

    // Verify Manager membership
    const membership = await pool.query<{ role_id: number }>(
      `SELECT role_id FROM account_customer_memberships
       WHERE account_id = $1 AND customer_id = $2`,
      [managerAccountId, result.id],
    );
    expect(membership.rows).toHaveLength(1);
    expect(membership.rows[0].role_id).toBe(managerRoleId);

    // Verify retention policy auto-insert with RFC 0001 defaults.
    const retention = await pool.query<{
      ingestion_days: number;
      analysis_days: number | null;
      updated_by: string;
    }>(
      `SELECT ingestion_days, analysis_days, updated_by
       FROM customer_retention_policy
       WHERE customer_id = $1`,
      [result.id],
    );
    expect(retention.rows).toHaveLength(1);
    expect(retention.rows[0].ingestion_days).toBe(365);
    // analysis_days defaults to 1095 explicitly, NOT NULL — NULL is
    // reserved for operator-opted "unlimited" via the settings UI.
    expect(retention.rows[0].analysis_days).toBe(1095);
    expect(retention.rows[0].updated_by).toBe(managerAccountId);
  });

  it("creates customer with optional description", async () => {
    const result = await runInTransaction((client) =>
      createCustomer(client, {
        name: "Beta Inc",
        externalKey: "beta-001",
        description: "A test customer",
        managerAccountId,
      }),
    );

    const cust = await pool.query<{ description: string | null }>(
      `SELECT description FROM customers WHERE id = $1`,
      [result.id],
    );
    expect(cust.rows[0].description).toBe("A test customer");
  });

  it("sets database_status to provisioning (not active)", async () => {
    const result = await runInTransaction((client) =>
      createCustomer(client, {
        name: "Gamma Ltd",
        externalKey: "gamma-001",
        managerAccountId,
      }),
    );

    const cust = await pool.query<{ database_status: string }>(
      `SELECT database_status FROM customers WHERE id = $1`,
      [result.id],
    );
    expect(cust.rows[0].database_status).toBe("provisioning");
  });

  // =========================================================================
  // Error cases
  // =========================================================================

  it("rejects non-existent manager account (404)", async () => {
    try {
      await runInTransaction((client) =>
        createCustomer(client, {
          name: "No Manager Corp",
          externalKey: "no-mgr-001",
          managerAccountId: "00000000-0000-0000-0000-000000000000",
        }),
      );
      expect.unreachable("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(HttpError);
      expect((err as HttpError).statusCode).toBe(404);
      expect((err as HttpError).message).toBe("Account not found");
    }
  });

  it("rejects duplicate external_key (409)", async () => {
    await runInTransaction((client) =>
      createCustomer(client, {
        name: "Dup Key Corp",
        externalKey: "dup-key-001",
        managerAccountId,
      }),
    );

    try {
      await runInTransaction((client) =>
        createCustomer(client, {
          name: "Dup Key Corp 2",
          externalKey: "dup-key-001",
          managerAccountId,
        }),
      );
      expect.unreachable("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(HttpError);
      expect((err as HttpError).statusCode).toBe(409);
      expect((err as HttpError).message).toBe("external_key_conflict");
    }
  });

  // =========================================================================
  // Atomicity
  // =========================================================================

  it("rolls back customer when account does not exist", async () => {
    const fakeId = "00000000-0000-0000-0000-ffffffffffff";

    await expect(
      runInTransaction((client) =>
        createCustomer(client, {
          name: "Should Not Exist",
          externalKey: "rollback-test-001",
          managerAccountId: fakeId,
        }),
      ),
    ).rejects.toThrow("Account not found");

    // Customer must not be left behind
    const cust = await pool.query(
      `SELECT 1 FROM customers WHERE external_key = 'rollback-test-001'`,
    );
    expect(cust.rows).toHaveLength(0);
  });

  it("creates exactly one membership per customer", async () => {
    const result = await runInTransaction((client) =>
      createCustomer(client, {
        name: "Single Membership Corp",
        externalKey: "single-mem-001",
        managerAccountId,
      }),
    );

    const count = await pool.query<{ cnt: number }>(
      `SELECT COUNT(*)::int AS cnt FROM account_customer_memberships
       WHERE customer_id = $1`,
      [result.id],
    );
    expect(count.rows[0].cnt).toBe(1);
  });

  // =========================================================================
  // Same account as Manager for multiple customers
  // =========================================================================

  it("allows same account to be Manager of multiple customers", async () => {
    const cust1 = await runInTransaction((client) =>
      createCustomer(client, {
        name: "Multi A",
        externalKey: "multi-a",
        managerAccountId,
      }),
    );
    const cust2 = await runInTransaction((client) =>
      createCustomer(client, {
        name: "Multi B",
        externalKey: "multi-b",
        managerAccountId,
      }),
    );

    expect(cust1.id).not.toBe(cust2.id);

    // Both memberships exist
    const memberships = await pool.query<{ customer_id: string }>(
      `SELECT customer_id FROM account_customer_memberships
       WHERE account_id = $1 AND customer_id IN ($2, $3)`,
      [managerAccountId, cust1.id, cust2.id],
    );
    expect(memberships.rows).toHaveLength(2);
  });

  // =========================================================================
  // Description defaults to null when omitted
  // =========================================================================

  it("stores null description when omitted", async () => {
    const result = await runInTransaction((client) =>
      createCustomer(client, {
        name: "No Desc Corp",
        externalKey: "no-desc-001",
        managerAccountId,
      }),
    );

    const cust = await pool.query<{ description: string | null }>(
      `SELECT description FROM customers WHERE id = $1`,
      [result.id],
    );
    expect(cust.rows[0].description).toBeNull();
  });

  // =========================================================================
  // Unique customer IDs
  // =========================================================================

  it("generates unique customer IDs", async () => {
    const cust1 = await runInTransaction((client) =>
      createCustomer(client, {
        name: "Unique A",
        externalKey: "unique-a",
        managerAccountId,
      }),
    );
    const cust2 = await runInTransaction((client) =>
      createCustomer(client, {
        name: "Unique B",
        externalKey: "unique-b",
        managerAccountId,
      }),
    );

    expect(cust1.id).not.toBe(cust2.id);
    // UUID format
    expect(cust1.id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
  });

  // =========================================================================
  // Timestamps
  // =========================================================================

  // =========================================================================
  // updateCustomer
  // =========================================================================

  describe("updateCustomer", () => {
    it("updates name and reports changedFields", async () => {
      const created = await runInTransaction((client) =>
        createCustomer(client, {
          name: "Update Name Corp",
          externalKey: "update-name-001",
          managerAccountId,
        }),
      );

      const result = await runInTransaction((client) =>
        updateCustomer(client, created.id, { name: "Renamed Corp" }),
      );

      expect(result.name).toBe("Renamed Corp");
      expect(result.changedFields).toEqual(["name"]);
      expect(result.previous).toEqual({ name: "Update Name Corp" });
      expect(result.next).toEqual({ name: "Renamed Corp" });
    });

    it("updates external_key with previous/next snapshot", async () => {
      const created = await runInTransaction((client) =>
        createCustomer(client, {
          name: "Key Change Corp",
          externalKey: "key-old-001",
          managerAccountId,
        }),
      );

      const result = await runInTransaction((client) =>
        updateCustomer(client, created.id, { externalKey: "key-new-001" }),
      );

      expect(result.externalKey).toBe("key-new-001");
      expect(result.changedFields).toEqual(["external_key"]);
      expect(result.previous).toEqual({ external_key: "key-old-001" });
      expect(result.next).toEqual({ external_key: "key-new-001" });
    });

    it("rejects external_key collision with 409", async () => {
      await runInTransaction((client) =>
        createCustomer(client, {
          name: "First",
          externalKey: "collide-001",
          managerAccountId,
        }),
      );
      const second = await runInTransaction((client) =>
        createCustomer(client, {
          name: "Second",
          externalKey: "collide-002",
          managerAccountId,
        }),
      );

      try {
        await runInTransaction((client) =>
          updateCustomer(client, second.id, { externalKey: "collide-001" }),
        );
        expect.unreachable();
      } catch (err) {
        expect(err).toBeInstanceOf(HttpError);
        expect((err as HttpError).statusCode).toBe(409);
        expect((err as HttpError).message).toBe("external_key_conflict");
      }
    });

    it("returns 404 for unknown customer ID", async () => {
      const fake = "00000000-0000-0000-0000-fffffffff000";
      try {
        await runInTransaction((client) =>
          updateCustomer(client, fake, { name: "x" }),
        );
        expect.unreachable();
      } catch (err) {
        expect(err).toBeInstanceOf(HttpError);
        expect((err as HttpError).statusCode).toBe(404);
      }
    });

    it("no-op update returns empty changedFields", async () => {
      const created = await runInTransaction((client) =>
        createCustomer(client, {
          name: "NoOp Corp",
          externalKey: "noop-001",
          managerAccountId,
        }),
      );

      const result = await runInTransaction((client) =>
        updateCustomer(client, created.id, { name: "NoOp Corp" }),
      );

      expect(result.changedFields).toEqual([]);
      expect(result.name).toBe("NoOp Corp");
    });

    it("multi-field update reports all changed fields", async () => {
      const created = await runInTransaction((client) =>
        createCustomer(client, {
          name: "Multi A",
          externalKey: "multi-old-001",
          description: "old",
          managerAccountId,
        }),
      );

      const result = await runInTransaction((client) =>
        updateCustomer(client, created.id, {
          name: "Multi B",
          externalKey: "multi-new-001",
          description: "new",
        }),
      );

      expect(result.changedFields.sort()).toEqual(
        ["description", "external_key", "name"].sort(),
      );
      expect(result.previous.name).toBe("Multi A");
      expect(result.previous.external_key).toBe("multi-old-001");
      expect(result.previous.description).toBe("old");
      expect(result.next.name).toBe("Multi B");
      expect(result.next.external_key).toBe("multi-new-001");
      expect(result.next.description).toBe("new");
    });
  });

  it("sets created_at and updated_at on customer and membership", async () => {
    const before = new Date();
    const result = await runInTransaction((client) =>
      createCustomer(client, {
        name: "Timestamp Corp",
        externalKey: "timestamp-001",
        managerAccountId,
      }),
    );
    const after = new Date();

    const cust = await pool.query<{
      created_at: Date;
      updated_at: Date;
    }>(`SELECT created_at, updated_at FROM customers WHERE id = $1`, [
      result.id,
    ]);
    expect(cust.rows[0].created_at.getTime()).toBeGreaterThanOrEqual(
      before.getTime() - 1000,
    );
    expect(cust.rows[0].created_at.getTime()).toBeLessThanOrEqual(
      after.getTime() + 1000,
    );
    expect(cust.rows[0].updated_at.getTime()).toBe(
      cust.rows[0].created_at.getTime(),
    );

    const mem = await pool.query<{
      created_at: Date;
      updated_at: Date;
    }>(
      `SELECT created_at, updated_at FROM account_customer_memberships
       WHERE account_id = $1 AND customer_id = $2`,
      [managerAccountId, result.id],
    );
    expect(mem.rows[0].created_at.getTime()).toBeGreaterThanOrEqual(
      before.getTime() - 1000,
    );
  });
});
