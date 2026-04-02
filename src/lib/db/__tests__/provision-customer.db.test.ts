import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { runMigrations } from "../migrate";
import {
  closeAdminPool,
  createTestDatabase,
  dropTestDatabase,
  hasPostgres,
} from "./db-test-helpers";

vi.mock("server-only", () => ({}));

// Mock Transit — no OpenBao in CI
const mockGenerateDataKey = vi.fn().mockResolvedValue({
  plaintext: Buffer.alloc(32, 0xab),
  wrappedDek: "vault:v1:mock-wrapped-dek",
});
vi.mock("../../crypto/transit", () => ({
  getTransitConfig: () => ({ addr: "http://mock:8200", token: "mock" }),
  generateDataKey: (...args: unknown[]) => mockGenerateDataKey(...args),
  decryptDataKey: vi.fn().mockResolvedValue(Buffer.alloc(32, 0xab)),
}));

const AUTH_MIGRATIONS_DIR = join(process.cwd(), "migrations", "auth");
const CUSTOMER_MIGRATIONS_DIR = join(process.cwd(), "migrations", "customer");
const LOCK_ID = 3000;

describe.skipIf(!hasPostgres)("provisionCustomerDb (DB integration)", () => {
  let authPool: Pool;
  let authDbName: string;
  let authDbUrl: string;
  let managerAccountId: string;

  beforeAll(async () => {
    const result = await createTestDatabase("provision", "auth");
    authPool = result.pool;
    authDbName = result.dbName;
    authDbUrl = result.url;

    // Ensure roles exist
    for (const role of [
      "aimer_auth",
      "aimer_customer_owner",
      "aimer_customer",
    ]) {
      await authPool.query(`
          DO $$ BEGIN
            IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = '${role}') THEN
              CREATE ROLE ${role} LOGIN PASSWORD 'changeme';
            END IF;
          END $$
        `);
    }

    await runMigrations(authPool, AUTH_MIGRATIONS_DIR, LOCK_ID);

    // Create test account
    const mgr = await authPool.query<{ id: string }>(
      `INSERT INTO accounts (oidc_issuer, oidc_subject, username, display_name, email)
         VALUES ('test-issuer', 'mgr-prov', 'manager-prov', 'Manager', 'mgr@example.com')
         RETURNING id`,
    );
    managerAccountId = mgr.rows[0].id;
  });

  afterAll(async () => {
    await dropTestDatabase(authDbName, authPool, "auth");
    await closeAdminPool();
  });

  async function createTestCustomer(externalKey: string): Promise<string> {
    const { createCustomer } = await import("../../auth/customers");
    const client = await authPool.connect();
    try {
      await client.query("BEGIN");
      const customer = await createCustomer(client, {
        name: `Test ${externalKey}`,
        externalKey,
        managerAccountId,
      });
      await client.query("COMMIT");
      return customer.id;
    } finally {
      client.release();
    }
  }

  function cleanupCustomerDb(customerId: string) {
    const dbName = `customer_${customerId.replace(/-/g, "")}`;
    return authPool
      .query(
        `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = '${dbName}' AND pid <> pg_backend_pid()`,
      )
      .then(() => authPool.query(`DROP DATABASE IF EXISTS ${dbName}`))
      .catch(() => {});
  }

  // =====================================================================
  // 44: Customer DB provisioning — DEK generated + schema migrated
  // =====================================================================

  it("provisions database, generates DEK, runs migrations, sets status to active", async () => {
    const customerId = await createTestCustomer("prov-happy-path");

    const { provisionCustomerDb } = await import("../provision-customer");
    const status = await provisionCustomerDb(authPool, customerId, undefined, {
      adminUrl: authDbUrl,
      ownerTemplateUrl: authDbUrl,
      migrationsDir: CUSTOMER_MIGRATIONS_DIR,
      generateDek: async (keyName) => {
        expect(keyName).toBe(`customer-${customerId}`);
        return { wrappedDek: "vault:v1:test-dek" };
      },
    });

    expect(status).toBe("active");

    // Verify database_status and wrapped_dek
    const row = await authPool.query(
      "SELECT database_status, wrapped_dek FROM customers WHERE id = $1",
      [customerId],
    );
    expect(row.rows[0].database_status).toBe("active");
    expect(row.rows[0].wrapped_dek).toBe("vault:v1:test-dek");

    // Verify customer database was created
    const dbName = `customer_${customerId.replace(/-/g, "")}`;
    const dbCheck = await authPool.query(
      "SELECT 1 FROM pg_database WHERE datname = $1",
      [dbName],
    );
    expect(dbCheck.rows.length).toBe(1);

    // Verify _migrations table was created (proves migrations ran)
    const { Pool } = await import("pg");
    const custPool = new Pool({
      connectionString: authDbUrl.replace(/\/[^/?]+(\?|$)/, `/${dbName}$1`),
    });
    try {
      const migs = await custPool.query("SELECT version FROM _migrations");
      expect(migs.rows.length).toBeGreaterThanOrEqual(1);
    } finally {
      await custPool.end();
    }

    await cleanupCustomerDb(customerId);
  });

  // =====================================================================
  // 44-1: Provisioning failure → database_status = 'failed'
  // =====================================================================

  it("sets database_status to 'failed' when DEK generation fails", async () => {
    const customerId = await createTestCustomer("prov-dek-fail");

    const { provisionCustomerDb } = await import("../provision-customer");
    const status = await provisionCustomerDb(authPool, customerId, undefined, {
      adminUrl: authDbUrl,
      ownerTemplateUrl: authDbUrl,
      migrationsDir: CUSTOMER_MIGRATIONS_DIR,
      generateDek: async () => {
        throw new Error("Transit unavailable");
      },
    });

    expect(status).toBe("failed");

    const row = await authPool.query(
      "SELECT database_status, wrapped_dek FROM customers WHERE id = $1",
      [customerId],
    );
    expect(row.rows[0].database_status).toBe("failed");
    // DEK was not stored since generation failed
    expect(row.rows[0].wrapped_dek).toBeNull();

    await cleanupCustomerDb(customerId);
  });

  it("sets database_status to 'failed' when migration fails", async () => {
    const customerId = await createTestCustomer("prov-mig-fail");

    // Create a temp migrations dir with a failing migration
    const tmpDir = await mkdtemp(join(tmpdir(), "mig-fail-"));
    await writeFile(
      join(tmpDir, "0000_good.sql"),
      "CREATE EXTENSION IF NOT EXISTS pgcrypto;",
    );
    await writeFile(
      join(tmpDir, "0001_bad.sql"),
      "SELECT 1/0;", // division by zero
    );

    const { provisionCustomerDb } = await import("../provision-customer");
    const status = await provisionCustomerDb(authPool, customerId, undefined, {
      adminUrl: authDbUrl,
      ownerTemplateUrl: authDbUrl,
      migrationsDir: tmpDir,
      generateDek: async () => ({ wrappedDek: "vault:v1:test-dek" }),
    });

    expect(status).toBe("failed");

    const row = await authPool.query(
      "SELECT database_status, wrapped_dek FROM customers WHERE id = $1",
      [customerId],
    );
    expect(row.rows[0].database_status).toBe("failed");
    // DEK is retained for retry
    expect(row.rows[0].wrapped_dek).toBe("vault:v1:test-dek");

    await cleanupCustomerDb(customerId);
    await rm(tmpDir, { recursive: true });
  });

  // =====================================================================
  // 44-2: Provision retry succeeds
  // =====================================================================

  it("retries provisioning on a failed customer", async () => {
    const customerId = await createTestCustomer("prov-retry");

    const { provisionCustomerDb } = await import("../provision-customer");

    // First attempt: fail during migration
    const tmpDir = await mkdtemp(join(tmpdir(), "mig-retry-"));
    await writeFile(join(tmpDir, "0000_bad.sql"), "SELECT 1/0;");

    const status1 = await provisionCustomerDb(authPool, customerId, undefined, {
      adminUrl: authDbUrl,
      ownerTemplateUrl: authDbUrl,
      migrationsDir: tmpDir,
      generateDek: async () => ({ wrappedDek: "vault:v1:retry-dek" }),
    });
    expect(status1).toBe("failed");

    // Drop the customer DB to simulate a clean retry
    await cleanupCustomerDb(customerId);

    // Reset database_status back to provisioning for retry
    await authPool.query(
      "UPDATE customers SET database_status = 'provisioning' WHERE id = $1",
      [customerId],
    );

    // Second attempt: succeed with correct migrations.
    // DEK is already stored from the first attempt, so it should be
    // reused rather than regenerated (avoids orphaning encrypted data).
    const status2 = await provisionCustomerDb(authPool, customerId, undefined, {
      adminUrl: authDbUrl,
      ownerTemplateUrl: authDbUrl,
      migrationsDir: CUSTOMER_MIGRATIONS_DIR,
      generateDek: async () => ({ wrappedDek: "vault:v1:retry-dek-2" }),
    });
    expect(status2).toBe("active");

    const row = await authPool.query(
      "SELECT database_status, wrapped_dek FROM customers WHERE id = $1",
      [customerId],
    );
    expect(row.rows[0].database_status).toBe("active");
    expect(row.rows[0].wrapped_dek).toBe("vault:v1:retry-dek");

    await cleanupCustomerDb(customerId);
    await rm(tmpDir, { recursive: true });
  });

  // =====================================================================
  // 44-8: Partial migration failure — one customer fails, others succeed
  // =====================================================================

  it("one customer failure does not affect others", async () => {
    const goodId = await createTestCustomer("prov-partial-good");
    const badId = await createTestCustomer("prov-partial-bad");

    const { provisionCustomerDb } = await import("../provision-customer");

    // Create failing migrations dir
    const tmpDir = await mkdtemp(join(tmpdir(), "mig-partial-"));
    await writeFile(join(tmpDir, "0000_bad.sql"), "SELECT 1/0;");

    // Provision good customer
    const goodStatus = await provisionCustomerDb(authPool, goodId, undefined, {
      adminUrl: authDbUrl,
      ownerTemplateUrl: authDbUrl,
      migrationsDir: CUSTOMER_MIGRATIONS_DIR,
      generateDek: async () => ({ wrappedDek: "vault:v1:good" }),
    });
    expect(goodStatus).toBe("active");

    // Provision bad customer (migration fails)
    const badStatus = await provisionCustomerDb(authPool, badId, undefined, {
      adminUrl: authDbUrl,
      ownerTemplateUrl: authDbUrl,
      migrationsDir: tmpDir,
      generateDek: async () => ({ wrappedDek: "vault:v1:bad" }),
    });
    expect(badStatus).toBe("failed");

    // Verify both statuses are independent
    const good = await authPool.query(
      "SELECT database_status FROM customers WHERE id = $1",
      [goodId],
    );
    expect(good.rows[0].database_status).toBe("active");

    const bad = await authPool.query(
      "SELECT database_status FROM customers WHERE id = $1",
      [badId],
    );
    expect(bad.rows[0].database_status).toBe("failed");

    await cleanupCustomerDb(goodId);
    await cleanupCustomerDb(badId);
    await rm(tmpDir, { recursive: true });
  });

  // =====================================================================
  // 44-9: database_status = 'failed' → API returns appropriate error
  // =====================================================================

  it("getCustomerOrFail rejects customer with failed database_status", async () => {
    const customerId = await createTestCustomer("prov-api-fail");
    await authPool.query(
      "UPDATE customers SET database_status = 'failed' WHERE id = $1",
      [customerId],
    );

    const { getCustomerOrFail } = await import("../../auth/customers");
    const { HttpError } = await import("../../auth/errors");

    await expect(getCustomerOrFail(authPool, customerId)).rejects.toThrow(
      HttpError,
    );

    try {
      await getCustomerOrFail(authPool, customerId);
    } catch (err) {
      expect((err as InstanceType<typeof HttpError>).statusCode).toBe(503);
      expect((err as InstanceType<typeof HttpError>).message).toBe(
        "customer_database_failed",
      );
    }
  });

  it("getCustomerOrFail rejects customer with provisioning database_status", async () => {
    const customerId = await createTestCustomer("prov-api-prov");

    const { getCustomerOrFail } = await import("../../auth/customers");
    const { HttpError } = await import("../../auth/errors");

    await expect(getCustomerOrFail(authPool, customerId)).rejects.toThrow(
      HttpError,
    );

    try {
      await getCustomerOrFail(authPool, customerId);
    } catch (err) {
      expect((err as InstanceType<typeof HttpError>).statusCode).toBe(503);
      expect((err as InstanceType<typeof HttpError>).message).toBe(
        "customer_database_provisioning",
      );
    }
  });

  it("getCustomerOrFail succeeds for active customer", async () => {
    const customerId = await createTestCustomer("prov-api-active");
    await authPool.query(
      "UPDATE customers SET database_status = 'active' WHERE id = $1",
      [customerId],
    );

    const { getCustomerOrFail } = await import("../../auth/customers");
    const customer = await getCustomerOrFail(authPool, customerId);
    expect(customer.id).toBe(customerId);
    expect(customer.databaseStatus).toBe("active");
  });
});
