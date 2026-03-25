import type { Pool } from "pg";
import { withTransaction } from "../db/client";
import { HttpError } from "./errors";
import { assertPermission } from "./permissions";

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
  pool: Pool,
  accountId: string,
  customerId: string,
): Promise<PendingInvitation[]> {
  const client = await pool.connect();
  try {
    await assertPermission(
      client,
      accountId,
      customerId,
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
      [customerId],
    );

    return result.rows.map((row) => ({
      id: row.id,
      email: row.invited_email,
      role: row.role_name,
      createdAt: row.created_at.toISOString(),
      expiresAt: row.expires_at.toISOString(),
    }));
  } finally {
    client.release();
  }
}

// ---------------------------------------------------------------------------
// Revoke invitation (soft delete)
// ---------------------------------------------------------------------------

export async function revokeInvitation(
  pool: Pool,
  accountId: string,
  invitationId: string,
): Promise<void> {
  await withTransaction(pool, async (client) => {
    // Lock the row and fetch customer_id for permission check
    const inv = await client.query<{ id: string; customer_id: string }>(
      `SELECT id, customer_id FROM invitations
       WHERE id = $1 AND status = 'pending' AND expires_at > NOW()
       FOR UPDATE`,
      [invitationId],
    );

    if (inv.rows.length === 0) {
      throw new HttpError("Invitation not found", 404);
    }

    await assertPermission(
      client,
      accountId,
      inv.rows[0].customer_id,
      "customer-members:write",
    );

    await client.query(
      `UPDATE invitations SET status = 'revoked' WHERE id = $1`,
      [invitationId],
    );
  });
}
