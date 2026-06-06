import { randomBytes } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import type { AuditLogParams } from "../audit";
import { query, withTransaction } from "../db/client";
import type { AnalystInvitationEmailParams } from "../email/analyst-invitation";
import { HttpError } from "./errors";
import { hashToken } from "./invitations";

// ---------------------------------------------------------------------------
// Shared token-to-DB resolution for the analyst invitation acceptance path.
//
// The invite entry endpoint and the OIDC callback both classify an
// invitation token against the two invitation tables. Keeping that logic
// here (rather than duplicated in the two route files) is what stops the
// member and analyst flows from diverging — see #268.
// ---------------------------------------------------------------------------

/**
 * Result of the primary token-hash type resolver. `member`/`analyst` mean a
 * **pending, unexpired** row was found in the corresponding table;
 * `not_found` means neither table yielded such a row (the token may still
 * exist in a terminal state — see {@link diagnoseTerminalInvitation}).
 */
export type InvitationType = "member" | "analyst" | "not_found";

/**
 * Classify a raw invitation token by lookup order: first `invitations`
 * (pending + unexpired), then `analyst_invitations` (pending + unexpired).
 *
 * Only rejects when **neither** table yields a pending, unexpired match — it
 * must not short-circuit on a non-pending row in one table, because the same
 * token hash never collides across tables but a terminal row in the first
 * table must not mask a live row that (by construction) cannot exist in the
 * second. The dual lookup is shared by the invite entry endpoint (to validate
 * before setting the cookie) and the callback (to dispatch).
 */
export async function resolveInvitationType(
  pool: Pool,
  token: string,
): Promise<InvitationType> {
  const tokenHash = hashToken(token);

  const memberRows = await query<{ exists: boolean }>(
    pool,
    `SELECT true AS exists FROM invitations
     WHERE token_hash = $1 AND status = 'pending' AND expires_at > NOW()`,
    [tokenHash],
  );
  if (memberRows.length > 0) {
    return "member";
  }

  const analystRows = await query<{ exists: boolean }>(
    pool,
    `SELECT true AS exists FROM analyst_invitations
     WHERE token_hash = $1 AND status = 'pending' AND expires_at > NOW()`,
    [tokenHash],
  );
  if (analystRows.length > 0) {
    return "analyst";
  }

  return "not_found";
}

// ---------------------------------------------------------------------------
// Terminal-reason mapper (pure) + diagnostic lookup
// ---------------------------------------------------------------------------

/** Short canonical analyst reasons for a row in a terminal state. */
export type TerminalReason = "already_consumed" | "revoked" | "expired";

interface TerminalRow {
  status: string;
  expires_at: Date;
}

/**
 * Map a fetched invitation row's terminal state to its `audit.details.reason`.
 *
 * Pure over the row — unit-testable in isolation:
 * - `accepted` → `already_consumed`
 * - `revoked`  → `revoked`
 * - `expired`, or `pending` with `expires_at` in the past → `expired`
 *
 * A `pending` row only reaches this mapper because the primary resolver
 * already excluded pending + unexpired, so such a row is necessarily expired.
 */
export function mapTerminalReason(row: TerminalRow): TerminalReason {
  if (row.status === "accepted") {
    return "already_consumed";
  }
  if (row.status === "revoked") {
    return "revoked";
  }
  // 'expired', or 'pending' with expires_at <= NOW() (resolver already
  // excluded the live pending case).
  return "expired";
}

/**
 * Outcome of the follow-up diagnostic lookup run when the primary resolver
 * returns `not_found`. Branches on the **source table** so the callback can
 * preserve the legacy member audit for terminal member rows while applying
 * the short analyst reasons to terminal analyst rows.
 */
export type DiagnosticResult =
  | { source: "invitation"; id: string }
  | { source: "analyst_invitation"; id: string; reason: TerminalReason }
  | { source: "none" };

/**
 * Follow-up query without the `pending + unexpired` predicates, against both
 * tables, used to classify a token that the primary resolver reported as
 * `not_found`. The mapped reason is recorded in audit but does not change the
 * deny outcome (all such tokens are non-retryable denials).
 */
