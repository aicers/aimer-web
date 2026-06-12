import { runBackup } from "./backup";
import { log, parseKvArgs } from "./cli-utils";
import {
  type BackupConfig,
  type BackupTarget,
  loadBackupConfig,
  validateForTarget,
} from "./config";
import { checkPgToolsAvailable } from "./dump";
import { LocalStorageBackend } from "./storage";

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function parseArgs(argv: string[]) {
  const args = parseKvArgs(
    argv,
    new Set(["target", "customer-id", "output-dir", "label"]),
    new Set(),
  );

  const targetVal = args.get("target");
  if (
    !targetVal ||
    !["auth", "audit", "feed", "customers", "openbao", "all"].includes(
      targetVal,
    )
  ) {
    console.error(
      "--target is required (auth|audit|feed|customers|openbao|all)",
    );
    process.exit(2);
  }

  return {
    target: targetVal as BackupTarget | "all",
    customerId: args.get("customer-id"),
    outputDir: args.get("output-dir"),
    label: args.get("label"),
  };
}

async function main() {
  const { target, customerId, outputDir, label } = parseArgs(
    process.argv.slice(2),
  );

  let config: BackupConfig;
  try {
    config = loadBackupConfig();
    if (outputDir) config.backupDir = outputDir;
    validateForTarget(config, target);
  } catch (err) {
    console.error((err as Error).message);
    process.exit(2);
  }

  const needsPgTools =
    target === "all" || ["auth", "audit", "feed", "customers"].includes(target);
  if (needsPgTools) {
    try {
      await checkPgToolsAvailable();
    } catch (err) {
      console.error((err as Error).message);
      process.exit(2);
    }
  }

  const storage = new LocalStorageBackend(config.backupDir);
  const targets: BackupTarget[] =
    target === "all"
      ? ["auth", "audit", "feed", "customers", "openbao"]
      : [target];

  const result = await runBackup({
    config,
    storage,
    targets,
    customerId,
    label,
  });

  if (result.manifest.errors.length > 0) {
    console.error(
      `\nCompleted with ${result.manifest.errors.length} error(s):`,
    );
    for (const e of result.manifest.errors) {
      console.error(`  ${e.target}: ${e.error}`);
    }
    process.exit(1);
  }

  log("Backup completed successfully");
}

main().catch((err) => {
  console.error("Backup CLI failed:", err);
  process.exit(1);
});
