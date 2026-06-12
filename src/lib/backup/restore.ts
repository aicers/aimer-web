import { join } from "node:path";
import type { Pool } from "pg";
import { customerDbName, customerDbUrl } from "../db/customer-db";
import { runMigrations } from "../db/migrate";
import { log } from "./cli-utils";
import type { BackupConfig } from "./config";
import { pgRestore } from "./dump";
import { restoreOpenBao } from "./openbao";
import { runPostRestoreCleanup } from "./post-restore";
import type { BackupManifest, StorageBackend } from "./storage";

// ---------------------------------------------------------------------------
// Single-target restore functions
// ---------------------------------------------------------------------------

export async function restoreAuth(
  backupFile: string,
  config: BackupConfig,
): Promise<void> {
  log("Restoring auth_db...");
  await pgRestore({
    connectionUrl: config.authDbUrl,
    inputPath: backupFile,
    clean: true,
    noOwner: true,
  });
  log("auth_db restored");
}

export async function restoreAudit(
  backupFile: string,
  config: BackupConfig,
): Promise<void> {
  log("Restoring audit_db...");
  await pgRestore({
    connectionUrl: config.auditDbUrl,
    inputPath: backupFile,
    clean: true,
    noOwner: true,
  });
  log("audit_db restored");
}

export async function restoreFeed(
  backupFile: string,
  config: BackupConfig,
): Promise<void> {
  log("Restoring feed_db...");
  await pgRestore({
    connectionUrl: config.feedDbUrl,
    inputPath: backupFile,
    clean: true,
    noOwner: true,
  });
  log("feed_db restored");
}

export async function restoreCustomer(
  backupFile: string,
  customerId: string,
  config: BackupConfig,
  adminPool: Pool,
): Promise<void> {
  const dbName = customerDbName(customerId);
  const connectionUrl = customerDbUrl(
    config.customerOwnerTemplateUrl,
    customerId,
  );

  const exists = await adminPool.query(
    "SELECT 1 FROM pg_database WHERE datname = $1",
    [dbName],
  );
  if (exists.rows.length === 0) {
    log(`Creating database ${dbName}...`);
    await adminPool.query(`CREATE DATABASE ${dbName}`);
  }

  log(`Restoring customer ${customerId} (${dbName})...`);
  await pgRestore({
    connectionUrl,
    inputPath: backupFile,
    clean: true,
    noOwner: true,
  });
  log(`Customer ${customerId} restored`);
}

export async function restoreOpenBaoStorage(
  backupFile: string,
  config: BackupConfig,
): Promise<void> {
  log("WARNING: Ensure OpenBao is stopped before restoring.");
  log("Restoring OpenBao file storage...");
  await restoreOpenBao(backupFile, config.baoDataDir);
  log(
    "OpenBao file storage restored. Unseal OpenBao before starting aimer-web.",
  );
}

// ---------------------------------------------------------------------------
// Full DR restore
// ---------------------------------------------------------------------------

export interface FullRestoreOptions {
  backupDir: string;
  config: BackupConfig;
  storage: StorageBackend;
  skipPostCleanup: boolean;
  skipMigrations: boolean;
}

export interface FullRestoreResult {
  errors: Array<{ target: string; error: string }>;
}

export async function restoreFull(
  opts: FullRestoreOptions,
): Promise<FullRestoreResult> {
  const { backupDir, config, storage, skipPostCleanup, skipMigrations } = opts;
  const manifest = await storage.readManifest(backupDir);

  log("=== Full Disaster Recovery Restore ===");
  log(`Backup from: ${manifest.createdAt}`);

  return restoreFullFromManifest(
    manifest,
    backupDir,
    config,
    skipPostCleanup,
    skipMigrations,
  );
}

