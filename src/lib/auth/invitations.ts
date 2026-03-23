import { createHash, randomBytes } from "node:crypto";
import type { PoolClient } from "pg";

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
// Errors
// ---------------------------------------------------------------------------

export class HttpError extends Error {
  constructor(
    message: string,
    public readonly statusCode: number,
  ) {
    super(message);
    this.name = "HttpError";
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function generateToken(): { raw: string; hash: string } {
  const raw = randomBytes(32).toString("base64url");
  const hash = createHash("sha256").update(raw).digest("hex");
  return { raw, hash };
}

// ---------------------------------------------------------------------------
// Permission check
// ---------------------------------------------------------------------------

async function assertManagerPermission(
  client: PoolClient,
  accountId: string,
  customerId: string,
): Promise<void> {
  const result = await client.query<{ permission: string }>(
    `SELECT rp.permission
     FROM account_customer_memberships acm
     JOIN role_permissions rp ON rp.role_id = acm.role_id
     WHERE acm.account_id = $1 AND acm.customer_id = $2
       AND rp.permission = 'customer-members:write'`,
    [accountId, customerId],
  );
  if (result.rows.length === 0) {
    throw new HttpError("Forbidden", 403);
  }
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
  await assertManagerPermission(client, params.accountId, params.customerId);
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
