import "server-only";

import { join } from "node:path";
import { Pool } from "pg";
import type { ActorContext } from "../audit";
import { auditLog } from "../audit";
import { generateDataKey, getTransitConfig } from "../crypto/transit";
import { getAdminUrl } from "./customer-db";
import {
  getGroupOwnerTemplateUrl,
  groupDbName,
  groupDbUrl,
  groupLockId,
  groupTransitKeyName,
} from "./group-db";
import { runMigrations } from "./migrate";

// ---------------------------------------------------------------------------
// Group data-DB provisioning (#507).
//
// Peer of provision-customer.ts. Runs AFTER #506's createGroup() auth-DB
// transaction commits, and the create request awaits it before returning
// (it is NOT fire-and-forget). Mirrors the per-customer model end to end:
// status lifecycle, envelope encryption, idempotent / retry-safe steps.
// ---------------------------------------------------------------------------

/** Injectable dependencies for testing. */
export interface ProvisionGroupDeps {
  adminUrl: string;
  ownerTemplateUrl: string;
  migrationsDir: string;
  generateDek: (keyName: string) => Promise<{ wrappedDek: string }>;
}

export interface ProvisionGroupOptions {
  actorContext?: ActorContext;
  isRetry?: boolean;
}

/**
 * Provision a group database after the auth_db `customer_groups` row has
 * been committed.
 *
 * Steps (mirror provisionCustomerDb):
 * 1. CREATE DATABASE via admin connection (idempotent)
 * 2. Grant schema privileges to the shared subject-DB runtime role
 * 3. Generate DEK via OpenBao Transit and store wrapped_dek (idempotent)
 * 4. Run migrations/group/ migrations
 * 5. Update database_status to 'active'
 *
 * On failure at any step, database_status is set to 'failed' and the DEK
 * is retained for retry.
 */
export async function provisionGroupDb(
  authPool: Pool,
  groupId: string,
  options?: ProvisionGroupOptions,
  deps?: ProvisionGroupDeps,
): Promise<"active" | "failed"> {
  const actorContext = options?.actorContext;
  const isRetry = options?.isRetry ?? false;
  const dbName = groupDbName(groupId);
  const adminUrl = deps?.adminUrl ?? getAdminUrl();
  const ownerTemplateUrl = deps?.ownerTemplateUrl ?? getGroupOwnerTemplateUrl();
  const migrationsDir =
    deps?.migrationsDir ?? join(process.cwd(), "migrations", "group");

  try {
    // Step 1: CREATE DATABASE (idempotent — skips if already exists)
    const adminPool = new Pool({ connectionString: adminUrl });
    try {
      await adminPool
        .query(`SELECT 1 FROM pg_database WHERE datname = '${dbName}'`)
        .then(async (res) => {
          if (res.rows.length === 0) {
            await adminPool.query(
              `CREATE DATABASE ${dbName} OWNER aimer_customer_owner`,
            );
          }
        });
    } finally {
      await adminPool.end();
    }

    // Step 2: Grant schema privileges to the runtime role (idempotent)
    const ownerUrl = groupDbUrl(ownerTemplateUrl, groupId);
    const ownerPool = new Pool({ connectionString: ownerUrl });
    try {
      await ownerPool.query("GRANT USAGE ON SCHEMA public TO aimer_customer");
      await ownerPool.query(
        `GRANT CONNECT ON DATABASE ${dbName} TO aimer_customer`,
      );
    } finally {
      await ownerPool.end();
    }

    // Step 3: Generate DEK and store wrapped form (idempotent — skips if
    // already stored)
    const dekRow = await authPool.query<{ wrapped_dek: string | null }>(
      "SELECT wrapped_dek FROM customer_groups WHERE id = $1",
      [groupId],
    );
    if (!dekRow.rows[0]?.wrapped_dek) {
      let wrappedDek: string;
      if (deps?.generateDek) {
        const result = await deps.generateDek(groupTransitKeyName(groupId));
        wrappedDek = result.wrappedDek;
      } else {
        const transitConfig = getTransitConfig();
        const keyName = groupTransitKeyName(groupId);
        const dataKey = await generateDataKey(transitConfig, keyName);
        // Zero plaintext immediately — provisioning doesn't need it.
        dataKey.plaintext.fill(0);
        wrappedDek = dataKey.wrappedDek;
      }

      await authPool.query(
        "UPDATE customer_groups SET wrapped_dek = $1 WHERE id = $2",
        [wrappedDek, groupId],
      );
    }

    // Step 4: Run group migrations
    const migrationOwnerPool = new Pool({ connectionString: ownerUrl });
    try {
      await runMigrations(
        migrationOwnerPool,
        migrationsDir,
        groupLockId(groupId),
      );
    } finally {
      await migrationOwnerPool.end();
    }

    // Step 5: Update status to active
    await authPool.query(
      "UPDATE customer_groups SET database_status = 'active' WHERE id = $1",
      [groupId],
    );

    if (actorContext) {
      void auditLog({
        actorId: actorContext.actorId,
        authContext: actorContext.authContext,
        action: isRetry ? "group_db.provision_retried" : "group_db.provisioned",
        targetType: "group_db",
        targetId: groupId,
        details: { dbName, outcome: "active" },
        ipAddress: actorContext.ipAddress,
        sid: actorContext.sid,
      });
    }

    return "active";
  } catch (err) {
    console.error(
      `Group ${groupId} provisioning failed:`,
      (err as Error).message,
    );
    await authPool
      .query(
        "UPDATE customer_groups SET database_status = 'failed' WHERE id = $1",
        [groupId],
      )
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
          ? "group_db.provision_retried"
          : "group_db.provision_failed",
        targetType: "group_db",
        targetId: groupId,
        details: {
          dbName,
          outcome: "failed",
          error: (err as Error).message,
        },
        ipAddress: actorContext.ipAddress,
        sid: actorContext.sid,
      });
    }

    return "failed";
  }
}
