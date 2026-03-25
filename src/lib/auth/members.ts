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
// Lock all memberships for a customer
//
// Acquires FOR UPDATE locks on every membership row for the customer in
// deterministic order (account_id). A single lock step eliminates the
// deadlock that would occur if the target row and the Manager rows were
// locked separately (A locks B's row then waits for A's Manager lock,
// while B locks A's row then waits for B's Manager lock).
//
// Returns the locked rows joined with role name so callers can derive
// target existence, current role, and Manager count from one result set.
// ---------------------------------------------------------------------------

interface LockedMembership {
  accountId: string;
  roleId: number;
  roleName: string;
}

async function lockAllMemberships(
  client: PoolClient,
  customerId: string,
): Promise<LockedMembership[]> {
  const result = await client.query<{
    account_id: string;
    role_id: number;
    role_name: string;
  }>(
    `SELECT acm.account_id, acm.role_id, r.name AS role_name
     FROM account_customer_memberships acm
     JOIN roles r ON r.id = acm.role_id
     WHERE acm.customer_id = $1
     ORDER BY acm.account_id
     FOR UPDATE OF acm`,
    [customerId],
  );
  return result.rows.map((r) => ({
    accountId: r.account_id,
    roleId: r.role_id,
    roleName: r.role_name,
  }));
}

function findTarget(
  members: LockedMembership[],
  targetAccountId: string,
): LockedMembership {
  const target = members.find((m) => m.accountId === targetAccountId);
  if (!target) {
    throw new HttpError("Membership not found", 404);
  }
  return target;
}

function assertNotLastManager(
  members: LockedMembership[],
  targetAccountId: string,
): void {
  const managers = members.filter((m) => m.roleName === "Manager");
  if (
    managers.length <= 1 &&
    managers.some((m) => m.accountId === targetAccountId)
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
    const members = await lockAllMemberships(client, params.customerId);
    findTarget(members, params.targetAccountId);
    assertNotLastManager(members, params.targetAccountId);

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
    const members = await lockAllMemberships(client, params.customerId);
    const target = findTarget(members, params.targetAccountId);
    await assertValidGeneralRole(client, params.roleId);

    if (target.roleId === params.roleId) {
      return; // No-op: same role
    }

    // If demoting from Manager, check last-Manager protection
    if (target.roleName === "Manager") {
      assertNotLastManager(members, params.targetAccountId);
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
