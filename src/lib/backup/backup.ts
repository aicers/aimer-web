import type { Pool } from "pg";
import { customerDbName, customerDbUrl } from "../db/customer-db";
import { log } from "./cli-utils";
import type { BackupConfig, BackupTarget } from "./config";
import { pgDump } from "./dump";
import {
  backupDirName,
  customerDumpFileName,
  dbDumpFileName,
  openbaoDumpFileName,
} from "./naming";
import { backupOpenBao } from "./openbao";
import { purgeExpiredBackups } from "./retention";
import type {
  BackupManifest,
  CustomerBackupMeta,
  StorageBackend,
} from "./storage";

// ---------------------------------------------------------------------------
// Individual target backups
// ---------------------------------------------------------------------------

export async function backupAuthDb(
  config: BackupConfig,
  backupDir: string,
  storage: StorageBackend,
): Promise<BackupManifest["targets"]["auth_db"]> {
  const fileName = dbDumpFileName("auth");
  const outputPath = storage.getAbsolutePath(backupDir, fileName);

  log("Backing up auth_db...");
  const result = await pgDump({
    connectionUrl: config.authDbUrl,
    outputPath,
  });
  log(`auth_db: ${result.sizeBytes} bytes in ${result.durationMs}ms`);

  return { file: fileName, ...result };
}

export async function backupAuditDb(
  config: BackupConfig,
  backupDir: string,
  storage: StorageBackend,
): Promise<BackupManifest["targets"]["audit_db"]> {
  const fileName = dbDumpFileName("audit");
  const outputPath = storage.getAbsolutePath(backupDir, fileName);

  log("Backing up audit_db...");
  const result = await pgDump({
    connectionUrl: config.auditDbUrl,
    outputPath,
  });
  log(`audit_db: ${result.sizeBytes} bytes in ${result.durationMs}ms`);

  return { file: fileName, ...result };
}

export interface BackupCustomerDbsOptions {
  config: BackupConfig;
  backupDir: string;
  storage: StorageBackend;
  singleCustomerId?: string;
  authPool: Pool;
  adminPool: Pool;
}

export interface BackupCustomerDbsResult {
  customers: CustomerBackupMeta[];
  skipped: string[];
  errors: Array<{ target: string; error: string }>;
}

export async function backupCustomerDbs(
  opts: BackupCustomerDbsOptions,
): Promise<BackupCustomerDbsResult> {
  const { config, backupDir, storage, singleCustomerId, authPool, adminPool } =
    opts;
  const customers: CustomerBackupMeta[] = [];
  const skipped: string[] = [];
  const errors: Array<{ target: string; error: string }> = [];

  let rows: Array<{ id: string; database_status: string; status: string }>;

  if (singleCustomerId) {
    const result = await authPool.query(
      "SELECT id, database_status, status FROM customers WHERE id = $1",
      [singleCustomerId],
    );
    rows = result.rows;
    if (rows.length === 0) {
      throw new Error(`Customer ${singleCustomerId} not found`);
    }
  } else {
    const result = await authPool.query(
      `SELECT id, database_status, status FROM customers
       WHERE database_status IN ('active', 'failed')`,
    );
    rows = result.rows;
  }

  log(`Found ${rows.length} customer(s) to backup`);

  for (const row of rows) {
    const dbName = customerDbName(row.id);
    const targetLabel = `customer-${row.id}`;

    const exists = await adminPool.query(
      "SELECT 1 FROM pg_database WHERE datname = $1",
      [dbName],
    );

    if (exists.rows.length === 0) {
      log(
        `WARNING: Customer ${row.id} (database_status=${row.database_status}): ` +
          `database ${dbName} does not exist, skipping`,
      );
      skipped.push(targetLabel);
      continue;
    }

    const fileName = `customers/${customerDumpFileName(row.id)}`;
    const outputPath = storage.getAbsolutePath(backupDir, fileName);
    const connectionUrl = customerDbUrl(
      config.customerOwnerTemplateUrl,
      row.id,
    );

    try {
      log(`Backing up customer ${row.id} (${dbName})...`);
      const result = await pgDump({ connectionUrl, outputPath });
      customers.push({
        customerId: row.id,
        file: fileName,
        ...result,
      });
      log(
        `customer ${row.id}: ${result.sizeBytes} bytes in ${result.durationMs}ms`,
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`customer ${row.id}: backup failed: ${message}`);
      errors.push({ target: targetLabel, error: message });
    }
  }

  return { customers, skipped, errors };
}

