import "server-only";

import { join } from "node:path";
import { Pool } from "pg";
import type { ActorContext } from "../audit";
import { auditLog } from "../audit";
import { generateDataKey, getTransitConfig } from "../crypto/transit";
import {
  customerDbName,
  customerDbUrl,
  customerLockId,
  customerTransitKeyName,
  getAdminUrl,
  getCustomerOwnerTemplateUrl,
} from "./customer-db";
import { runMigrations } from "./migrate";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Injectable dependencies for testing. */
export interface ProvisionDeps {
  adminUrl: string;
  ownerTemplateUrl: string;
  migrationsDir: string;
  generateDek: (keyName: string) => Promise<{ wrappedDek: string }>;
}

export interface ProvisionOptions {
  actorContext?: ActorContext;
  isRetry?: boolean;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Provision a customer database after the auth_db customer row has been
 * committed.
 *
 * Steps:
 * 1. CREATE DATABASE via admin connection
 * 2. Grant schema privileges to owner/runtime roles
 * 3. Generate DEK via OpenBao Transit and store wrapped_dek
 * 4. Run customer migrations (with MigrationContext)
 * 5. Update database_status to 'active'
 *
 * On failure at any step, database_status is set to 'failed' and the
 * DEK is retained for retry.
 */
export async function provisionCustomerDb(
  authPool: Pool,
  customerId: string,
  options?: ProvisionOptions,
  deps?: ProvisionDeps,
): Promise<"active" | "failed"> {
  const actorContext = options?.actorContext;
  const isRetry = options?.isRetry ?? false;
  const dbName = customerDbName(customerId);
  const adminUrl = deps?.adminUrl ?? getAdminUrl();
  const ownerTemplateUrl =
    deps?.ownerTemplateUrl ?? getCustomerOwnerTemplateUrl();
  const migrationsDir =
    deps?.migrationsDir ?? join(process.cwd(), "migrations", "customer");

  try {
    // Step 1: CREATE DATABASE
    const adminPool = new Pool({ connectionString: adminUrl });
    try {
      await adminPool.query(
        `CREATE DATABASE ${dbName} OWNER aimer_customer_owner`,
      );
    } finally {
      await adminPool.end();
    }

    // Step 2: Grant schema privileges to customer roles
    const ownerUrl = customerDbUrl(ownerTemplateUrl, customerId);
    const ownerPool = new Pool({ connectionString: ownerUrl });
    try {
      await ownerPool.query("GRANT USAGE ON SCHEMA public TO aimer_customer");
      await ownerPool.query(
        `GRANT CONNECT ON DATABASE ${dbName} TO aimer_customer`,
      );
    } finally {
      await ownerPool.end();
    }

    // Step 3: Generate DEK and store wrapped form
    let wrappedDek: string;
    if (deps?.generateDek) {
      const result = await deps.generateDek(customerTransitKeyName(customerId));
      wrappedDek = result.wrappedDek;
    } else {
      const transitConfig = getTransitConfig();
      const keyName = customerTransitKeyName(customerId);
      const dataKey = await generateDataKey(transitConfig, keyName);
      // Zero plaintext immediately — provisioning doesn't need it.
      dataKey.plaintext.fill(0);
      wrappedDek = dataKey.wrappedDek;
    }

    await authPool.query(
      "UPDATE customers SET wrapped_dek = $1 WHERE id = $2",
      [wrappedDek, customerId],
    );

    // Step 4: Run customer migrations
    const migrationOwnerPool = new Pool({ connectionString: ownerUrl });
    try {
      await runMigrations(
        migrationOwnerPool,
        migrationsDir,
        customerLockId(customerId),
      );
    } finally {
      await migrationOwnerPool.end();
    }

    // Step 5: Update status to active
    await authPool.query(
      "UPDATE customers SET database_status = 'active' WHERE id = $1",
      [customerId],
    );

    if (actorContext) {
      void auditLog({
        actorId: actorContext.actorId,
        authContext: actorContext.authContext,
        action: isRetry
          ? "customer_db.provision_retried"
          : "customer_db.provisioned",
        targetType: "customer_db",
        targetId: customerId,
        details: { dbName, outcome: "active" },
        ipAddress: actorContext.ipAddress,
        sid: actorContext.sid,
        customerId,
      });
    }

    return "active";
  } catch (err) {
    console.error(
      `Customer ${customerId} provisioning failed:`,
      (err as Error).message,
    );
    await authPool
      .query("UPDATE customers SET database_status = 'failed' WHERE id = $1", [
        customerId,
      ])
      .catch((updateErr) => {
        console.error(
          "Failed to update database_status to 'failed':",
          (updateErr as Error).message,
        );
      });

    if (actorContext) {
      void auditLog({
        actorId: actorContext.actorId,
        authContext: actorContext.authContext,
        action: isRetry
          ? "customer_db.provision_retried"
          : "customer_db.provision_failed",
        targetType: "customer_db",
        targetId: customerId,
        details: {
          dbName,
          outcome: "failed",
          error: (err as Error).message,
        },
        ipAddress: actorContext.ipAddress,
        sid: actorContext.sid,
        customerId,
      });
    }

    return "failed";
  }
}
