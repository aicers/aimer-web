import { Pool } from "pg";
import { customerDbUrl, getCustomerRuntimeTemplateUrl } from "./customer-db";

/**
 * Lazy per-customer runtime pool cache. Phase 1 approve and Phase 2
 * ingest routes touch a customer DB once per request, and the
 * retention sweeper opens a single transaction per customer per tick;
 * opening a fresh `Pool` each time would burn a connection
 * establishment per call. Keep one `Pool` per customer keyed by UUID,
 * lazily initialized.
 *
 * The pool uses the restricted `aimer_customer` role
 * (`CUSTOMER_DATABASE_URL`), never the owner role.
 */
const pools = new Map<string, Pool>();

export function getCustomerRuntimePool(customerId: string): Pool {
  let pool = pools.get(customerId);
  if (!pool) {
    const url = customerDbUrl(getCustomerRuntimeTemplateUrl(), customerId);
    pool = new Pool({ connectionString: url });
    pools.set(customerId, pool);
  }
  return pool;
}

/** Test-only helper — close and clear cached pools. */
export async function __resetCustomerPoolsForTests(): Promise<void> {
  for (const pool of pools.values()) {
    pool.on("error", () => {});
    await pool.end();
  }
  pools.clear();
}
