import "server-only";

const LOCK_ID_CUSTOMER_BASE = 2000;

/**
 * Derive the PostgreSQL database name for a customer.
 * Convention: `customer_<uuid_without_hyphens>`.
 */
export function customerDbName(customerId: string): string {
  return `customer_${customerId.replace(/-/g, "")}`;
}

/**
 * Derive the Transit key name for a customer's DEK.
 */
export function customerTransitKeyName(customerId: string): string {
  return `customer-${customerId}`;
}

/**
 * Compute an advisory lock ID for a customer's migration runner.
 * Uses a simple hash of the UUID to produce a stable integer in the
 * 2000–2_000_000_000 range, avoiding collisions with auth (1000)
 * and audit (1001) lock IDs.
 */
export function customerLockId(customerId: string): number {
  let hash = 0;
  for (const ch of customerId) {
    hash = (hash * 31 + ch.charCodeAt(0)) | 0;
  }
  return LOCK_ID_CUSTOMER_BASE + Math.abs(hash % 1_000_000);
}

/**
 * Build a connection string for a customer database by replacing the
 * database name component in a template URL.
 *
 * @param templateUrl - A PostgreSQL connection URL with a placeholder DB name
 *                      (e.g. `CUSTOMER_DATABASE_OWNER_URL`)
 * @param customerId  - The customer's UUID
 */
export function customerDbUrl(templateUrl: string, customerId: string): string {
  const dbName = customerDbName(customerId);
  return templateUrl.replace(/\/[^/?]+(\?|$)/, `/${dbName}$1`);
}

/**
 * Return the admin connection URL for CREATE/DROP DATABASE operations.
 * Reads `DATABASE_ADMIN_URL` and falls back to `DATABASE_URL`.
 */
export function getAdminUrl(): string {
  const url = process.env.DATABASE_ADMIN_URL ?? process.env.DATABASE_URL;
  if (!url) {
    throw new Error(
      "DATABASE_ADMIN_URL or DATABASE_URL environment variable is required",
    );
  }
  return url;
}

/**
 * Return the template URL for customer DB owner connections (migrations).
 * The database name in the URL is replaced per customer.
 */
export function getCustomerOwnerTemplateUrl(): string {
  const url = process.env.CUSTOMER_DATABASE_OWNER_URL;
  if (!url) {
    throw new Error(
      "CUSTOMER_DATABASE_OWNER_URL environment variable is required",
    );
  }
  return url;
}

/**
 * Return the template URL for customer DB runtime connections.
 * Uses the restricted `aimer_customer` role — never the owner role.
 */
export function getCustomerRuntimeTemplateUrl(): string {
  const url = process.env.CUSTOMER_DATABASE_URL;
  if (!url) {
    throw new Error("CUSTOMER_DATABASE_URL environment variable is required");
  }
  return url;
}
