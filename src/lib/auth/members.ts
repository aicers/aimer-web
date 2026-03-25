import type { PoolClient } from "pg";
import { HttpError } from "./errors";
import { assertManagerPermission } from "./permissions";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface Member {
  accountId: string;
  displayName: string;
  email: string | null;
  roleName: string;
  lastSignInAt: string | null;
}

export interface ChangeRoleParams {
  accountId: string;
  targetAccountId: string;
  customerId: string;
  roleId: number;
}

export interface RemoveMemberParams {
  accountId: string;
  targetAccountId: string;
  customerId: string;
}

// ---------------------------------------------------------------------------
// Last Manager protection
// ---------------------------------------------------------------------------

/**
 * Lock all Manager-role membership rows for the given customer and return
 * the count. Must be called inside a transaction. The FOR UPDATE lock
 * ensures concurrent operations are serialized.
 */
async function countManagersForUpdate(
  client: PoolClient,
  customerId: string,
): Promise<{ count: number; managerRoleId: number }> {
  const rows = await client.query<{
    account_id: string;
    role_id: number;
  }>(
    `SELECT acm.account_id, acm.role_id
     FROM account_customer_memberships acm
     JOIN roles r ON r.id = acm.role_id
     WHERE acm.customer_id = $1 AND r.name = 'Manager'
     FOR UPDATE`,
    [customerId],
  );

  const managerRoleId =
    rows.rows.length > 0
      ? rows.rows[0].role_id
      : // Fallback: look up the role directly
        (
          await client.query<{ id: number }>(
            `SELECT id FROM roles WHERE name = 'Manager' AND auth_context = 'general'`,
          )
        ).rows[0].id;

  return { count: rows.rows.length, managerRoleId };
}

// ---------------------------------------------------------------------------
// List members
// ---------------------------------------------------------------------------

export async function listMembers(
  client: PoolClient,
  params: { accountId: string; customerId: string },
): Promise<Member[]> {
  await assertManagerPermission(client, params.accountId, params.customerId);

  const rows = await client.query<{
    account_id: string;
    display_name: string;
    email: string | null;
    role_name: string;
    last_sign_in_at: Date | null;
  }>(
    `SELECT a.id AS account_id,
            a.display_name,
            a.email,
            r.name AS role_name,
            a.last_sign_in_at
     FROM account_customer_memberships acm
     JOIN accounts a ON a.id = acm.account_id
     JOIN roles r ON r.id = acm.role_id
     WHERE acm.customer_id = $1
     ORDER BY a.display_name`,
    [params.customerId],
  );

  return rows.rows.map((row) => ({
    accountId: row.account_id,
    displayName: row.display_name,
    email: row.email,
    roleName: row.role_name,
    lastSignInAt: row.last_sign_in_at?.toISOString() ?? null,
  }));
}

// ---------------------------------------------------------------------------
// Remove member (transactional, with last Manager protection)
// ---------------------------------------------------------------------------

export async function removeMember(
  client: PoolClient,
  params: RemoveMemberParams,
): Promise<void> {
  // Early permission check (fail fast before locking)
  await assertManagerPermission(client, params.accountId, params.customerId);

  // Lock Manager rows first — serializes concurrent mutations
  const { count, managerRoleId } = await countManagersForUpdate(
    client,
    params.customerId,
  );

  // Revalidate permission after lock: the actor may have been
  // demoted or removed by a concurrent transaction that committed
  // while we were waiting for the lock.
  await assertManagerPermission(client, params.accountId, params.customerId);

  // Verify target is actually a member (read after lock for consistency)
  const membership = await client.query<{ role_id: number }>(
    `SELECT role_id FROM account_customer_memberships
     WHERE account_id = $1 AND customer_id = $2`,
    [params.targetAccountId, params.customerId],
  );
  if (membership.rows.length === 0) {
    throw new HttpError("Member not found", 404);
  }

  // Last Manager protection
  if (membership.rows[0].role_id === managerRoleId && count <= 1) {
    throw new HttpError("last_manager_cannot_be_removed", 409);
  }

  await client.query(
    `DELETE FROM account_customer_memberships
     WHERE account_id = $1 AND customer_id = $2`,
    [params.targetAccountId, params.customerId],
  );
}

// ---------------------------------------------------------------------------
// Change role (transactional, with last Manager protection)
// ---------------------------------------------------------------------------

export async function changeRole(
  client: PoolClient,
  params: ChangeRoleParams,
): Promise<void> {
  // Early permission check (fail fast before locking)
  await assertManagerPermission(client, params.accountId, params.customerId);

  // Verify target role exists and is general-context (no lock needed)
  const role = await client.query<{ id: number; auth_context: string }>(
    `SELECT id, auth_context FROM roles WHERE id = $1`,
    [params.roleId],
  );
  if (role.rows.length === 0) {
    throw new HttpError("Invalid role", 400);
  }
  if (role.rows[0].auth_context !== "general") {
    throw new HttpError("Role must be a general-context role", 400);
  }

  // Lock Manager rows first — serializes concurrent mutations
  const { count, managerRoleId } = await countManagersForUpdate(
    client,
    params.customerId,
  );

  // Revalidate permission after lock
  await assertManagerPermission(client, params.accountId, params.customerId);

  // Verify target is actually a member (read after lock for consistency)
  const membership = await client.query<{ role_id: number }>(
    `SELECT role_id FROM account_customer_memberships
     WHERE account_id = $1 AND customer_id = $2`,
    [params.targetAccountId, params.customerId],
  );
  if (membership.rows.length === 0) {
    throw new HttpError("Member not found", 404);
  }

  // Last Manager protection: block demotion of last Manager
  const currentRoleId = membership.rows[0].role_id;
  if (
    currentRoleId === managerRoleId &&
    params.roleId !== managerRoleId &&
    count <= 1
  ) {
    throw new HttpError("last_manager_cannot_be_removed", 409);
  }

  await client.query(
    `UPDATE account_customer_memberships
     SET role_id = $1, updated_at = NOW()
     WHERE account_id = $2 AND customer_id = $3`,
    [params.roleId, params.targetAccountId, params.customerId],
  );
}
