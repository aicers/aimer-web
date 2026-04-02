import { Pool } from "pg";
import { decryptDataKey, getTransitConfig } from "../crypto/transit";
import { runMigrations } from "../db/migrate";
import { log } from "./cli-utils";
import { pgRestore } from "./dump";

// ---------------------------------------------------------------------------
// Verification helpers
// ---------------------------------------------------------------------------

/**
 * Restore a backup into a temporary database, run migrations, and verify
 * that a basic data read succeeds. The temporary database is always dropped
 * afterwards.
 *
 * @returns true if the verification passed, false otherwise.
 */
export async function verifyDbRestore(
  label: string,
  backupFile: string,
  adminUrl: string,
  migrationsDir: string,
  lockId: number,
  verifyTable: string,
): Promise<boolean> {
  const safeLabel = label.replace(/[^a-zA-Z0-9_]/g, "_");
  const tempDbName = `verify_${safeLabel}_${Date.now()}`;
  const adminPool = new Pool({ connectionString: adminUrl });

  try {
    await adminPool.query(`CREATE DATABASE ${tempDbName}`);
    const tempUrl = adminUrl.replace(/\/[^/?]+(\?|$)/, `/${tempDbName}$1`);
    const tempPool = new Pool({ connectionString: tempUrl });

    try {
      log(`  Restoring ${label} into ${tempDbName}...`);
      await pgRestore({
        connectionUrl: tempUrl,
        inputPath: backupFile,
        noOwner: true,
      });

      log(`  Running migrations for ${label}...`);
      await runMigrations(tempPool, migrationsDir, lockId);

      const result = await tempPool.query(
        `SELECT count(*) FROM ${verifyTable}`,
      );
      log(`  ${label}: ${verifyTable} has ${result.rows[0].count} row(s) — OK`);

      return true;
    } finally {
      tempPool.on("error", () => {});
      await adminPool.query(`
        SELECT pg_terminate_backend(pid)
        FROM pg_stat_activity
        WHERE datname = '${tempDbName}' AND pid <> pg_backend_pid()
      `);
      await tempPool.end();
      await adminPool.query(`DROP DATABASE IF EXISTS ${tempDbName}`);
    }
  } catch (err) {
    console.error(`  ${label}: FAILED — ${(err as Error).message}`);
    await adminPool
      .query(`DROP DATABASE IF EXISTS ${tempDbName}`)
      .catch(() => {});
    return false;
  } finally {
    await adminPool.end();
  }
}

/**
 * Verify that a customer's wrapped DEK can be unwrapped via OpenBao Transit.
 *
 * @returns true if DEK unwrap succeeded (or no DEK exists), false on failure.
 */
export type DekVerifyResult = "pass" | "warn" | "fail";

/**
 * Verify that a customer's wrapped DEK can be unwrapped via OpenBao Transit.
 *
 * @returns "pass" if DEK unwrap succeeded, "warn" if no DEK exists
 *          (customer may have been deleted or not yet provisioned),
 *          "fail" on unwrap error.
 */
export async function verifyCustomerDek(
  customerId: string,
  authDbUrl?: string,
): Promise<DekVerifyResult> {
  try {
    const transitConfig = getTransitConfig();
    const connectionString =
      authDbUrl ??
      process.env.DATABASE_MIGRATION_URL ??
      process.env.DATABASE_URL;
    const authPool = new Pool({ connectionString });

    try {
      const result = await authPool.query(
        "SELECT wrapped_dek FROM customers WHERE id = $1",
        [customerId],
      );
      if (result.rows.length === 0) {
        log(
          `  Customer ${customerId}: WARNING — customer row not found in auth_db, backup may be unrecoverable`,
        );
        return "warn";
      }
      if (!result.rows[0].wrapped_dek) {
        log(
          `  Customer ${customerId}: WARNING — no wrapped DEK found, backup may be unrecoverable`,
        );
        return "warn";
      }

      const keyName = `customer-${customerId}`;
      await decryptDataKey(transitConfig, keyName, result.rows[0].wrapped_dek);
      log(`  Customer ${customerId}: DEK unwrap — OK`);
      return "pass";
    } finally {
      await authPool.end();
    }
  } catch (err) {
    console.error(
      `  Customer ${customerId}: DEK unwrap FAILED — ${(err as Error).message}`,
    );
    return "fail";
  }
}
