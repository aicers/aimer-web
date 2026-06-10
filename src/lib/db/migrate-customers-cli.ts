import { join } from "node:path";
import { Pool } from "pg";
import { reconcileGroupsForCustomer } from "../groups/lifecycle";
import {
  customerDbUrl,
  customerLockId,
  getCustomerOwnerTemplateUrl,
} from "./customer-db";
import { runMigrations } from "./migrate";

// Group lifecycle (#510): a `database_status` write here can flip a member
// customer between operable and non-operable, so the groups it belongs to are
// re-evaluated (suspend / resume / auto-delete). System-initiated, so the
// audit actor is `system`. NOTE: pulling in `lifecycle.ts` transitively loads
// the `server-only`-tagged audit module, so this CLI must run via
// `tsx --conditions=react-server` (wired in package.json) — that condition
// resolves `server-only` to its no-op, as the Next.js server bundle does.
const SYSTEM_ACTOR = { actorId: "system", authContext: "admin" } as const;

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
        await runMigrations(
          customerPool,
          migrationsDir,
          customerLockId(customer.id),
        );

        // Update status to active on success (for targeted mode retries)
        if (customer.database_status !== "active") {
          if (!customer.wrapped_dek) {
            console.error(
              `Customer ${customer.id}: migrations succeeded but wrapped_dek is missing. ` +
                "Re-run provisioning to generate a DEK before marking as active.",
            );
          } else {
            await authPool.query(
              "UPDATE customers SET database_status = 'active' WHERE id = $1",
              [customer.id],
            );
            await reconcileGroupsForCustomer(authPool, customer.id, {
              actorContext: SYSTEM_ACTOR,
            });
          }
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
        await reconcileGroupsForCustomer(authPool, customer.id, {
          actorContext: SYSTEM_ACTOR,
        });
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
