import { Pool } from "pg";

const ADMIN_URL = process.env.DATABASE_URL;

/**
 * Whether PostgreSQL is available for integration tests.
 * Tests should skip when this is false (local dev without Docker).
 */
export const hasPostgres = !!ADMIN_URL;

let adminPool: Pool | undefined;

/** Pool connected to the default database (for creating/dropping test DBs). */
export function getAdminPool(): Pool {
  if (!adminPool) {
    adminPool = new Pool({ connectionString: ADMIN_URL });
  }
  return adminPool;
}

/** Create a fresh test database and return a Pool connected to it. */
export async function createTestDatabase(prefix: string): Promise<{
  dbName: string;
  pool: Pool;
  url: string;
}> {
  const dbName = `test_${prefix}_${Date.now()}`;
  const admin = getAdminPool();

  await admin.query(`CREATE DATABASE ${dbName}`);

  // Build a connection URL for the new database by replacing the
  // database name in the admin URL.
  // hasPostgres guard ensures ADMIN_URL is defined before this is called
  const url = (ADMIN_URL as string).replace(/\/[^/?]+(\?|$)/, `/${dbName}$1`);
  const pool = new Pool({ connectionString: url });

  return { dbName, pool, url };
}

/** Drop a test database (terminates active connections first). */
export async function dropTestDatabase(
  dbName: string,
  pool?: Pool,
): Promise<void> {
  if (pool) {
    await pool.end();
  }
  const admin = getAdminPool();
  await admin.query(`
    SELECT pg_terminate_backend(pid)
    FROM pg_stat_activity
    WHERE datname = '${dbName}' AND pid <> pg_backend_pid()
  `);
  await admin.query(`DROP DATABASE IF EXISTS ${dbName}`);
}

/** Shut down the admin pool. Call in the top-level afterAll. */
export async function closeAdminPool(): Promise<void> {
  if (adminPool) {
    await adminPool.end();
    adminPool = undefined;
  }
}

/**
 * Create a Pool connected to a specific database as a specific role.
 * Useful for testing role permissions (e.g., connect as aimer_auth).
 */
export function createRolePool(
  dbName: string,
  role: string,
  password: string,
): Pool {
  const parsed = new URL(ADMIN_URL as string);
  parsed.username = role;
  parsed.password = password;
  parsed.pathname = `/${dbName}`;
  return new Pool({ connectionString: parsed.toString() });
}
