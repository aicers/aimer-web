import type { PoolClient } from "pg";
import { HttpError } from "./errors";

/**
 * Assert that the given account has a specific permission for the given
 * customer. Throws 403 if the permission is not found.
 */
export async function assertPermission(
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
 * Assert that the given account has Manager-level write permission
 * (`customer-members:write`) for the given customer.
 */
export async function assertManagerPermission(
  client: PoolClient,
  accountId: string,
  customerId: string,
): Promise<void> {
  return assertPermission(
    client,
    accountId,
    customerId,
    "customer-members:write",
  );
}