export async function backupOpenBaoStorage(
  config: BackupConfig,
  backupDir: string,
  storage: StorageBackend,
): Promise<BackupManifest["targets"]["openbao"]> {
  const fileName = `openbao/${openbaoDumpFileName()}`;
  const outputPath = storage.getAbsolutePath(backupDir, fileName);

  log("Backing up OpenBao file storage...");
  const result = await backupOpenBao(config.baoDataDir, outputPath);
  log(`OpenBao: ${result.sizeBytes} bytes in ${result.durationMs}ms`);

  return { file: fileName, ...result };
}

// ---------------------------------------------------------------------------
// Full backup orchestration
// ---------------------------------------------------------------------------

export interface RunBackupOptions {
  config: BackupConfig;
  storage: StorageBackend;
  targets: BackupTarget[];
  customerId?: string;
  label?: string;
  now?: Date;
  /** Injected pools for testability. Created internally if not provided. */
  authPool?: Pool;
  adminPool?: Pool;
}

export interface RunBackupResult {
  manifest: BackupManifest;
  backupDir: string;
  purgeDeleted: string[];
}

export async function runBackup(
  opts: RunBackupOptions,
): Promise<RunBackupResult> {
  const { config, storage, targets, customerId, label } = opts;
  const now = opts.now ?? new Date();
  const dirName = backupDirName(now, label);
  const backupDir = await storage.initBackupDir(dirName);

  log(`Backup directory: ${backupDir}`);

  const manifest: BackupManifest = {
    version: 1,
    createdAt: now.toISOString(),
    label: label ?? null,
    targets: {},
    skipped: [],
    errors: [],
  };

  for (const t of targets) {
    try {
      switch (t) {
        case "auth":
          manifest.targets.auth_db = await backupAuthDb(
            config,
            backupDir,
            storage,
          );
          break;
        case "audit":
          manifest.targets.audit_db = await backupAuditDb(
            config,
            backupDir,
            storage,
          );
          break;
        case "customers": {
          const { Pool } = await import("pg");
          const authPool =
            opts.authPool ?? new Pool({ connectionString: config.authDbUrl });
          const adminPool =
            opts.adminPool ?? new Pool({ connectionString: config.adminDbUrl });
          try {
            const result = await backupCustomerDbs({
              config,
              backupDir,
              storage,
              singleCustomerId: customerId,
              authPool,
              adminPool,
            });
            manifest.targets.customers = result.customers;
            manifest.skipped.push(...result.skipped);
            manifest.errors.push(...result.errors);
          } finally {
            if (!opts.authPool) await authPool.end();
            if (!opts.adminPool) await adminPool.end();
          }
          break;
        }
        case "openbao":
          manifest.targets.openbao = await backupOpenBaoStorage(
            config,
            backupDir,
            storage,
          );
          break;
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`${t}: backup failed: ${message}`);
      manifest.errors.push({ target: t, error: message });
    }
  }

  await storage.writeManifest(backupDir, manifest);
  log(`Manifest written to ${backupDir}/manifest.json`);

  // Run retention purge
  log("Running retention purge...");
  const purge = await purgeExpiredBackups(
    storage,
    config.retentionDays,
    config.auditRetentionDays,
  );
  if (purge.deleted.length > 0) {
    log(`Purged ${purge.deleted.length} expired backup(s)`);
  }

  return { manifest, backupDir, purgeDeleted: purge.deleted };
}
