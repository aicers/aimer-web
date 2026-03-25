import type { PoolClient } from "pg";
import { HttpError } from "./errors";
import {
  assertCustomerPermission,
  assertManagerPermission,
} from "./permissions";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface PendingInvitation {
  id: string;
  email: string;
  role: string;
  createdAt: string;
  expiresAt: string;
}

// ---------------------------------------------------------------------------
// List pending invitations
// ---------------------------------------------------------------------------

export async function listPendingInvitations(
  client: PoolClient,
  params: { accountId: string; customerId: string },
): Promise<PendingInvitation[]> {
  await assertCustomerPermission(
    client,
    params.accountId,
    params.customerId,
    "customer-members:read",
  );

  const result = await client.query<{
    id: string;
    invited_email: string;
    role_name: string;
    created_at: Date;
    expires_at: Date;
  }>(
    `SELECT i.id, i.invited_email, r.name AS role_name,
            i.created_at, i.expires_at
     FROM invitations i
     JOIN roles r ON r.id = i.role_id
     WHERE i.customer_id = $1
       AND i.status = 'pending'
       AND i.expires_at > NOW()
     ORDER BY i.created_at DESC`,
    [params.customerId],
  );

  return result.rows.map((row) => ({
    id: row.id,
    email: row.invited_email,
    role: row.role_name,
    createdAt: row.created_at.toISOString(),
    expiresAt: row.expires_at.toISOString(),
  }));
}

// ---------------------------------------------------------------------------
// Revoke invitation
// ---------------------------------------------------------------------------

export async function revokeInvitation(
  client: PoolClient,
  params: { accountId: string; invitationId: string },
): Promise<void> {
  // Look up the invitation and lock the row.
  // The WHERE clause enforces pending + not-expired so that expired
  // invitations are treated as 404 per the issue spec.
  const result = await client.query<{
    id: string;
    customer_id: string;
  }>(
    `SELECT id, customer_id FROM invitations
     WHERE id = $1
       AND status = 'pending'
       AND expires_at > NOW()
     FOR UPDATE`,
    [params.invitationId],
  );

  if (result.rows.length === 0) {
    throw new HttpError("Invitation not found", 404);
  }

  const inv = result.rows[0];

  // Return 404 (not 403) when the caller lacks permission so that
  // cross-tenant callers cannot distinguish "exists but forbidden"
  // from "does not exist".
  try {
    await assertManagerPermission(client, params.accountId, inv.customer_id);
  } catch (err) {
    if (err instanceof HttpError && err.statusCode === 403) {
      throw new HttpError("Invitation not found", 404);
    }
    throw err;
  }

  await client.query(
    `UPDATE invitations SET status = 'revoked' WHERE id = $1`,
    [params.invitationId],
  );
}
