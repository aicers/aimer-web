import { Pool } from "pg";

// Prefer the superuser admin URL for CREATE/DROP DATABASE operations.
// Fall back to DATABASE_URL for CI environments where only the
// superuser URL is provided as DATABASE_URL.
const AUTH_ADMIN_URL =
  process.env.DATABASE_ADMIN_URL ?? process.env.DATABASE_URL;
// For audit: prefer a dedicated audit admin URL, otherwise fall back to
// the auth admin URL (assumes same PostgreSQL instance).
const AUDIT_ADMIN_URL = process.env.AUDIT_DATABASE_ADMIN_URL ?? AUTH_ADMIN_URL;
// For feed: prefer a dedicated feed admin URL, otherwise fall back to the
// auth admin URL (assumes same PostgreSQL instance).
const FEED_ADMIN_URL = process.env.FEED_DATABASE_ADMIN_URL ?? AUTH_ADMIN_URL;

type DbScope = "auth" | "audit" | "feed";

/** The admin URL for a scope (auth / audit / feed). */
function adminUrlForScope(scope: DbScope): string | undefined {
  switch (scope) {
    case "audit":
      return AUDIT_ADMIN_URL;
    case "feed":
      return FEED_ADMIN_URL;
    default:
      return AUTH_ADMIN_URL;
  }
}

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
 * @param scope  - "auth" (default), "audit", or "feed" to select the admin URL
 */
export async function createTestDatabase(
  prefix: string,
  scope: DbScope = "auth",
): Promise<{
  dbName: string;
  pool: Pool;
  url: string;
}> {
  const adminUrl = adminUrlForScope(scope);
  if (!adminUrl) {
    throw new Error(
      `No admin URL for scope "${scope}". Set DATABASE_ADMIN_URL, ` +
        "AUDIT_DATABASE_ADMIN_URL, or FEED_DATABASE_ADMIN_URL.",
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
  scope: DbScope = "auth",
): Promise<void> {
  const adminUrl = adminUrlForScope(scope) as string;
  const admin = getAdminPool(adminUrl);

  // Suppress error events BEFORE terminating backends — the FATAL
  // arrives asynchronously and may fire before pool.end() is called.
  if (pool) {
    pool.on("error", () => {});
  }

  await admin.query(`
    SELECT pg_terminate_backend(pid)
    FROM pg_stat_activity
    WHERE datname = '${dbName}' AND pid <> pg_backend_pid()
  `);

  if (pool) {
    await pool.end();
  }

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
 * @param scope - "auth", "audit", or "feed" to derive host/port from the correct admin URL
 */
export function createRolePool(
  dbName: string,
  role: string,
  password: string,
  scope: DbScope = "auth",
): Pool {
  const adminUrl = adminUrlForScope(scope) as string;
  const parsed = new URL(adminUrl);
  parsed.username = role;
  parsed.password = password;
  parsed.pathname = `/${dbName}`;
  return new Pool({ connectionString: parsed.toString() });
}
