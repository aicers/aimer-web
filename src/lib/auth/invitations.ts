import { createHash, randomBytes } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { withTransaction } from "../db/client";
import { HttpError } from "./errors";
import { assertPermission } from "./permissions";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface CreateInvitationParams {
  accountId: string;
  customerId: string;
  email: string;
  roleName: string;
}

export interface CreatedInvitation {
  id: string;
  token: string;
  expiresAt: Date;
  customerName: string;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

export function hashToken(raw: string): string {
  return createHash("sha256").update(raw).digest("hex");
}

function generateToken(): { raw: string; hash: string } {
  const raw = randomBytes(32).toString("base64url");
  const hash = hashToken(raw);
  return { raw, hash };
}

// ---------------------------------------------------------------------------
// Existing member check
// ---------------------------------------------------------------------------

async function assertNotAlreadyMember(
  client: PoolClient,
  customerId: string,
  email: string,
): Promise<void> {
  const result = await client.query(
    `SELECT 1
     FROM account_customer_memberships acm
     JOIN accounts a ON a.id = acm.account_id
     WHERE acm.customer_id = $1 AND lower(a.email) = lower($2)`,
    [customerId, email],
  );
  if (result.rows.length > 0) {
    throw new HttpError("already_member", 409);
  }
}

// ---------------------------------------------------------------------------
// Customer existence check
// ---------------------------------------------------------------------------

async function assertCustomerExists(
  client: PoolClient,
  customerId: string,
): Promise<string> {
  const result = await client.query<{ name: string }>(
    `SELECT name FROM customers WHERE id = $1`,
    [customerId],
  );
  if (result.rows.length === 0) {
    throw new HttpError("Customer not found", 404);
  }
  return result.rows[0].name;
}

// ---------------------------------------------------------------------------
// Role resolution — restricted to User and Manager per #76 spec.
// Analyst invitations are a separate flow (Discussion #5 §5.5.2).
// auth_context enforcement is additionally guarded by DB trigger.
// ---------------------------------------------------------------------------

const ALLOWED_INVITATION_ROLES = new Set(["User", "Manager"]);

async function resolveRole(
  client: PoolClient,
  roleName: string,
): Promise<number> {
  if (!ALLOWED_INVITATION_ROLES.has(roleName)) {
    throw new HttpError("Role must be User or Manager", 400);
  }
  const result = await client.query<{ id: number }>(
    `SELECT id FROM roles WHERE name = $1`,
    [roleName],
  );
  if (result.rows.length === 0) {
    throw new HttpError("Invalid role", 400);
  }
  return result.rows[0].id;
}

// ---------------------------------------------------------------------------
// Create invitation (transactional)
// ---------------------------------------------------------------------------

export async function createInvitation(
  client: PoolClient,
  params: CreateInvitationParams,
): Promise<CreatedInvitation> {
  const customerName = await assertCustomerExists(client, params.customerId);
  await assertPermission(
    client,
    params.accountId,
    params.customerId,
    "customer-members:write",
  );
  await assertNotAlreadyMember(client, params.customerId, params.email);

  const roleId = await resolveRole(client, params.roleName);
  const { raw, hash } = generateToken();

  // Upsert: refresh existing pending invitation for the same
  // customer+email with a new token and expiry (Discussion #5 §5.5.2).
  try {
    const result = await client.query<{ id: string; expires_at: Date }>(
      `INSERT INTO invitations (token_hash, customer_id, invited_email, role_id, invited_by)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (customer_id, lower(invited_email)) WHERE status = 'pending'
       DO UPDATE SET
         token_hash = EXCLUDED.token_hash,
         role_id = EXCLUDED.role_id,
         invited_by = EXCLUDED.invited_by,
         expires_at = NOW() + INTERVAL '7 days',
         created_at = NOW()
       RETURNING id, expires_at`,
      [hash, params.customerId, params.email, roleId, params.accountId],
    );

    return {
      id: result.rows[0].id,
      token: raw,
      expiresAt: result.rows[0].expires_at,
      customerName,
    };
  } catch (err: unknown) {
    const pgErr = err as {
      code?: string;
      message?: string;
    };

    // DB trigger: role must be general-context
    if (
      pgErr.code === "P0001" &&
      pgErr.message?.includes("invitations.role_id must reference")
    ) {
      throw new HttpError("Role must be a general-context role", 400);
    }

    throw err;
  }
}

// ---------------------------------------------------------------------------
// Accept invitation (transactional)
// ---------------------------------------------------------------------------

export interface AcceptInvitationParams {
  token: string;
  accountId: string;
  email: string | undefined;
  emailVerified: boolean | undefined;
}

export type AcceptInvitationResult =
  | { deny: "invitation_expired" }
  | { deny: "invitation_email_not_verified" }
  | { deny: "invitation_email_mismatch" }
  | { deny: null; invitationId: string; customerId: string };

export async function acceptInvitation(
  pool: Pool,
  params: AcceptInvitationParams,
): Promise<AcceptInvitationResult> {
  const tokenHash = hashToken(params.token);

  return withTransaction(pool, async (client) => {
    const invRows = await client.query<{
      id: string;
      customer_id: string;
      invited_email: string;
      role_id: number;
    }>(
      `SELECT id, customer_id, invited_email, role_id FROM invitations
       WHERE token_hash = $1 AND status = 'pending' AND expires_at > NOW()
       FOR UPDATE`,
      [tokenHash],
    );

    if (invRows.rows.length === 0) {
      return { deny: "invitation_expired" };
    }

    const inv = invRows.rows[0];

    // email_verified must be true (fail-closed)
    if (params.emailVerified !== true) {
      return { deny: "invitation_email_not_verified" };
    }

    // Email match (case-insensitive)
    if (
      !params.email ||
      params.email.toLowerCase() !== inv.invited_email.toLowerCase()
    ) {
      return { deny: "invitation_email_mismatch" };
    }

    // Idempotent membership creation
    await client.query(
      `INSERT INTO account_customer_memberships (account_id, customer_id, role_id)
       VALUES ($1, $2, $3)
       ON CONFLICT (account_id, customer_id) DO NOTHING`,
      [params.accountId, inv.customer_id, inv.role_id],
    );

    // Consume invitation
    await client.query(
      `UPDATE invitations SET status = 'accepted' WHERE id = $1`,
      [inv.id],
    );

    return {
      deny: null,
      invitationId: inv.id,
      customerId: inv.customer_id,
    };
  });
}
