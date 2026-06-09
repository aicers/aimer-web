import { join } from "node:path";
import { Pool } from "pg";
import { decryptDataKey, getTransitConfig } from "../crypto/transit";
import {
  getGroupOwnerTemplateUrl,
  groupDbUrl,
  groupLockId,
  groupTransitKeyName,
} from "./group-db";
import type { MigrationContext } from "./migrate";
import { runMigrations } from "./migrate";

// CLI peer of migrate-customers-cli.ts (#507). Applies pending
// migrations/group/ migrations to existing group DBs.
//
//   pnpm migrate:groups                  # batch: all active groups
//   pnpm migrate:groups --group-id=<id>  # targeted: any status (retries)
async function main() {
  const args = process.argv.slice(2);
  const groupIdFlag = args.find((a) => a.startsWith("--group-id="));
  const targetGroupId = groupIdFlag?.split("=")[1];

  const authPool = new Pool({
    connectionString: process.env.DATABASE_URL,
  });

  try {
    let groups: Array<{
      id: string;
      database_status: string;
      wrapped_dek: string | null;
    }>;

    if (targetGroupId) {
      // Targeted mode: run regardless of database_status (for retries)
      const result = await authPool.query(
        "SELECT id, database_status, wrapped_dek FROM customer_groups WHERE id = $1",
        [targetGroupId],
      );
      groups = result.rows;
      if (groups.length === 0) {
        console.error(`Group ${targetGroupId} not found`);
        process.exit(1);
      }
    } else {
      // Batch mode: only active groups
      const result = await authPool.query(
        "SELECT id, database_status, wrapped_dek FROM customer_groups WHERE database_status = 'active'",
      );
      groups = result.rows;
    }

    const migrationsDir = join(process.cwd(), "migrations", "group");
    const ownerTemplateUrl = getGroupOwnerTemplateUrl();

    for (const group of groups) {
      console.log(
        `Migrating group ${group.id} (status: ${group.database_status})...`,
      );

      const ownerUrl = groupDbUrl(ownerTemplateUrl, group.id);
      const groupPool = new Pool({ connectionString: ownerUrl });

      try {
        // Build MigrationContext with decryptDek if DEK is available
        let context: MigrationContext | undefined;
        if (group.wrapped_dek) {
          const transitConfig = getTransitConfig();
          const keyName = groupTransitKeyName(group.id);
          const wrappedDek = group.wrapped_dek;
          context = {
            decryptDek: () =>
              decryptDataKey(transitConfig, keyName, wrappedDek),
          };
        }

        await runMigrations(
          groupPool,
          migrationsDir,
          groupLockId(group.id),
          context,
        );

        // Update status to active on success (for targeted mode retries)
        if (group.database_status !== "active") {
          if (!group.wrapped_dek) {
            console.error(
              `Group ${group.id}: migrations succeeded but wrapped_dek is missing. ` +
                "Re-run provisioning to generate a DEK before marking as active.",
            );
          } else {
            await authPool.query(
              "UPDATE customer_groups SET database_status = 'active' WHERE id = $1",
              [group.id],
            );
          }
        }
        console.log(`Group ${group.id}: migrations complete`);
      } catch (err) {
        console.error(
          `Group ${group.id}: migration failed:`,
          (err as Error).message,
        );
        await authPool.query(
          "UPDATE customer_groups SET database_status = 'failed' WHERE id = $1",
          [group.id],
        );
      } finally {
        await groupPool.end();
      }
    }
  } finally {
    await authPool.end();
  }
}

main().catch((err) => {
  console.error("Migration CLI failed:", err);
  process.exit(1);
});
