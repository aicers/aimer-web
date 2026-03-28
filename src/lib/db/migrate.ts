import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { Pool, type PoolClient } from "pg";

const LOCK_ID_AUTH = 1000;
const LOCK_ID_AUDIT = 1001;

interface MigrationRow {
  version: string;
  checksum: string;
}

export interface MigrationContext {
  /** Decrypt a customer's DEK via OpenBao Transit. Available for customer_db DML migrations. */
  decryptDek?: (wrappedDek: string) => Promise<Buffer>;
}

export interface MigrationFile {
  version: string;
  name: string;
  path: string;
  ext: string;
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
    .filter((f) => /^\d{4}[a-z]?_.*\.(sql|ts)$/.test(f))
    .sort()
    .map((f) => {
      const match = f.match(/^(\d{4}[a-z]?)_(.+)\.(sql|ts)$/);
      if (!match) throw new Error(`Invalid migration filename: ${f}`);
      return {
        version: match[1],
        name: match[2],
        path: join(dir, f),
        ext: match[3],
      };
    });
}

async function applySqlMigration(
  client: PoolClient,
  migration: MigrationFile,
  content: string,
  checksum: string,
  noTransaction: boolean,
): Promise<void> {
  if (noTransaction) {
    await client.query(content);
  } else {
    await client.query("SAVEPOINT migration");
    try {
      await client.query(content);
      await client.query("RELEASE SAVEPOINT migration");
    } catch (err) {
      await client.query("ROLLBACK TO SAVEPOINT migration");
      throw err;
    }
  }

  await client.query(
    "INSERT INTO _migrations (version, name, checksum) VALUES ($1, $2, $3)",
    [migration.version, migration.name, checksum],
  );
}

async function applyTsMigration(
  client: PoolClient,
  migration: MigrationFile,
  checksum: string,
  context?: MigrationContext,
): Promise<void> {
  const mod = await import(migration.path);
  if (typeof mod.default !== "function") {
    throw new Error(
      `DML migration ${migration.path} must export a default function`,
    );
  }

  await client.query("SAVEPOINT migration");
  try {
    await mod.default(client, context);
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

export async function runMigrations(
  pool: Pool,
  migrationsDir: string,
  lockId: number,
  context?: MigrationContext,
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

        const noTransaction =
          file.ext === "sql" && content.includes("-- no-transaction");

        if (noTransaction) {
          // No-transaction migrations run outside any transaction block.
          // The advisory lock still prevents concurrent execution.
          await applySqlMigration(client, file, content, checksum, true);
        } else {
          // Wrap in a transaction for atomicity
          await client.query("BEGIN");
          try {
            if (file.ext === "sql") {
              await applySqlMigration(client, file, content, checksum, false);
            } else {
              await applyTsMigration(client, file, checksum, context);
            }
            await client.query("COMMIT");
          } catch (err) {
            await client.query("ROLLBACK");
            throw new Error(
              `Migration ${file.version}_${file.name} failed: ${(err as Error).message}`,
            );
          }
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
  const { getMigrationAuthPool, getMigrationAuditPool } = await import(
    "./client"
  );

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

  // Run pending customer_db migrations for all active customers.
  // Failed customers are skipped — use `pnpm migrate:customers --customer-id=<id>` to retry.
  await runStartupCustomerMigrations(getMigrationAuthPool(), migrationsRoot);

  console.log("Startup migrations complete.");
}

async function runStartupCustomerMigrations(
  authPool: Pool,
  migrationsRoot: string,
): Promise<void> {
  const { customerDbUrl, customerLockId, customerTransitKeyName } =
    await import("./customer-db");
  const { decryptDataKey, getTransitConfig } = await import(
    "../crypto/transit"
  );

  const ownerTemplateUrl = process.env.CUSTOMER_DATABASE_OWNER_URL;
  if (!ownerTemplateUrl) {
    console.log(
      "CUSTOMER_DATABASE_OWNER_URL not set, skipping customer migrations.",
    );
    return;
  }

  const result = await authPool.query<{
    id: string;
    wrapped_dek: string | null;
  }>("SELECT id, wrapped_dek FROM customers WHERE database_status = 'active'");

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
      continue;
    }

    console.log(`Running customer_db migrations for ${customer.id}...`);
    const ownerUrl = customerDbUrl(ownerTemplateUrl, customer.id);
    const customerPool = new Pool({ connectionString: ownerUrl });

    try {
      let context: MigrationContext | undefined;
      if (customer.wrapped_dek) {
        const transitConfig = getTransitConfig();
        const keyName = customerTransitKeyName(customer.id);
        const wrappedDek = customer.wrapped_dek;
        context = {
          decryptDek: () => decryptDataKey(transitConfig, keyName, wrappedDek),
        };
      }

      await runMigrations(
        customerPool,
        customerMigrationsDir,
        customerLockId(customer.id),
        context,
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
    } finally {
      await customerPool.end();
    }
  }
}
