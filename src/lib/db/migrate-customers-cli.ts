import { join } from "node:path";
import { Pool } from "pg";
import { runMigrations } from "./migrate";

const LOCK_ID_CUSTOMER_BASE = 2000;

async function main() {
  const args = process.argv.slice(2);
  const customerIdFlag = args.find((a) => a.startsWith("--customer-id="));
  const targetCustomerId = customerIdFlag?.split("=")[1];

  const authPool = new Pool({
    connectionString: process.env.DATABASE_URL,
  });

  try {
    let customers: Array<{
      id: number;
      database_url: string;
      database_status: string;
    }>;

    if (targetCustomerId) {
      // Targeted mode: run regardless of database_status
      const result = await authPool.query(
        "SELECT id, database_url, database_status FROM customers WHERE id = $1",
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
        "SELECT id, database_url, database_status FROM customers WHERE database_status = 'active'",
      );
      customers = result.rows;
    }

    const migrationsDir = join(process.cwd(), "migrations", "customer");

    for (const customer of customers) {
      console.log(
        `Migrating customer ${customer.id} (status: ${customer.database_status})...`,
      );
      const customerPool = new Pool({
        connectionString: customer.database_url,
      });
      try {
        await runMigrations(
          customerPool,
          migrationsDir,
          LOCK_ID_CUSTOMER_BASE + customer.id,
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
