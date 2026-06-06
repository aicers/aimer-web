import type { Pool } from "pg";
import { query, withTransaction } from "../db/client";
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
