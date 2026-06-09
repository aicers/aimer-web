import { Pool } from "pg";
import { getGroupRuntimeTemplateUrl, groupDbUrl } from "./group-db";

/**
 * Lazy per-group runtime pool cache (peer of customer-runtime-pool.ts).
 * The group report-generation pipeline (#508) touches a group DB once per
 * request; opening a fresh `Pool` each call would burn a connection
 * establishment per call. Keep one `Pool` per group keyed by UUID, lazily
 * initialized.
 *
 * The pool uses the restricted `aimer_customer` role
 * (`CUSTOMER_DATABASE_URL`), never the owner role.
 */
const pools = new Map<string, Pool>();

export function getGroupRuntimePool(groupId: string): Pool {
  let pool = pools.get(groupId);
  if (!pool) {
    const url = groupDbUrl(getGroupRuntimeTemplateUrl(), groupId);
    pool = new Pool({ connectionString: url });
    pools.set(groupId, pool);
  }
  return pool;
}

/** Test-only helper — close and clear cached pools. */
export async function __resetGroupPoolsForTests(): Promise<void> {
  for (const pool of pools.values()) {
    pool.on("error", () => {});
    await pool.end();
  }
  pools.clear();
}
