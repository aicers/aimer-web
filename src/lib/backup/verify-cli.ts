import { join } from "node:path";
import { log, parseKvArgs } from "./cli-utils";
import { loadBackupConfig } from "./config";
import { checkPgToolsAvailable } from "./dump";
import { type BackupManifest, LocalStorageBackend } from "./storage";
import { verifyCustomerDek, verifyDbRestore } from "./verify";

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

type VerifyTarget = "auth" | "audit" | "feed" | "customer" | "all";

function parseArgs(argv: string[]) {
  const args = parseKvArgs(
    argv,
    new Set(["backup-dir", "target", "customer-id"]),
    new Set(),
  );

  const backupDir = args.get("backup-dir");
  if (!backupDir) {
    console.error("--backup-dir is required");
    process.exit(2);
  }

  const targetVal = args.get("target") ?? "all";
  if (!["auth", "audit", "feed", "customer", "all"].includes(targetVal)) {
    console.error(`Invalid target: ${targetVal}`);
    process.exit(2);
  }

  return {
    backupDir,
    target: targetVal as VerifyTarget,
    customerId: args.get("customer-id"),
  };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const args = parseArgs(process.argv.slice(2));

  const config = loadBackupConfig();
  // Verification only needs adminDbUrl (for temp database creation)
  // — it does not use customer owner URLs or OpenBao paths.
  if (!config.adminDbUrl) {
    console.error(
      "DATABASE_ADMIN_URL or DATABASE_URL is required for verification",
    );
    process.exit(2);
  }
  await checkPgToolsAvailable();

  const storage = new LocalStorageBackend(config.backupDir);
  let manifest: BackupManifest;
  try {
    manifest = await storage.readManifest(args.backupDir);
  } catch {
    console.error(`Cannot read manifest.json from ${args.backupDir}`);
    process.exit(2);
  }

  log("=== Backup Verification Drill ===");
  log(`Backup: ${manifest.createdAt}`);

  const results: Array<{ target: string; status: "pass" | "warn" | "fail" }> =
    [];
  const targets =
    args.target === "all"
      ? ["auth", "audit", "feed", "customer"]
      : [args.target];

  for (const t of targets) {
    switch (t) {
      case "auth": {
        if (!manifest.targets.auth_db) {
          log("auth_db: not in manifest, skipping");
          break;
        }
        const file = join(args.backupDir, manifest.targets.auth_db.file);
        const authOk = await verifyDbRestore(
          "auth_db",
          file,
          config.adminDbUrl,
          join(process.cwd(), "migrations", "auth"),
          9100,
          "_migrations",
        );
        results.push({
          target: "auth_db",
          status: authOk ? "pass" : "fail",
        });
        break;
      }

      case "audit": {
        if (!manifest.targets.audit_db) {
          log("audit_db: not in manifest, skipping");
          break;
        }
        const file = join(args.backupDir, manifest.targets.audit_db.file);
        const auditOk = await verifyDbRestore(
          "audit_db",
          file,
          config.adminDbUrl,
          join(process.cwd(), "migrations", "audit"),
          9101,
          "_migrations",
        );
        results.push({
          target: "audit_db",
          status: auditOk ? "pass" : "fail",
        });
        break;
      }

      case "feed": {
        if (!manifest.targets.feed_db) {
          log("feed_db: not in manifest, skipping");
          break;
        }
        const file = join(args.backupDir, manifest.targets.feed_db.file);
        const feedOk = await verifyDbRestore(
          "feed_db",
          file,
          config.adminDbUrl,
          join(process.cwd(), "migrations", "feed"),
          9102,
          "_migrations",
        );
        results.push({
          target: "feed_db",
          status: feedOk ? "pass" : "fail",
        });
        break;
      }

      case "customer": {
        const customers = manifest.targets.customers ?? [];
        const toVerify = args.customerId
          ? customers.filter((c) => c.customerId === args.customerId)
          : customers;

        if (toVerify.length === 0) {
          if (args.customerId) {
            console.error(`Customer ${args.customerId} not found in manifest`);
            process.exit(2);
          }
          log("No customer backups to verify");
          break;
        }

        for (const c of toVerify) {
          const file = join(args.backupDir, c.file);
          const dbOk = await verifyDbRestore(
            `customer_${c.customerId}`,
            file,
            config.adminDbUrl,
            join(process.cwd(), "migrations", "customer"),
            9200,
            "_migrations",
          );
          results.push({
            target: `customer_${c.customerId}`,
            status: dbOk ? "pass" : "fail",
          });

          const dekResult = await verifyCustomerDek(c.customerId);
          results.push({
            target: `customer_${c.customerId}_dek`,
            status: dekResult,
          });
        }
        break;
      }
    }
  }

  // Summary
  log("\n=== Verification Results ===");
  let hasFail = false;
  let hasWarn = false;
  for (const r of results) {
    const label = r.status.toUpperCase();
    log(`  ${r.target}: ${label}`);
    if (r.status === "fail") hasFail = true;
    if (r.status === "warn") hasWarn = true;
  }

  if (hasFail) {
    console.error("\nVerification drill FAILED");
    process.exit(1);
  }

  if (hasWarn) {
    log("\nVerification drill PASSED with warnings");
    log("Review WARN entries — affected backups may be unrecoverable");
  } else {
    log("\nAll verifications PASSED");
  }
}

main().catch((err) => {
  console.error("Verify CLI failed:", err);
  process.exit(1);
});