export async function diagnoseTerminalInvitation(
  pool: Pool,
  token: string,
): Promise<DiagnosticResult> {
  const tokenHash = hashToken(token);

  const memberRows = await query<{ id: string }>(
    pool,
    `SELECT id FROM invitations WHERE token_hash = $1`,
    [tokenHash],
  );
  if (memberRows.length > 0) {
    return { source: "invitation", id: memberRows[0].id };
  }

  const analystRows = await query<{
    id: string;
    status: string;
    expires_at: Date;
  }>(
    pool,
    `SELECT id, status, expires_at FROM analyst_invitations
     WHERE token_hash = $1`,
    [tokenHash],
  );
  if (analystRows.length > 0) {
    return {
      source: "analyst_invitation",
      id: analystRows[0].id,
      reason: mapTerminalReason(analystRows[0]),
    };
  }

  return { source: "none" };
}

// ---------------------------------------------------------------------------
// Analyst-accept transaction
// ---------------------------------------------------------------------------

export interface AcceptAnalystInvitationParams {
  token: string;
  accountId: string;
  email: string | undefined;
  emailVerified: boolean | undefined;
}

/** Retryable reasons leave the DB row in `status = 'pending'`. */
export type AnalystRetryableReason = "email_mismatch" | "email_verified_false";

/** Non-retryable reasons mean the row is already terminal or never existed. */
export type AnalystTerminalReason =
  | "expired"
  | "already_consumed"
  | "revoked"
  | "not_found";

export type AcceptAnalystInvitationResult =
  | { outcome: "accepted"; invitationId: string; customerIds: string[] }
  | {
      outcome: "retryable";
      reason: AnalystRetryableReason;
      invitationId: string;
    }
  | {
      outcome: "non_retryable";
      reason: AnalystTerminalReason;
      invitationId?: string;
    };

/**
 * Consume an analyst invitation under a `FOR UPDATE` row lock.
 *
 * On a pending, unexpired match with verified, matching email: set
 * `accounts.analyst_eligible = true`, insert one
 * `analyst_customer_assignments` row per `customer_ids` entry, and mark the
 * invitation `accepted` — all in one transaction.
 *
 * Outcome taxonomy:
 * - `retryable` (`email_mismatch`, `email_verified_false`): the DB row stays
 *   `pending` so the user can fix the account and re-click the email link.
 *   "Retryable" refers to the **DB row**, not the cookie — the callback still
 *   clears the `invitation_token` cookie on every exit path; a retry re-sets
 *   it via the invite entry endpoint.
 * - `non_retryable` (`expired`, `already_consumed`, `revoked`, `not_found`):
 *   the row is already terminal (or vanished) — normally unreachable because
 *   the resolver matched pending + unexpired moments earlier; only a
 *   concurrent terminalization within the cookie's 5-min TTL lands here.
 */
