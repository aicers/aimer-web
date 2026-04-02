import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Pool } from "pg";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import {
  closeAdminPool,
  createTestDatabase,
  dropTestDatabase,
  hasPostgres,
} from "../../db/__tests__/db-test-helpers";
import { runMigrations } from "../../db/migrate";
import { pgDump, pgRestore } from "../dump";
import { runPostRestoreCleanup } from "../post-restore";
import { LocalStorageBackend } from "../storage";

vi.mock("server-only", () => ({}));

const AUTH_MIGRATIONS_DIR = join(process.cwd(), "migrations", "auth");
const LOCK_ID = 3300;

/**
 * Check if pg_dump and pg_restore are available.
 * They may not be on PATH even when PostgreSQL server is running.
 */
async function hasPgTools(): Promise<boolean> {
  const { execFile: execFileCb } = await import("node:child_process");
  const { promisify } = await import("node:util");
  const execFile = promisify(execFileCb);
  try {
    await execFile("pg_dump", ["--version"]);
    await execFile("pg_restore", ["--version"]);
    return true;
  } catch {
    return false;
  }
}

let pgToolsAvailable = false;

// We need both Postgres AND pg tools for this test
const canRun = hasPostgres;

describe.skipIf(!canRun)("backup-restore E2E (DB)", () => {
  let sourcePool: Pool;
  let sourceDbName: string;
  let sourceUrl: string;
  let tmpDir: string;

  beforeAll(async () => {
    pgToolsAvailable = await hasPgTools();

    const result = await createTestDatabase("backup_e2e");
    sourcePool = result.pool;
    sourceDbName = result.dbName;
    sourceUrl = result.url;

    // Run auth migrations to set up schema
    await runMigrations(sourcePool, AUTH_MIGRATIONS_DIR, LOCK_ID);
  });

  afterAll(async () => {
    await dropTestDatabase(sourceDbName, sourcePool);
    await closeAdminPool();
  });

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "backup-e2e-"));
  });

  describe.skipIf(!pgToolsAvailable)("pg_dump and pg_restore", () => {
    it("backs up and restores a database preserving data", async () => {
      // Seed some data
      const account = await sourcePool.query(
        `INSERT INTO accounts (oidc_issuer, oidc_subject, username, display_name)
         VALUES ('https://keycloak/realms/e2e', 'user-e2e', 'e2e-user', 'E2E User')
         RETURNING id`,
      );
      const accountId = account.rows[0].id;

      await sourcePool.query(
        `INSERT INTO sessions (account_id, ip_address, user_agent, revoked)
         VALUES ($1, '10.0.0.1', 'e2e-agent', false)`,
        [accountId],
      );

      // Backup
      const dumpPath = join(tmpDir, "auth_db.dump");
      const dumpResult = await pgDump({
        connectionUrl: sourceUrl,
        outputPath: dumpPath,
      });

      expect(dumpResult.sizeBytes).toBeGreaterThan(0);
      expect(existsSync(dumpPath)).toBe(true);

      // Create a fresh target database
      const target = await createTestDatabase("backup_e2e_restore");

      try {
        // Restore
        await pgRestore({
          connectionUrl: target.url,
          inputPath: dumpPath,
          noOwner: true,
        });

        // Verify data integrity
        const accounts = await target.pool.query(
          "SELECT display_name FROM accounts WHERE oidc_subject = 'user-e2e'",
        );
        expect(accounts.rows).toHaveLength(1);
        expect(accounts.rows[0].display_name).toBe("E2E User");

        const sessions = await target.pool.query(
          "SELECT ip_address, revoked FROM sessions WHERE account_id = $1",
          [accountId],
        );
        expect(sessions.rows).toHaveLength(1);
        expect(sessions.rows[0].ip_address).toBe("10.0.0.1");
        expect(sessions.rows[0].revoked).toBe(false);
      } finally {
        await dropTestDatabase(target.dbName, target.pool);
      }
    });

    it("post-restore cleanup works after restore", async () => {
      // Seed an active session
      const existing = await sourcePool.query(
        "SELECT id FROM accounts LIMIT 1",
      );
      if (existing.rows.length === 0) {
        await sourcePool.query(
          `INSERT INTO accounts (oidc_issuer, oidc_subject, username, display_name)
           VALUES ('https://keycloak/realms/e2e', 'user-cleanup', 'cleanup-user', 'Cleanup')`,
        );
      }

      const acc = await sourcePool.query("SELECT id FROM accounts LIMIT 1");
      const accountId = acc.rows[0].id;

      await sourcePool.query(
        `INSERT INTO sessions (account_id, ip_address, user_agent, revoked)
         VALUES ($1, '10.0.0.2', 'cleanup-agent', false)`,
        [accountId],
      );

      // Backup source
      const dumpPath = join(tmpDir, "auth_db_cleanup.dump");
      await pgDump({ connectionUrl: sourceUrl, outputPath: dumpPath });

      // Restore into fresh DB
      const target = await createTestDatabase("backup_e2e_cleanup");
      try {
        await pgRestore({
          connectionUrl: target.url,
          inputPath: dumpPath,
          noOwner: true,
        });

        // Verify active sessions exist
        const before = await target.pool.query(
          "SELECT count(*) FROM sessions WHERE revoked = false",
        );
        expect(Number(before.rows[0].count)).toBeGreaterThan(0);

        // Run post-restore cleanup
        const cleanup = await runPostRestoreCleanup(target.pool);
        expect(cleanup.sessionsRevoked).toBeGreaterThan(0);

        // Verify all sessions revoked
        const after = await target.pool.query(
          "SELECT count(*) FROM sessions WHERE revoked = false",
        );
        expect(Number(after.rows[0].count)).toBe(0);
      } finally {
        await dropTestDatabase(target.dbName, target.pool);
      }
    });

    it("storage manifest round-trips alongside dump files", async () => {
      const storage = new LocalStorageBackend(tmpDir);
      const backupDir = await storage.initBackupDir("2026-04-02T10-00-00Z");

      // Create a real dump
      const dumpPath = storage.getAbsolutePath(backupDir, "auth_db.dump");
      const dumpResult = await pgDump({
        connectionUrl: sourceUrl,
        outputPath: dumpPath,
      });

      // Write manifest
      await storage.writeManifest(backupDir, {
        version: 1,
        createdAt: "2026-04-02T10:00:00.000Z",
        label: null,
        targets: {
          auth_db: {
            file: "auth_db.dump",
            sizeBytes: dumpResult.sizeBytes,
            durationMs: dumpResult.durationMs,
          },
        },
        skipped: [],
        errors: [],
      });

      // Verify structure
      expect(existsSync(dumpPath)).toBe(true);
      expect(existsSync(join(backupDir, "manifest.json"))).toBe(true);

      const manifest = await storage.readManifest(backupDir);
      expect(manifest.targets.auth_db?.sizeBytes).toBe(dumpResult.sizeBytes);

      // Verify list
      const backups = await storage.listBackups();
      expect(backups).toContain("2026-04-02T10-00-00Z");
    });

    it("migrations run successfully after restore", async () => {
      // Dump, restore, then run migrations on restored DB
      const dumpPath = join(tmpDir, "auth_db_migrate.dump");
      await pgDump({ connectionUrl: sourceUrl, outputPath: dumpPath });

      const target = await createTestDatabase("backup_e2e_migrate");
      try {
        await pgRestore({
          connectionUrl: target.url,
          inputPath: dumpPath,
          noOwner: true,
        });

        // Migrations should be idempotent — running again should succeed
        await runMigrations(target.pool, AUTH_MIGRATIONS_DIR, LOCK_ID + 1);

        // Verify _migrations table exists and has entries
        const migrations = await target.pool.query(
          "SELECT count(*) FROM _migrations",
        );
        expect(Number(migrations.rows[0].count)).toBeGreaterThan(0);
      } finally {
        await dropTestDatabase(target.dbName, target.pool);
      }
    });
  });

  // Cleanup tmp dirs
  afterAll(async () => {
    // Clean up any remaining temp dirs
    if (tmpDir && existsSync(tmpDir)) {
      await rm(tmpDir, { recursive: true, force: true });
    }
  });
});
