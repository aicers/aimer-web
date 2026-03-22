import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import type { Pool, PoolClient } from "pg";

const LOCK_ID_AUTH = 1000;
const LOCK_ID_AUDIT = 1001;

interface MigrationRow {
  version: string;
  checksum: string;
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
    .filter((f) => /^\d{4}_.*\.(sql|ts)$/.test(f))
    .sort()
    .map((f) => {
      const match = f.match(/^(\d{4})_(.+)\.(sql|ts)$/);
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
): Promise<void> {
  const mod = await import(migration.path);
  if (typeof mod.default !== "function") {
    throw new Error(
      `DML migration ${migration.path} must export a default function`,
    );
  }

  await client.query("SAVEPOINT migration");
  try {
    await mod.default(client);
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
          const storedChecksum = applied.get(file.version)!;
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
              await applyTsMigration(client, file, checksum);
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
  const { getAuthPool, getAuditPool } = await import("./client");

  const migrationsRoot = join(process.cwd(), "migrations");

  console.log("Running auth_db migrations...");
  await runMigrations(
    getAuthPool(),
    join(migrationsRoot, "auth"),
    LOCK_ID_AUTH,
  );

  console.log("Running audit_db migrations...");
  await runMigrations(
    getAuditPool(),
    join(migrationsRoot, "audit"),
    LOCK_ID_AUDIT,
  );

  console.log("Startup migrations complete.");
}