export async function acceptAnalystInvitation(
  pool: Pool,
  params: AcceptAnalystInvitationParams,
): Promise<AcceptAnalystInvitationResult> {
  const tokenHash = hashToken(params.token);

  return withTransaction(pool, async (client) => {
    const locked = await client.query<{
      id: string;
      email: string;
      customer_ids: string[];
      invited_by: string;
    }>(
      `SELECT id, email, customer_ids, invited_by FROM analyst_invitations
       WHERE token_hash = $1 AND status = 'pending' AND expires_at > NOW()
       FOR UPDATE`,
      [tokenHash],
    );

    if (locked.rows.length === 0) {
      // Concurrent terminalization since the resolver classified this as
      // 'analyst'. Re-read without predicates to classify the terminal state.
      const term = await client.query<{
        id: string;
        status: string;
        expires_at: Date;
      }>(
        `SELECT id, status, expires_at FROM analyst_invitations
         WHERE token_hash = $1`,
        [tokenHash],
      );
      if (term.rows.length === 0) {
        return { outcome: "non_retryable", reason: "not_found" };
      }
      return {
        outcome: "non_retryable",
        reason: mapTerminalReason(term.rows[0]),
        invitationId: term.rows[0].id,
      };
    }

    const inv = locked.rows[0];

    // email_verified must be true (fail-closed). The row stays pending
    // (retryable); the cookie is still cleared by the callback on exit.
    if (params.emailVerified !== true) {
      return {
        outcome: "retryable",
        reason: "email_verified_false",
        invitationId: inv.id,
      };
    }

    // Email match (case-insensitive, lowercase-normalized). Retryable: the
    // row stays pending so the correct account can accept on a later click.
    if (
      !params.email ||
      params.email.toLowerCase() !== inv.email.toLowerCase()
    ) {
      return {
        outcome: "retryable",
        reason: "email_mismatch",
        invitationId: inv.id,
      };
    }

    // Grant analyst eligibility.
    await client.query(
      `UPDATE accounts SET analyst_eligible = true WHERE id = $1`,
      [params.accountId],
    );

    // One assignment per customer. `assigned_by` is NOT NULL with no default;
    // source it from the invitation's `invited_by` (the System Administrator
    // who issued the invite), not the accepting account. An empty
    // `customer_ids` ('{}') inserts no rows — the account is analyst_eligible
    // but has no accessible customers yet, so it cannot sign in until a later
    // assignment, which is intentional.
    for (const customerId of inv.customer_ids) {
      await client.query(
        `INSERT INTO analyst_customer_assignments
           (account_id, customer_id, assigned_by)
         VALUES ($1, $2, $3)
         ON CONFLICT DO NOTHING`,
        [params.accountId, customerId, inv.invited_by],
      );
    }

    // Consume invitation.
    await client.query(
      `UPDATE analyst_invitations SET status = 'accepted' WHERE id = $1`,
      [inv.id],
    );

    return {
      outcome: "accepted",
      invitationId: inv.id,
      customerIds: inv.customer_ids,
    };
  });
}

// ---------------------------------------------------------------------------
// Deny-page key mapping
// ---------------------------------------------------------------------------

/**
 * Map a short analyst reason onto the existing member-side deny-page keys.
 * Do not introduce analyst-specific deny-page keys — the analyst-only
 * terminal states with no member equivalent all fold onto the generic
 * `invitation_expired` key.
 */
