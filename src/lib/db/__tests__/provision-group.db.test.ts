import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Pool } from "pg";
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
const GROUP_MIGRATIONS_DIR = join(process.cwd(), "migrations", "group");
const LOCK_ID = 3001;

// Tables that must be ABSENT from a freshly provisioned group DB (#508).
const EXCLUDED_TABLES = [
  "detection_events",
  "baseline_event",
  "story",
  "story_member",
  "policy_run",
  "policy_event",
  "event_analysis_result",
  "story_analysis_result",
  "event_redaction_map",
];

describe.skipIf(!hasPostgres)("provisionGroupDb (DB integration)", () => {
  let authPool: Pool;
  let authDbName: string;
  let authDbUrl: string;
  let creatorAccountId: string;

  beforeAll(async () => {
    const result = await createTestDatabase("provision_group", "auth");
    authPool = result.pool;
    authDbName = result.dbName;
    authDbUrl = result.url;

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

    const acct = await authPool.query<{ id: string }>(
      `INSERT INTO accounts (oidc_issuer, oidc_subject, username, display_name, email)
         VALUES ('test-issuer', 'grp-creator', 'group-creator', 'Creator', 'gc@example.com')
         RETURNING id`,
    );
    creatorAccountId = acct.rows[0].id;
  });

  afterAll(async () => {
    await dropTestDatabase(authDbName, authPool, "auth");
    await closeAdminPool();
  });

  // Insert a minimal group entity (subject + customer_groups). Membership
  // is not needed for provisioning.
  async function createTestGroup(name: string): Promise<string> {
    const client = await authPool.connect();
    try {
      await client.query("BEGIN");
      const subj = await client.query<{ id: string }>(
        `INSERT INTO subjects (kind) VALUES ('group') RETURNING id`,
      );
      const groupId = subj.rows[0].id;
      await client.query(
        `INSERT INTO customer_groups (id, kind, name, created_by, owner_id, tz)
         VALUES ($1, 'group', $2, $3, $3, 'UTC')`,
        [groupId, name, creatorAccountId],
      );
      await client.query("COMMIT");
      return groupId;
    } catch (err) {
      await client.query("ROLLBACK").catch(() => {});
      throw err;
    } finally {
      client.release();
    }
  }

  function cleanupGroupDb(groupId: string) {
    const dbName = `group_${groupId.replace(/-/g, "")}`;
    return authPool
      .query(
        `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = '${dbName}' AND pid <> pg_backend_pid()`,
      )
      .then(() => authPool.query(`DROP DATABASE IF EXISTS ${dbName}`))
      .catch(() => {});
  }

  it("provisions database, generates DEK, runs migrations, sets status to active", async () => {
    const groupId = await createTestGroup("Prov Happy Path");

    const { provisionGroupDb } = await import("../provision-group");
    const status = await provisionGroupDb(authPool, groupId, undefined, {
      adminUrl: authDbUrl,
      ownerTemplateUrl: authDbUrl,
      migrationsDir: GROUP_MIGRATIONS_DIR,
      generateDek: async (keyName) => {
        expect(keyName).toBe(`group-${groupId}`);
        return { wrappedDek: "vault:v1:test-dek" };
      },
    });

    expect(status).toBe("active");

    const row = await authPool.query(
      "SELECT database_status, wrapped_dek FROM customer_groups WHERE id = $1",
      [groupId],
    );
    expect(row.rows[0].database_status).toBe("active");
    expect(row.rows[0].wrapped_dek).toBe("vault:v1:test-dek");

    const dbName = `group_${groupId.replace(/-/g, "")}`;
    const dbCheck = await authPool.query(
      "SELECT 1 FROM pg_database WHERE datname = $1",
      [dbName],
    );
    expect(dbCheck.rows.length).toBe(1);

    const groupPool = new Pool({
      connectionString: authDbUrl.replace(/\/[^/?]+(\?|$)/, `/${dbName}$1`),
    });
    groupPool.on("error", () => {});
    try {
      const migs = await groupPool.query("SELECT version FROM _migrations");
      expect(migs.rows.length).toBeGreaterThanOrEqual(1);

      // The provisioned DB holds the results-only schema and none of the
      // excluded raw-event / customer_id-keyed tables (#508).
      const present = await groupPool.query<{ table_name: string }>(
        `SELECT table_name FROM information_schema.tables
          WHERE table_schema = 'public' AND table_name = ANY($1::text[])`,
        [EXCLUDED_TABLES],
      );
      expect(present.rows.map((r) => r.table_name)).toEqual([]);

      const periodic = await groupPool.query(
        `SELECT 1 FROM information_schema.tables
          WHERE table_schema = 'public' AND table_name = 'periodic_report_result'`,
      );
      expect(periodic.rows.length).toBe(1);
    } finally {
      await groupPool.end();
    }

    await cleanupGroupDb(groupId);
  });

  it("sets database_status to 'failed' when DEK generation fails", async () => {
    const groupId = await createTestGroup("Prov DEK Fail");

    const { provisionGroupDb } = await import("../provision-group");
    const status = await provisionGroupDb(authPool, groupId, undefined, {
      adminUrl: authDbUrl,
      ownerTemplateUrl: authDbUrl,
      migrationsDir: GROUP_MIGRATIONS_DIR,
      generateDek: async () => {
        throw new Error("Transit unavailable");
      },
    });

    expect(status).toBe("failed");

    const row = await authPool.query(
      "SELECT database_status, wrapped_dek FROM customer_groups WHERE id = $1",
      [groupId],
    );
    expect(row.rows[0].database_status).toBe("failed");
    expect(row.rows[0].wrapped_dek).toBeNull();

    await cleanupGroupDb(groupId);
  });

  it("sets database_status to 'failed' when migration fails", async () => {
    const groupId = await createTestGroup("Prov Mig Fail");

    const tmpDir = await mkdtemp(join(tmpdir(), "grp-mig-fail-"));
    await writeFile(
      join(tmpDir, "0000_good.sql"),
      "CREATE EXTENSION IF NOT EXISTS pgcrypto;",
    );
    await writeFile(join(tmpDir, "0001_bad.sql"), "SELECT 1/0;");

    const { provisionGroupDb } = await import("../provision-group");
    const status = await provisionGroupDb(authPool, groupId, undefined, {
      adminUrl: authDbUrl,
      ownerTemplateUrl: authDbUrl,
      migrationsDir: tmpDir,
      generateDek: async () => ({ wrappedDek: "vault:v1:test-dek" }),
    });

    expect(status).toBe("failed");

    const row = await authPool.query(
      "SELECT database_status, wrapped_dek FROM customer_groups WHERE id = $1",
      [groupId],
    );
    expect(row.rows[0].database_status).toBe("failed");
    // DEK is retained for retry
    expect(row.rows[0].wrapped_dek).toBe("vault:v1:test-dek");

    await cleanupGroupDb(groupId);
    await rm(tmpDir, { recursive: true });
  });

  it("retries provisioning on a failed group and reuses the stored DEK", async () => {
    const groupId = await createTestGroup("Prov Retry");

    const { provisionGroupDb } = await import("../provision-group");

    const tmpDir = await mkdtemp(join(tmpdir(), "grp-mig-retry-"));
    await writeFile(join(tmpDir, "0000_bad.sql"), "SELECT 1/0;");

    const status1 = await provisionGroupDb(authPool, groupId, undefined, {
      adminUrl: authDbUrl,
      ownerTemplateUrl: authDbUrl,
      migrationsDir: tmpDir,
      generateDek: async () => ({ wrappedDek: "vault:v1:retry-dek" }),
    });
    expect(status1).toBe("failed");

    await cleanupGroupDb(groupId);
    await authPool.query(
      "UPDATE customer_groups SET database_status = 'provisioning' WHERE id = $1",
      [groupId],
    );

    // DEK already stored — should be reused, not regenerated.
    const status2 = await provisionGroupDb(
      authPool,
      groupId,
      { isRetry: true },
      {
        adminUrl: authDbUrl,
        ownerTemplateUrl: authDbUrl,
        migrationsDir: GROUP_MIGRATIONS_DIR,
        generateDek: async () => ({ wrappedDek: "vault:v1:retry-dek-2" }),
      },
    );
    expect(status2).toBe("active");

    const row = await authPool.query(
      "SELECT database_status, wrapped_dek FROM customer_groups WHERE id = $1",
      [groupId],
    );
    expect(row.rows[0].database_status).toBe("active");
    expect(row.rows[0].wrapped_dek).toBe("vault:v1:retry-dek");

    await cleanupGroupDb(groupId);
    await rm(tmpDir, { recursive: true });
  });
});
