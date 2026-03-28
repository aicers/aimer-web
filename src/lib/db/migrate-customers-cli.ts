import { join } from "node:path";
import { Pool } from "pg";
import { decryptDataKey, getTransitConfig } from "../crypto/transit";
import {
  customerDbUrl,
  customerLockId,
  customerTransitKeyName,
  getCustomerOwnerTemplateUrl,
} from "./customer-db";
import type { MigrationContext } from "./migrate";
import { runMigrations } from "./migrate";

async function main() {
  const args = process.argv.slice(2);
  const customerIdFlag = args.find((a) => a.startsWith("--customer-id="));
  const targetCustomerId = customerIdFlag?.split("=")[1];

  const authPool = new Pool({
    connectionString: process.env.DATABASE_URL,
  });

  try {
    let customers: Array<{
      id: string;
      database_status: string;
      wrapped_dek: string | null;
    }>;

    if (targetCustomerId) {
      // Targeted mode: run regardless of database_status (for retries)
      const result = await authPool.query(
        "SELECT id, database_status, wrapped_dek FROM customers WHERE id = $1",
        [targetCustomerId],
      );
      customers = result.rows;
      if (customers.length === 0) {
        console.error(`Customer ${targetCustomerId} not found`);
        process.exit(1);
      }
    } else {
      // Batch mode: only active customers
      const result = await authPool.query(
        "SELECT id, database_status, wrapped_dek FROM customers WHERE database_status = 'active'",
      );
      customers = result.rows;
    }

    const migrationsDir = join(process.cwd(), "migrations", "customer");
    const ownerTemplateUrl = getCustomerOwnerTemplateUrl();

    for (const customer of customers) {
      console.log(
        `Migrating customer ${customer.id} (status: ${customer.database_status})...`,
      );

      const ownerUrl = customerDbUrl(ownerTemplateUrl, customer.id);
      const customerPool = new Pool({ connectionString: ownerUrl });

      try {
        // Build MigrationContext with decryptDek if DEK is available
        let context: MigrationContext | undefined;
        if (customer.wrapped_dek) {
          const transitConfig = getTransitConfig();
          const keyName = customerTransitKeyName(customer.id);
          const wrappedDek = customer.wrapped_dek;
          context = {
            decryptDek: () =>
              decryptDataKey(transitConfig, keyName, wrappedDek),
          };
        }

        await runMigrations(
          customerPool,
          migrationsDir,
          customerLockId(customer.id),
          context,
        );

        // Update status to active on success (for targeted mode retries)
        if (customer.database_status !== "active") {
          await authPool.query(
            "UPDATE customers SET database_status = 'active' WHERE id = $1",
            [customer.id],
          );
        }
        console.log(`Customer ${customer.id}: migrations complete`);
      } catch (err) {
        console.error(
          `Customer ${customer.id}: migration failed:`,
          (err as Error).message,
        );
        await authPool.query(
          "UPDATE customers SET database_status = 'failed' WHERE id = $1",
          [customer.id],
        );
      } finally {
        await customerPool.end();
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
