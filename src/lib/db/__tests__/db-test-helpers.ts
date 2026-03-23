import { Pool } from "pg";

// Prefer the superuser admin URL for CREATE/DROP DATABASE operations.
// Fall back to DATABASE_URL for CI environments where only the
// superuser URL is provided as DATABASE_URL.
const AUTH_ADMIN_URL =
  process.env.DATABASE_ADMIN_URL ?? process.env.DATABASE_URL;
// For audit: prefer a dedicated audit admin URL, otherwise fall back to
// the auth admin URL (assumes same PostgreSQL instance).
const AUDIT_ADMIN_URL = process.env.AUDIT_DATABASE_ADMIN_URL ?? AUTH_ADMIN_URL;

/**
 * Whether PostgreSQL is available for integration tests.
 * Tests should skip when this is false (local dev without Docker).
 */
export const hasPostgres = !!AUTH_ADMIN_URL;

const adminPools = new Map<string, Pool>();

/** Pool connected to the given admin URL (for creating/dropping test DBs). */
function getAdminPool(url: string): Pool {
  let pool = adminPools.get(url);
  if (!pool) {
    pool = new Pool({ connectionString: url });
    adminPools.set(url, pool);
  }
  return pool;
}

/**
 * Create a fresh test database and return a Pool connected to it.
 *
 * @param prefix - Name prefix for the test database
 * @param scope  - "auth" (default) or "audit" to select the admin URL
 */
export async function createTestDatabase(
  prefix: string,
  scope: "auth" | "audit" = "auth",
): Promise<{
  dbName: string;
  pool: Pool;
  url: string;
}> {
  const adminUrl = scope === "audit" ? AUDIT_ADMIN_URL : AUTH_ADMIN_URL;
  if (!adminUrl) {
    throw new Error(
      `No admin URL for scope "${scope}". Set DATABASE_ADMIN_URL or AUDIT_DATABASE_ADMIN_URL.`,
    );
  }

  const dbName = `test_${prefix}_${Date.now()}`;
  const admin = getAdminPool(adminUrl);

  await admin.query(`CREATE DATABASE ${dbName}`);

  // Build a connection URL for the new database by replacing the
  // database name in the admin URL.
  const url = adminUrl.replace(/\/[^/?]+(\?|$)/, `/${dbName}$1`);
  const pool = new Pool({ connectionString: url });

  return { dbName, pool, url };
}

/** Drop a test database (terminates active connections first). */
export async function dropTestDatabase(
  dbName: string,
  pool?: Pool,
  scope: "auth" | "audit" = "auth",
): Promise<void> {
  if (pool) {
    await pool.end();
  }
  const adminUrl = (
    scope === "audit" ? AUDIT_ADMIN_URL : AUTH_ADMIN_URL
  ) as string;
  const admin = getAdminPool(adminUrl);
  await admin.query(`
    SELECT pg_terminate_backend(pid)
    FROM pg_stat_activity
    WHERE datname = '${dbName}' AND pid <> pg_backend_pid()
  `);
  await admin.query(`DROP DATABASE IF EXISTS ${dbName}`);
}

/** Shut down all admin pools. Call in the top-level afterAll. */
export async function closeAdminPool(): Promise<void> {
  for (const pool of adminPools.values()) {
    await pool.end();
  }
  adminPools.clear();
}

/**
 * Create a Pool connected to a specific database as a specific role.
 * Useful for testing role permissions (e.g., connect as aimer_auth).
 *
 * @param scope - "auth" or "audit" to derive host/port from the correct admin URL
 */
export function createRolePool(
  dbName: string,
  role: string,
  password: string,
  scope: "auth" | "audit" = "auth",
): Pool {
  const adminUrl = (
    scope === "audit" ? AUDIT_ADMIN_URL : AUTH_ADMIN_URL
  ) as string;
  const parsed = new URL(adminUrl);
  parsed.username = role;
  parsed.password = password;
  parsed.pathname = `/${dbName}`;
  return new Pool({ connectionString: parsed.toString() });
}
