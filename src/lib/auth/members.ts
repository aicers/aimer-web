import type { Pool, PoolClient } from "pg";
import { withTransaction } from "../db/client";
import { HttpError } from "./errors";
import { assertManagerPermission } from "./permissions";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface Member {
  accountId: string;
  username: string;
  displayName: string;
  email: string | null;
  roleName: string;
  roleId: number;
  lastSignInAt: string | null;
}

export interface ListMembersParams {
  actorId: string;
  customerId: string;
}

export interface RemoveMemberParams {
  actorId: string;
  targetAccountId: string;
  customerId: string;
}

export interface ChangeMemberRoleParams {
  actorId: string;
  targetAccountId: string;
  customerId: string;
  roleId: number;
}

// ---------------------------------------------------------------------------
// Membership lock
//
// Locks the target membership row with FOR UPDATE to prevent concurrent
// modification (TOCTOU). Returns the current role_id for use by callers.
// ---------------------------------------------------------------------------

async function lockMembership(
  client: PoolClient,
  accountId: string,
  customerId: string,
): Promise<{ roleId: number }> {
  const result = await client.query<{ role_id: number }>(
    `SELECT role_id FROM account_customer_memberships
     WHERE account_id = $1 AND customer_id = $2
     FOR UPDATE`,
    [accountId, customerId],
  );
  if (result.rows.length === 0) {
    throw new HttpError("Membership not found", 404);
  }
  return { roleId: result.rows[0].role_id };
}

// ---------------------------------------------------------------------------
// Last Manager protection
//
// Uses SELECT ... FOR UPDATE to lock Manager rows and prevent concurrent
// removal/demotion of the last Manager.
// ---------------------------------------------------------------------------

async function assertNotLastManager(
  client: PoolClient,
  targetAccountId: string,
  customerId: string,
): Promise<void> {
  const result = await client.query<{ account_id: string }>(
    `SELECT acm.account_id
     FROM account_customer_memberships acm
     JOIN roles r ON r.id = acm.role_id
     WHERE acm.customer_id = $1 AND r.name = 'Manager'
     FOR UPDATE`,
    [customerId],
  );

  const managerIds = result.rows.map((r) => r.account_id);
  if (
    managerIds.length <= 1 &&
    managerIds.some((id) => id === targetAccountId)
  ) {
    throw new HttpError("last_manager_cannot_be_removed", 409);
  }
}

// ---------------------------------------------------------------------------
// Role validation
// ---------------------------------------------------------------------------

async function assertValidGeneralRole(
  client: PoolClient,
  roleId: number,
): Promise<string> {
  const result = await client.query<{ name: string }>(
    `SELECT name FROM roles WHERE id = $1 AND auth_context = 'general'`,
    [roleId],
  );
  if (result.rows.length === 0) {
    throw new HttpError("Invalid role", 400);
  }
  return result.rows[0].name;
}

// ---------------------------------------------------------------------------
// List members
// ---------------------------------------------------------------------------

export async function listMembers(
  client: PoolClient,
  params: ListMembersParams,
): Promise<Member[]> {
  await assertManagerPermission(client, params.actorId, params.customerId);

  const result = await client.query<{
    account_id: string;
    username: string;
    display_name: string;
    email: string | null;
    role_name: string;
    role_id: number;
    last_sign_in_at: Date | null;
  }>(
    `SELECT
       acm.account_id,
       a.username,
       a.display_name,
       a.email,
       r.name AS role_name,
       acm.role_id,
       a.last_sign_in_at
     FROM account_customer_memberships acm
     JOIN accounts a ON a.id = acm.account_id
     JOIN roles r ON r.id = acm.role_id
     WHERE acm.customer_id = $1
     ORDER BY a.display_name`,
    [params.customerId],
  );

  return result.rows.map((row) => ({
    accountId: row.account_id,
    username: row.username,
    displayName: row.display_name,
    email: row.email,
    roleName: row.role_name,
    roleId: row.role_id,
    lastSignInAt: row.last_sign_in_at?.toISOString() ?? null,
  }));
}

// ---------------------------------------------------------------------------
// Remove member (transactional — uses pool)
// ---------------------------------------------------------------------------

export async function removeMember(
  pool: Pool,
  params: RemoveMemberParams,
): Promise<void> {
  await withTransaction(pool, async (client) => {
    await assertManagerPermission(client, params.actorId, params.customerId);
    await lockMembership(client, params.targetAccountId, params.customerId);
    await assertNotLastManager(
      client,
      params.targetAccountId,
      params.customerId,
    );

    const result = await client.query(
      `DELETE FROM account_customer_memberships
       WHERE account_id = $1 AND customer_id = $2`,
      [params.targetAccountId, params.customerId],
    );
    if (result.rowCount === 0) {
      throw new HttpError("Membership not found", 404);
    }
  });
}

// ---------------------------------------------------------------------------
// Change member role (transactional — uses pool)
// ---------------------------------------------------------------------------

export async function changeMemberRole(
  pool: Pool,
  params: ChangeMemberRoleParams,
): Promise<void> {
  await withTransaction(pool, async (client) => {
    await assertManagerPermission(client, params.actorId, params.customerId);
    const { roleId: currentRoleId } = await lockMembership(
      client,
      params.targetAccountId,
      params.customerId,
    );
    await assertValidGeneralRole(client, params.roleId);

    if (currentRoleId === params.roleId) {
      return; // No-op: same role
    }

    // If demoting from Manager, check last-Manager protection
    const currentRoleName = await client.query<{ name: string }>(
      `SELECT name FROM roles WHERE id = $1`,
      [currentRoleId],
    );

    if (currentRoleName.rows[0].name === "Manager") {
      await assertNotLastManager(
        client,
        params.targetAccountId,
        params.customerId,
      );
    }

    const result = await client.query(
      `UPDATE account_customer_memberships
       SET role_id = $1, updated_at = NOW()
       WHERE account_id = $2 AND customer_id = $3`,
      [params.roleId, params.targetAccountId, params.customerId],
    );
    if (result.rowCount === 0) {
      throw new HttpError("Membership not found", 404);
    }
  });
}