export async function restoreFullFromManifest(
  manifest: BackupManifest,
  backupDir: string,
  config: BackupConfig,
  skipPostCleanup: boolean,
  skipMigrations: boolean,
): Promise<FullRestoreResult> {
  const { Pool } = await import("pg");
  const errors: Array<{ target: string; error: string }> = [];

  // 1. OpenBao
  if (manifest.targets.openbao) {
    const file = join(backupDir, manifest.targets.openbao.file);
    await restoreOpenBaoStorage(file, config);
  } else {
    log("No OpenBao backup in manifest, skipping");
  }

  // 2. auth_db
  if (manifest.targets.auth_db) {
    const file = join(backupDir, manifest.targets.auth_db.file);
    await restoreAuth(file, config);
  } else {
    log("No auth_db backup in manifest, skipping");
  }

  // 3. audit_db
  if (manifest.targets.audit_db) {
    const file = join(backupDir, manifest.targets.audit_db.file);
    await restoreAudit(file, config);
  } else {
    log("No audit_db backup in manifest, skipping");
  }

  // 4. feed_db
  if (manifest.targets.feed_db) {
    const file = join(backupDir, manifest.targets.feed_db.file);
    await restoreFeed(file, config);
  } else {
    log("No feed_db backup in manifest, skipping");
  }

  // 5. customer_dbs
  if (manifest.targets.customers && manifest.targets.customers.length > 0) {
    const adminPool = new Pool({ connectionString: config.adminDbUrl });
    try {
      for (const customer of manifest.targets.customers) {
        const file = join(backupDir, customer.file);
        try {
          await restoreCustomer(file, customer.customerId, config, adminPool);
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          console.error(
            `Customer ${customer.customerId}: restore failed: ${message}`,
          );
          errors.push({
            target: `customer-${customer.customerId}`,
            error: message,
          });
        }
      }
    } finally {
      await adminPool.end();
    }
  }

  // 6. Post-restore cleanup
  if (!skipPostCleanup && manifest.targets.auth_db) {
    log("Running post-restore cleanup...");
    const authPool = new Pool({ connectionString: config.authDbUrl });
    try {
      const result = await runPostRestoreCleanup(authPool);
      log(
        `Cleanup: ${result.sessionsRevoked} sessions revoked, ` +
          `${result.pendingConnectionsDeleted} pending connections deleted, ` +
          `${result.stagedPayloadsDeleted} staged payloads deleted`,
      );
    } finally {
      await authPool.end();
    }
  }

  // 7. Run migrations
  if (!skipMigrations) {
    log("Running migration runner...");
    const authMigrationsDir = join(process.cwd(), "migrations", "auth");
    const auditMigrationsDir = join(process.cwd(), "migrations", "audit");
    const feedMigrationsDir = join(process.cwd(), "migrations", "feed");

    if (manifest.targets.auth_db) {
      const authPool = new Pool({ connectionString: config.authDbUrl });
      try {
        await runMigrations(authPool, authMigrationsDir, 1000);
        log("auth_db migrations complete");
      } finally {
        await authPool.end();
      }
    }

    if (manifest.targets.audit_db) {
      const auditPool = new Pool({ connectionString: config.auditDbUrl });
      try {
        await runMigrations(auditPool, auditMigrationsDir, 1001);
        log("audit_db migrations complete");
      } finally {
        await auditPool.end();
      }
    }

    if (manifest.targets.feed_db) {
      const feedPool = new Pool({ connectionString: config.feedDbUrl });
      try {
        await runMigrations(feedPool, feedMigrationsDir, 1002);
        log("feed_db migrations complete");
      } finally {
        await feedPool.end();
      }
    }
  }

  log("=== Full restore completed ===");
  if (errors.length > 0) {
    log(`WARNING: ${errors.length} customer restore(s) failed`);
  }
  log("Remember to:");
  log("  1. Restart Keycloak if it was part of the failure");
  log("  2. Unseal OpenBao (if restored)");
  log("  3. Run `pnpm migrate:customers` for customer DB migrations");

  return { errors };
}
