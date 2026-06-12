import { join } from "node:path";
import { Pool } from "pg";
import { runMigrations } from "../db/migrate";
import { log, parseKvArgs } from "./cli-utils";
import {
  type BackupTarget,
  loadBackupConfig,
  validateForTarget,
} from "./config";
import { checkPgToolsAvailable } from "./dump";
import { runPostRestoreCleanup } from "./post-restore";
import {
  restoreAudit,
  restoreAuth,
  restoreCustomer,
  restoreFeed,
  restoreFull,
  restoreOpenBaoStorage,
} from "./restore";
import { LocalStorageBackend } from "./storage";

// ---------------------------------------------------------------------------
// CLI argument parsing
// ---------------------------------------------------------------------------

type RestoreTarget =
  | "auth"
  | "audit"
  | "feed"
  | "customer"
  | "openbao"
  | "full";

interface CliArgs {
  target: RestoreTarget;
  backupFile?: string;
  backupDir?: string;
  customerId?: string;
  skipPostCleanup: boolean;
  skipMigrations: boolean;
  dryRun: boolean;
  confirm: boolean;
}

function parseArgs(argv: string[]): CliArgs {
  const args = parseKvArgs(
    argv,
    new Set(["target", "backup-file", "backup-dir", "customer-id"]),
    new Set(["skip-post-cleanup", "skip-migrations", "dry-run", "confirm"]),
  );

  const targetVal = args.get("target");
  if (
    !targetVal ||
    !["auth", "audit", "feed", "customer", "openbao", "full"].includes(
      targetVal,
    )
  ) {
    console.error(
      "--target is required (auth|audit|feed|customer|openbao|full)",
    );
    process.exit(2);
  }

  return {
    target: targetVal as RestoreTarget,
    backupFile: args.get("backup-file"),
    backupDir: args.get("backup-dir"),
    customerId: args.get("customer-id"),
    skipPostCleanup: args.has("skip-post-cleanup"),
    skipMigrations: args.has("skip-migrations"),
    dryRun: args.has("dry-run"),
    confirm: args.has("confirm"),
  };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const args = parseArgs(process.argv.slice(2));

  // Validation
  if (args.target === "full" && !args.backupDir) {
    console.error("--backup-dir is required for --target=full");
    process.exit(2);
  }
  if (args.target !== "full" && !args.backupFile) {
    console.error("--backup-file is required for single-target restore");
    process.exit(2);
  }
  if (args.target === "customer" && !args.customerId) {
    console.error("--customer-id is required for --target=customer");
    process.exit(2);
  }
  if (!args.dryRun && !args.confirm) {
    console.error(
      "Restore requires --confirm flag (or use --dry-run to validate first)",
    );
    process.exit(2);
  }

  let config: ReturnType<typeof loadBackupConfig>;
  try {
    config = loadBackupConfig();
    // Validate config for single-target restores eagerly.
    // For --target=full, validation is deferred until the manifest is read
    // because restoreFullFromManifest skips targets absent from the manifest.
    if (args.target !== "full") {
      const targetMap: Record<string, BackupTarget> = {
        auth: "auth",
        audit: "audit",
        feed: "feed",
        customer: "customers",
        openbao: "openbao",
      };
      validateForTarget(config, targetMap[args.target]);
    }
  } catch (err) {
    console.error((err as Error).message);
    process.exit(2);
  }

  const { backupFile, backupDir, customerId } = args;

  // Check pg tools for DB restores
  if (["auth", "audit", "feed", "customer", "full"].includes(args.target)) {
    await checkPgToolsAvailable();
  }

  if (args.dryRun) {
    log("DRY RUN — validating backup artifacts...");
    if (args.target === "full" && backupDir) {
      const storage = new LocalStorageBackend(config.backupDir);
      const manifest = await storage.readManifest(backupDir);
      log(`Manifest version: ${manifest.version}`);
      log(`Created at: ${manifest.createdAt}`);
      log(`Targets: ${Object.keys(manifest.targets).join(", ")}`);
      if (manifest.targets.customers) {
        log(`Customers: ${manifest.targets.customers.length}`);
      }
    } else {
      log(`Backup file: ${backupFile}`);
    }
    log("Dry run complete — no changes made");
    return;
  }

  switch (args.target) {
    case "auth": {
      if (!backupFile) break;
      await restoreAuth(backupFile, config);
      if (!args.skipPostCleanup) {
        log("Running post-restore cleanup...");
        const pool = new Pool({ connectionString: config.authDbUrl });
        try {
          await runPostRestoreCleanup(pool);
        } finally {
          await pool.end();
        }
      }
      if (!args.skipMigrations) {
        const pool = new Pool({ connectionString: config.authDbUrl });
        try {
          await runMigrations(
            pool,
            join(process.cwd(), "migrations", "auth"),
            1000,
          );
        } finally {
          await pool.end();
        }
      }
      break;
    }

    case "audit": {
      if (!backupFile) break;
      await restoreAudit(backupFile, config);
      if (!args.skipMigrations) {
        const pool = new Pool({ connectionString: config.auditDbUrl });
        try {
          await runMigrations(
            pool,
            join(process.cwd(), "migrations", "audit"),
            1001,
          );
        } finally {
          await pool.end();
        }
      }
      break;
    }

    case "feed": {
      if (!backupFile) break;
      await restoreFeed(backupFile, config);
      if (!args.skipMigrations) {
        const pool = new Pool({ connectionString: config.feedDbUrl });
        try {
          await runMigrations(
            pool,
            join(process.cwd(), "migrations", "feed"),
            1002,
          );
        } finally {
          await pool.end();
        }
      }
      break;
    }

    case "customer": {
      if (!backupFile || !customerId) break;
      const adminPool = new Pool({ connectionString: config.adminDbUrl });
      try {
        await restoreCustomer(backupFile, customerId, config, adminPool);
      } finally {
        await adminPool.end();
      }
      if (!args.skipMigrations) {
        log(
          "Run `pnpm migrate:customers --customer-id=<id>` to apply migrations",
        );
      }
      break;
    }

    case "openbao":
      if (!backupFile) break;
      await restoreOpenBaoStorage(backupFile, config);
      break;

    case "full": {
      if (!backupDir) break;
      const storage = new LocalStorageBackend(config.backupDir);
      // Validate config based on what the manifest actually contains
      const manifest = await storage.readManifest(backupDir);
      const needed: BackupTarget[] = [];
      if (manifest.targets.auth_db) needed.push("auth");
      if (manifest.targets.audit_db) needed.push("audit");
      if (manifest.targets.feed_db) needed.push("feed");
      if (manifest.targets.customers?.length) needed.push("customers");
      if (manifest.targets.openbao) needed.push("openbao");
      for (const t of needed) {
        validateForTarget(config, t);
      }
      const result = await restoreFull({
        backupDir,
        config,
        storage,
        skipPostCleanup: args.skipPostCleanup,
        skipMigrations: args.skipMigrations,
      });
      if (result.errors.length > 0) {
        console.error(
          `\nRestore completed with ${result.errors.length} error(s):`,
        );
        for (const e of result.errors) {
          console.error(`  ${e.target}: ${e.error}`);
        }
        process.exit(1);
      }
      break;
    }
  }

  log("Restore completed successfully");
}

main().catch((err) => {
  console.error("Restore CLI failed:", err);
  process.exit(1);
});