export function analystReasonToDenyKey(
  reason: AnalystRetryableReason | AnalystTerminalReason,
): string {
  switch (reason) {
    case "email_mismatch":
      return "invitation_email_mismatch";
    case "email_verified_false":
      return "invitation_email_not_verified";
    default:
      // expired, already_consumed, revoked, not_found
      return "invitation_expired";
  }
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface CreateAnalystInvitationParams {
  accountId: string;
  email: string;
  customerIds: string[];
}

export interface CreatedAnalystInvitation {
  id: string;
  email: string;
  customerIds: string[];
  expiresAt: Date;
  /** True when an existing pending row was refreshed in place. */
  refreshed: boolean;
  /** Raw token — used only to build the email link. Never persisted/returned. */
  token: string;
  /** Names of the validated customers — used for the email body. */
  customerNames: string[];
}

export interface PendingAnalystInvitation {
  id: string;
  email: string;
  customerIds: string[];
  invitedBy: string;
  expiresAt: string;
}

export type RevokeAnalystInvitationResult = {
  id: string;
  status: "revoked";
};

// ---------------------------------------------------------------------------
// Validation helpers
// ---------------------------------------------------------------------------

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Pragmatic email-syntax check: non-empty, single @, no whitespace, a dot in
// the domain. Mirrors the loose validation used elsewhere — authoritative
// verification happens via the email round-trip, not a regex.
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function generateToken(): { raw: string; hash: string } {
  const raw = randomBytes(32).toString("base64url");
  return { raw, hash: hashToken(raw) };
}

/**
 * Validate the requested customer IDs and return their names (for the email).
 *
 * Rejects with `400 invalid_customer_ids` when the array is empty, contains a
 * non-UUID, or references a customer that does not exist or is not `active`.
 * The `analyst_invitations.customer_ids` column permits an empty array for an
 * eligible-but-unassigned analyst (#269), but the *invitation* create path
 * deliberately requires ≥1 active customer.
 */
async function validateCustomerIds(
  client: PoolClient,
  customerIds: string[],
): Promise<{ ids: string[]; names: string[] }> {
  if (!Array.isArray(customerIds) || customerIds.length === 0) {
    throw new HttpError("invalid_customer_ids", 400);
  }
  if (customerIds.some((id) => typeof id !== "string" || !UUID_RE.test(id))) {
    throw new HttpError("invalid_customer_ids", 400);
  }

  // De-duplicate before comparing counts so a repeated id is not mistaken for
  // a missing customer.
  const uniqueIds = [...new Set(customerIds)];

  const result = await client.query<{ id: string; name: string }>(
    `SELECT id, name FROM customers
     WHERE id = ANY($1::uuid[]) AND status = 'active'`,
    [uniqueIds],
  );

  if (result.rows.length !== uniqueIds.length) {
    throw new HttpError("invalid_customer_ids", 400);
  }

  return {
    ids: uniqueIds,
    names: result.rows.map((r) => r.name),
  };
}

/**
 * Throw `409 already_assigned` only when **every** requested customer already
 * has an `analyst_customer_assignments` row whose account email matches
 * (case-insensitive) AND `analyst_eligible = true`. Stale rows on a revoked
 * (`analyst_eligible = false`) account do not count — revocation keeps the
 * rows by policy. If at least one requested customer is unassigned, the
 * request proceeds (no partial 409).
 */
async function assertNotFullyAssigned(
  client: PoolClient,
  email: string,
  customerIds: string[],
): Promise<void> {
  const result = await client.query<{ customer_id: string }>(
    `SELECT DISTINCT aca.customer_id
     FROM analyst_customer_assignments aca
     JOIN accounts a ON a.id = aca.account_id
     WHERE aca.customer_id = ANY($1::uuid[])
       AND lower(a.email) = lower($2)
       AND a.analyst_eligible = true`,
    [customerIds, email],
  );

  const assigned = new Set(result.rows.map((r) => r.customer_id));
  const allAssigned = customerIds.every((id) => assigned.has(id));
  if (allAssigned) {
    throw new HttpError("already_assigned", 409);
  }
}

// ---------------------------------------------------------------------------
// Create (or refresh) — transactional
// ---------------------------------------------------------------------------

export async function createAnalystInvitation(
  client: PoolClient,
  params: CreateAnalystInvitationParams,
): Promise<CreatedAnalystInvitation> {
  const email = typeof params.email === "string" ? params.email.trim() : "";
  if (!email || !EMAIL_RE.test(email)) {
    throw new HttpError("invalid_email", 400);
  }

  const { ids, names } = await validateCustomerIds(client, params.customerIds);
  await assertNotFullyAssigned(client, email, ids);

  const { raw, hash } = generateToken();

  // Refresh the existing pending row for lower(email) in place: new token,
  // new expiry, replaced customer_ids. Mirrors the member upsert in
  // `invitations.ts`. The (xmax <> 0) trick reports whether the row was
  // updated (refresh) vs inserted (new).
  const result = await client.query<{
    id: string;
    expires_at: Date;
    refreshed: boolean;
  }>(
    `INSERT INTO analyst_invitations (email, customer_ids, invited_by, token_hash)
     VALUES (lower($1), $2::uuid[], $3, $4)
     ON CONFLICT (lower(email)) WHERE status = 'pending'
     DO UPDATE SET
       customer_ids = EXCLUDED.customer_ids,
       invited_by = EXCLUDED.invited_by,
       token_hash = EXCLUDED.token_hash,
       expires_at = NOW() + INTERVAL '7 days',
       created_at = NOW()
     RETURNING id, expires_at, (xmax <> 0) AS refreshed`,
    [email, ids, params.accountId, hash],
  );

  const row = result.rows[0];
  return {
    id: row.id,
    email: email.toLowerCase(),
    customerIds: ids,
    expiresAt: row.expires_at,
    refreshed: row.refreshed,
    token: raw,
    customerNames: names,
  };
}

// ---------------------------------------------------------------------------
// List pending
// ---------------------------------------------------------------------------

export async function listPendingAnalystInvitations(
  pool: Pool,
): Promise<PendingAnalystInvitation[]> {
  // The `expires_at > NOW()` predicate is required: no sweeper rewrites
  // expired rows to 'expired', so a pending-but-expired row would otherwise
  // appear here yet fail revoke with 409 already_expired.
  const result = await pool.query<{
    id: string;
    email: string;
    customer_ids: string[];
    invited_by: string;
    expires_at: Date;
  }>(
    `SELECT id, email, customer_ids, invited_by, expires_at
     FROM analyst_invitations
     WHERE status = 'pending' AND expires_at > NOW()
     ORDER BY created_at DESC`,
  );

  return result.rows.map((row) => ({
    id: row.id,
    email: row.email,
    customerIds: row.customer_ids,
    invitedBy: row.invited_by,
    expiresAt: row.expires_at.toISOString(),
  }));
}

// ---------------------------------------------------------------------------
// Revoke — classify by effective status (no background sweeper exists)
// ---------------------------------------------------------------------------

export async function revokeAnalystInvitation(
  client: PoolClient,
  invitationId: string,
): Promise<RevokeAnalystInvitationResult> {
  const inv = await client.query<{
    id: string;
    status: string;
    expired: boolean;
  }>(
    `SELECT id, status, (expires_at <= NOW()) AS expired
     FROM analyst_invitations
     WHERE id = $1
     FOR UPDATE`,
    [invitationId],
  );

  if (inv.rows.length === 0) {
    throw new HttpError("not_found", 404);
  }

  const { status, expired } = inv.rows[0];

  if (status === "revoked") {
    // Idempotent.
    return { id: invitationId, status: "revoked" };
  }
  if (status === "accepted") {
    throw new HttpError("already_consumed", 409);
  }
  if (status === "expired") {
    // Defensive: no sweeper currently writes this status.
    throw new HttpError("already_expired", 409);
  }
  // status === 'pending'
  if (expired) {
    throw new HttpError("already_expired", 409);
  }

  await client.query(
    `UPDATE analyst_invitations SET status = 'revoked' WHERE id = $1`,
    [invitationId],
  );
  return { id: invitationId, status: "revoked" };
}

// ---------------------------------------------------------------------------
// Post-commit email delivery + audit
//
// Runs AFTER the invitation row is committed (via Next.js `after()` in the
// route, or inline as a fallback). Sends the analyst email, derives the
// `emailDelivery` outcome, then emits the `invitation.created` audit event
// carrying that real outcome. The invitation already exists at this point —
// an email failure is logged but never rolls anything back.
// ---------------------------------------------------------------------------

export interface DeliverAnalystInvitationParams {
  invitationId: string;
  email: string;
  token: string;
  customerNames: string[];
  customerIds: string[];
  expiresAt: Date;
  baseUrl: string;
  refreshed: boolean;
  actor: {
    accountId: string;
    ipAddress?: string;
    sid?: string;
    correlationId?: string;
  };
}

export interface DeliverAnalystInvitationDeps {
  send?: (params: AnalystInvitationEmailParams) => Promise<void>;
  audit?: (params: AuditLogParams) => Promise<void>;
}

export async function deliverAnalystInvitation(
  params: DeliverAnalystInvitationParams,
  deps: DeliverAnalystInvitationDeps = {},
): Promise<void> {
  // Default implementations are imported lazily so this module's load-time
  // dependency graph stays free of `server-only` (the email + audit modules
  // pull it in). The acceptance-path callers — the OIDC callback and invite
  // entry routes — import this module but never reach delivery, and their
  // unit tests must remain importable without a `server-only` stub.
  const send =
    deps.send ??
    (await import("../email/analyst-invitation")).sendAnalystInvitationEmail;
  const audit = deps.audit ?? (await import("../audit")).auditLog;

  let emailDelivery: "sent" | "failed" = "sent";
  try {
    await send({
      to: params.email,
      token: params.token,
      customerNames: params.customerNames,
      expiresAt: params.expiresAt,
      baseUrl: params.baseUrl,
    });
  } catch (err) {
    emailDelivery = "failed";
    console.error(
      `[email] Failed to send analyst invitation ${params.invitationId}:`,
      err,
    );
  }

  // Manual audit (NOT the declarative withAuth auto-emit, which fires at
  // response-build time and cannot observe a send that resolves later).
  await audit({
    actorId: params.actor.accountId,
    authContext: "admin",
    action: "invitation.created",
    targetType: "analyst_invitation",
    targetId: params.invitationId,
    details: {
      refreshed: params.refreshed,
      emailDelivery,
      customerIds: params.customerIds,
    },
    ipAddress: params.actor.ipAddress,
    sid: params.actor.sid,
    correlationId: params.actor.correlationId,
  });
}
