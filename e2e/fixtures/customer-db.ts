// Shared per-customer DB provisioning / migration helpers for the
// manual-screenshot capture spec.
//
// Extracted from `capture-manual-screenshots.spec.ts` so multiple
// captures that render per-customer pages (the event analysis-result
// page and the RFC 0002 story analysis page) can provision and migrate
// a customer DB without duplicating the inlined runner. The
// event-analysis-specific `seedAnalysisRow` stays in the spec; only the
// provision / migrate / drop / URL helpers — which take a `customerId`
// and are otherwise free of capture-local state — move here.
//
// Playwright bundles the capture spec as CJS and cannot dynamically
// import the TypeScript `src/lib/db/migrate.ts` source at runtime, so
// `runCustomerMigrations` is a small inlined SQL runner that mirrors the
// production migrator's apply semantics (checksum-tracked `_migrations`
// table, per-file transaction).

import type { Pool } from "pg";

/**
 * Build an owner-role connection URL for a customer's per-tenant DB by
 * swapping the database segment of `CUSTOMER_DATABASE_OWNER_URL` (which
 * points at `template1` by default) for `customer_<uuid-no-dashes>`.
 */
export function customerOwnerUrl(customerId: string): string {
  const tpl =
    process.env.CUSTOMER_DATABASE_OWNER_URL ??
    "postgres://aimer_customer_owner:changeme@localhost:5432/template1";
  const dbName = `customer_${customerId.replace(/-/g, "")}`;
  return tpl.replace(/\/[^/?]+(\?|$)/, `/${dbName}$1`);
}

export async function provisionAnalysisCustomerDb(
  customerId: string,
): Promise<void> {
  const dbName = `customer_${customerId.replace(/-/g, "")}`;
  const adminUrl =
    process.env.DATABASE_ADMIN_URL ?? process.env.DATABASE_URL ?? "";
  if (!adminUrl) {
    throw new Error(
      "DATABASE_ADMIN_URL or DATABASE_URL must be set to provision the " +
        "analysis-result capture customer DB",
    );
  }
  const { Pool } = await import("pg");
  const adminPool = new Pool({ connectionString: adminUrl });
  try {
    const exists = await adminPool.query<{ datname: string }>(
      "SELECT datname FROM pg_database WHERE datname = $1",
      [dbName],
    );
    if (exists.rows.length === 0) {
      await adminPool.query(
        `CREATE DATABASE ${dbName} OWNER aimer_customer_owner`,
      );
    }
  } finally {
    await adminPool.end();
  }

  const ownerUrl = customerOwnerUrl(customerId);
  const ownerPool = new Pool({ connectionString: ownerUrl });
  try {
    // Mirror provisionCustomerDb's role-grant step so the runtime
    // `aimer_customer` connection (used by the page's loader) can
    // reach the schema. Idempotent — re-running the capture is safe.
    await ownerPool.query("GRANT USAGE ON SCHEMA public TO aimer_customer");
    await ownerPool.query(
      `GRANT CONNECT ON DATABASE ${dbName} TO aimer_customer`,
    );
  } finally {
    await ownerPool.end();
  }

  // Run the customer migration set on a fresh pool. Migrations are
  // plain SQL files, so a small inlined runner is sufficient —
  // Playwright bundles this spec as CJS and cannot dynamically import
  // the TypeScript `src/lib/db/migrate.ts` source at runtime.
  const { resolve } = await import("node:path");
  const migrationOwnerPool = new Pool({ connectionString: ownerUrl });
  try {
    await runCustomerMigrations(
      migrationOwnerPool,
      resolve(process.cwd(), "migrations", "customer"),
    );
  } finally {
    await migrationOwnerPool.end();
  }
}

export async function runCustomerMigrations(
  pool: Pool,
  dir: string,
): Promise<void> {
  const { readdir, readFile } = await import("node:fs/promises");
  const { createHash } = await import("node:crypto");
  const { resolve } = await import("node:path");

  const client = await pool.connect();
  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS _migrations (
        version    TEXT PRIMARY KEY,
        name       TEXT NOT NULL,
        checksum   TEXT NOT NULL,
        applied_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);

    const applied = new Map<string, string>();
    const rows = await client.query<{ version: string; checksum: string }>(
      "SELECT version, checksum FROM _migrations",
    );
    for (const row of rows.rows) applied.set(row.version, row.checksum);

    const entries = (await readdir(dir))
      .filter((f) => /^\d{4}_.*\.sql$/.test(f))
      .sort();

    for (const file of entries) {
      const match = file.match(/^(\d{4})_(.+)\.sql$/);
      if (!match) continue;
      const [, version, name] = match;
      const content = await readFile(resolve(dir, file), "utf-8");
      const checksum = createHash("sha256").update(content).digest("hex");
      if (applied.has(version)) continue;

      await client.query("BEGIN");
      try {
        await client.query(content);
        await client.query(
          "INSERT INTO _migrations (version, name, checksum) VALUES ($1, $2, $3)",
          [version, name, checksum],
        );
        await client.query("COMMIT");
      } catch (err) {
        await client.query("ROLLBACK");
        throw err;
      }
    }
  } finally {
    client.release();
  }
}

export async function dropAnalysisCustomerDb(
  customerId: string,
): Promise<void> {
  const dbName = `customer_${customerId.replace(/-/g, "")}`;
  const adminUrl =
    process.env.DATABASE_ADMIN_URL ?? process.env.DATABASE_URL ?? "";
  if (!adminUrl) return;
  const { Pool } = await import("pg");
  const adminPool = new Pool({ connectionString: adminUrl });
  try {
    await adminPool.query(
      `SELECT pg_terminate_backend(pid)
       FROM pg_stat_activity
       WHERE datname = $1 AND pid <> pg_backend_pid()`,
      [dbName],
    );
    await adminPool.query(`DROP DATABASE IF EXISTS ${dbName}`);
  } finally {
    await adminPool.end();
  }
}
