import { Pool, type PoolClient, type QueryResultRow } from "pg";

// Lazy-initialized pools
let authPool: Pool | null = null;
let auditPool: Pool | null = null;

export function getAuthPool(): Pool {
  if (!authPool) {
    authPool = new Pool({ connectionString: process.env.DATABASE_URL });
  }
  return authPool;
}

export function getAuditPool(): Pool {
  if (!auditPool) {
    auditPool = new Pool({ connectionString: process.env.AUDIT_DATABASE_URL });
  }
  return auditPool;
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
