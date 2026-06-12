import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { Pool, type PoolClient } from "pg";

const LOCK_ID_AUTH = 1000;
const LOCK_ID_AUDIT = 1001;
const LOCK_ID_FEED = 1002;

interface MigrationRow {
  version: string;
  checksum: string;
}

export interface MigrationFile {
  version: string;
  name: string;
  path: string;
}

async function ensureMigrationsTable(client: PoolClient): Promise<void> {
  await client.query(`
    CREATE TABLE IF NOT EXISTS _migrations (
      version    TEXT PRIMARY KEY,
      name       TEXT NOT NULL,
      checksum   TEXT NOT NULL,
      applied_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);
}

async function getAppliedMigrations(
  client: PoolClient,
): Promise<Map<string, string>> {
  const result = await client.query<MigrationRow>(
    "SELECT version, checksum FROM _migrations ORDER BY version",
  );
  return new Map(result.rows.map((r) => [r.version, r.checksum]));
}

export function computeChecksum(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

export async function listMigrationFiles(
  dir: string,
): Promise<MigrationFile[]> {
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch {
    return [];
  }

  return entries
    .filter((f) => /^\d{4}_.*\.sql$/.test(f))
    .sort()
    .map((f) => {
      const match = f.match(/^(\d{4})_(.+)\.sql$/);
      if (!match) throw new Error(`Invalid migration filename: ${f}`);
      return {
        version: match[1],
        name: match[2],
        path: join(dir, f),
      };
    });
}

async function applySqlMigration(
  client: PoolClient,
  migration: MigrationFile,
  content: string,
  checksum: string,
): Promise<void> {
  await client.query("SAVEPOINT migration");
  try {
    await client.query(content);
    await client.query("RELEASE SAVEPOINT migration");
  } catch (err) {
    await client.query("ROLLBACK TO SAVEPOINT migration");
    throw err;
  }

  await client.query(
    "INSERT INTO _migrations (version, name, checksum) VALUES ($1, $2, $3)",
    [migration.version, migration.name, checksum],
  );
}

// Group lifecycle (#510): the startup customer migrations below flip a member
// customer from operable to `database_status = 'failed'` — exactly the
// member-operability transition that should suspend the groups it belongs to.
// Reconcile those groups synchronously here so generation pauses immediately
// rather than waiting for the periodic sweep, matching the other
// `database_status` writers (`provision-customer.ts`, `migrate-customers-cli`).
// System-initiated, so the audit actor is `system`.
const STARTUP_ACTOR = { actorId: "system", authContext: "admin" } as const;

async function reconcileCustomerGroupsAfterFailure(
  authPool: Pool,
  customerId: string,
): Promise<void> {
  // Dynamic import keeps this module usable from plain Node tooling without
  // eagerly pulling the `server-only`-tagged audit chain, mirroring the
  // other dynamic imports in the startup path. Best-effort: a reconcile
  // failure must not abort the remaining startup migrations.
  try {
    const { reconcileGroupsForCustomer } = await import("../groups/lifecycle");
    await reconcileGroupsForCustomer(authPool, customerId, {
      actorContext: STARTUP_ACTOR,
    });
  } catch (err) {
    console.error(
      `Customer ${customerId}: group reconcile after failed status errored:`,
      (err as Error).message,
    );
  }
}

export async function runMigrations(
  pool: Pool,
  migrationsDir: string,
  lockId: number,
): Promise<void> {
  const client = await pool.connect();
  try {
    // Acquire advisory lock to prevent concurrent migration runners
    await client.query("SELECT pg_advisory_lock($1)", [lockId]);

    try {
      await ensureMigrationsTable(client);
      const applied = await getAppliedMigrations(client);
      const files = await listMigrationFiles(migrationsDir);

      for (const file of files) {
        const content = await readFile(file.path, "utf-8");
        const checksum = computeChecksum(content);

        if (applied.has(file.version)) {
          // Map.has() check above guarantees the value exists
          const storedChecksum = applied.get(file.version) as string;
          if (storedChecksum !== checksum) {
            throw new Error(
              `Checksum mismatch for migration ${file.version}_${file.name}: ` +
                `expected ${storedChecksum}, got ${checksum}. ` +
                "Applied migrations must not be modified.",
            );
          }
          continue; // Already applied
        }

        // Wrap in a transaction for atomicity
        await client.query("BEGIN");
        try {
          await applySqlMigration(client, file, content, checksum);
          await client.query("COMMIT");
        } catch (err) {
          await client.query("ROLLBACK");
          throw new Error(
            `Migration ${file.version}_${file.name} failed: ${(err as Error).message}`,
          );
        }

        console.log(`Applied migration: ${file.version}_${file.name}`);
      }
    } finally {
      await client.query("SELECT pg_advisory_unlock($1)", [lockId]);
    }
  } finally {
    client.release();
  }
}

export async function runStartupMigrations(): Promise<void> {
  const { getMigrationAuthPool, getMigrationAuditPool, getMigrationFeedPool } =
    await import("./client");

  const migrationsRoot = join(process.cwd(), "migrations");

  console.log("Running auth_db migrations...");
  await runMigrations(
    getMigrationAuthPool(),
    join(migrationsRoot, "auth"),
    LOCK_ID_AUTH,
  );

  console.log("Running audit_db migrations...");
  await runMigrations(
    getMigrationAuditPool(),
    join(migrationsRoot, "audit"),
    LOCK_ID_AUDIT,
  );

  console.log("Running feed_db migrations...");
  await runMigrations(
    getMigrationFeedPool(),
    join(migrationsRoot, "feed"),
    LOCK_ID_FEED,
  );

  // Run pending customer_db migrations for all active customers.
  // Failed customers are skipped — use `pnpm migrate:customers --customer-id=<id>` to retry.
  await runStartupCustomerMigrations(getMigrationAuthPool(), migrationsRoot);

  // Run pending group_db migrations for all active groups (#507). Failed
  // groups are skipped — use `pnpm migrate:groups --group-id=<id>` to retry.
  await runStartupGroupMigrations(getMigrationAuthPool(), migrationsRoot);

  console.log("Startup migrations complete.");
}

async function runStartupCustomerMigrations(
  authPool: Pool,
  migrationsRoot: string,
): Promise<void> {
  const { customerDbUrl, customerLockId } = await import("./customer-db");

  const ownerTemplateUrl = process.env.CUSTOMER_DATABASE_OWNER_URL;
  if (!ownerTemplateUrl) {
    console.log(
      "CUSTOMER_DATABASE_OWNER_URL not set, skipping customer migrations.",
    );
    return;
  }

  const result = await authPool.query<{ id: string }>(
    "SELECT id FROM customers WHERE database_status = 'active'",
  );

  if (result.rows.length === 0) {
    console.log("No active customers to migrate.");
    return;
  }

  const customerMigrationsDir = join(migrationsRoot, "customer");

  const { customerDbName } = await import("./customer-db");

  for (const customer of result.rows) {
    // Verify the database exists before attempting to connect.
    // An active customer whose DB was externally dropped should be
    // marked failed rather than crashing the migration loop.
    const dbName = customerDbName(customer.id);
    const dbExists = await authPool.query(
      "SELECT 1 FROM pg_database WHERE datname = $1",
      [dbName],
    );
    if (dbExists.rows.length === 0) {
      console.error(
        `Customer ${customer.id}: database ${dbName} does not exist, marking as failed.`,
      );
      await authPool
        .query(
          "UPDATE customers SET database_status = 'failed' WHERE id = $1",
          [customer.id],
        )
        .catch(() => {});
      await reconcileCustomerGroupsAfterFailure(authPool, customer.id);
      continue;
    }

    console.log(`Running customer_db migrations for ${customer.id}...`);
    const ownerUrl = customerDbUrl(ownerTemplateUrl, customer.id);
    const customerPool = new Pool({ connectionString: ownerUrl });

    try {
      await runMigrations(
        customerPool,
        customerMigrationsDir,
        customerLockId(customer.id),
      );
    } catch (err) {
      console.error(
        `Customer ${customer.id}: migration failed:`,
        (err as Error).message,
      );
      await authPool
        .query(
          "UPDATE customers SET database_status = 'failed' WHERE id = $1",
          [customer.id],
        )
        .catch((updateErr) => {
          console.error(
            "Failed to update database_status:",
            (updateErr as Error).message,
          );
        });
      await reconcileCustomerGroupsAfterFailure(authPool, customer.id);
    } finally {
      await customerPool.end();
    }
  }
}

async function runStartupGroupMigrations(
  authPool: Pool,
  migrationsRoot: string,
): Promise<void> {
  const { groupDbName, groupDbUrl, groupLockId } = await import("./group-db");

  // Group DBs reuse the shared subject-DB owner template (see group-db.ts).
  const ownerTemplateUrl = process.env.CUSTOMER_DATABASE_OWNER_URL;
  if (!ownerTemplateUrl) {
    console.log(
      "CUSTOMER_DATABASE_OWNER_URL not set, skipping group migrations.",
    );
    return;
  }

  const result = await authPool.query<{ id: string }>(
    "SELECT id FROM customer_groups WHERE database_status = 'active'",
  );

  if (result.rows.length === 0) {
    console.log("No active groups to migrate.");
    return;
  }

  const groupMigrationsDir = join(migrationsRoot, "group");

  for (const group of result.rows) {
    // Verify the database exists before attempting to connect. An active
    // group whose DB was externally dropped should be marked failed
    // rather than crashing the migration loop.
    const dbName = groupDbName(group.id);
    const dbExists = await authPool.query(
      "SELECT 1 FROM pg_database WHERE datname = $1",
      [dbName],
    );
    if (dbExists.rows.length === 0) {
      console.error(
        `Group ${group.id}: database ${dbName} does not exist, marking as failed.`,
      );
      await authPool
        .query(
          "UPDATE customer_groups SET database_status = 'failed' WHERE id = $1",
          [group.id],
        )
        .catch(() => {});
      continue;
    }

    console.log(`Running group_db migrations for ${group.id}...`);
    const ownerUrl = groupDbUrl(ownerTemplateUrl, group.id);
    const groupPool = new Pool({ connectionString: ownerUrl });

    try {
      await runMigrations(groupPool, groupMigrationsDir, groupLockId(group.id));
    } catch (err) {
      console.error(
        `Group ${group.id}: migration failed:`,
        (err as Error).message,
      );
      await authPool
        .query(
          "UPDATE customer_groups SET database_status = 'failed' WHERE id = $1",
          [group.id],
        )
        .catch((updateErr) => {
          console.error(
            "Failed to update database_status:",
            (updateErr as Error).message,
          );
        });
    } finally {
      await groupPool.end();
    }
  }
}
