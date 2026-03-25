import type { PoolClient } from "pg";
import { HttpError } from "./errors";

/**
 * Assert that the given account holds a specific permission for a customer.
 * Throws 403 if the permission is missing.
 */
export async function assertCustomerPermission(
  client: PoolClient,
  accountId: string,
  customerId: string,
  permission: string,
): Promise<void> {
  const result = await client.query<{ permission: string }>(
    `SELECT rp.permission
     FROM account_customer_memberships acm
     JOIN role_permissions rp ON rp.role_id = acm.role_id
     WHERE acm.account_id = $1 AND acm.customer_id = $2
       AND rp.permission = $3`,
    [accountId, customerId, permission],
  );
  if (result.rows.length === 0) {
    throw new HttpError("Forbidden", 403);
  }
}

/**
 * Assert `customer-members:write` permission.
 * Convenience wrapper used by invitation and member management flows.
 */
export async function assertManagerPermission(
  client: PoolClient,
  accountId: string,
  customerId: string,
): Promise<void> {
  return assertCustomerPermission(
    client,
    accountId,
    customerId,
    "customer-members:write",
  );
}
