import { Pool, type PoolClient, type QueryResultRow } from "pg";

// Lazy-initialized pools — runtime (application queries)
let authPool: Pool | null = null;
let auditPool: Pool | null = null;
let feedPool: Pool | null = null;

// Lazy-initialized pools — migration runner (owner role)
let migrationAuthPool: Pool | null = null;
let migrationAuditPool: Pool | null = null;
let migrationFeedPool: Pool | null = null;

export function getAuthPool(): Pool {
  if (!authPool) {
    authPool = new Pool({ connectionString: process.env.DATABASE_URL });
  }
  return authPool;
}

export function getAuditPool(): Pool {
  if (!auditPool) {
    auditPool = new Pool({
      connectionString: process.env.AUDIT_DATABASE_URL,
      // Audit writes are fire-and-forget. A generous timeout prevents
      // a slow or unhealthy audit_db from stalling request pipelines.
      statement_timeout: 5_000,
    });
  }
  return auditPool;
}

export function getFeedPool(): Pool {
  if (!feedPool) {
    feedPool = new Pool({ connectionString: process.env.FEED_DATABASE_URL });
  }
  return feedPool;
}

export function getMigrationAuthPool(): Pool {
  if (!migrationAuthPool) {
    const url = process.env.DATABASE_MIGRATION_URL ?? process.env.DATABASE_URL;
    migrationAuthPool = new Pool({ connectionString: url });
  }
  return migrationAuthPool;
}

export function getMigrationAuditPool(): Pool {
  if (!migrationAuditPool) {
    const url =
      process.env.AUDIT_DATABASE_MIGRATION_URL ??
      process.env.AUDIT_DATABASE_URL;
    migrationAuditPool = new Pool({ connectionString: url });
  }
  return migrationAuditPool;
}

export function getMigrationFeedPool(): Pool {
  if (!migrationFeedPool) {
    const url =
      process.env.FEED_DATABASE_MIGRATION_URL ?? process.env.FEED_DATABASE_URL;
    migrationFeedPool = new Pool({ connectionString: url });
  }
  return migrationFeedPool;
}

export async function query<T extends QueryResultRow>(
  pool: Pool,
  text: string,
  params?: unknown[],
): Promise<T[]> {
  const result = await pool.query<T>(text, params);
  return result.rows;
}

export async function withTransaction<T>(
  pool: Pool,
  fn: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}
