import { join } from "node:path";
import type { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  closeAdminPool,
  createTestDatabase,
  dropTestDatabase,
  hasPostgres,
} from "@/lib/db/__tests__/db-test-helpers";
import { runMigrations } from "@/lib/db/migrate";
import {
  acceptAnalystInvitation,
  diagnoseTerminalInvitation,
  resolveInvitationType,
} from "../analyst-invitations";
import { hashToken } from "../invitations";

// ---------------------------------------------------------------------------
// DB-backed integration tests for the analyst invitation acceptance path
// (#268): the dual token resolver, the terminal diagnostic, and the
// FOR UPDATE analyst-accept transaction.
// ---------------------------------------------------------------------------

const MIGRATIONS_DIR = join(process.cwd(), "migrations", "auth");
const LOCK_ID = 1268;

describe.skipIf(!hasPostgres)("analyst invitation acceptance (DB)", () => {
  let pool: Pool;
  let dbName: string;

  let inviterId: string; // System Administrator who issues invites
  let customerAId: string;
  let customerBId: string;

  beforeAll(async () => {
    const result = await createTestDatabase("analyst_invitations", "auth");
    pool = result.pool;
    dbName = result.dbName;
    await runMigrations(pool, MIGRATIONS_DIR, LOCK_ID);

    const inviter = await pool.query<{ id: string }>(
      `INSERT INTO accounts (oidc_issuer, oidc_subject, username, display_name)
       VALUES ('test-issuer', 'inviter-sub', 'inviter', 'Inviter')
       RETURNING id`,
    );
    inviterId = inviter.rows[0].id;

    const custA = await pool.query<{ id: string }>(
      `INSERT INTO customers (external_key, name) VALUES ('cust-a', 'Customer A') RETURNING id`,
    );
    customerAId = custA.rows[0].id;
    const custB = await pool.query<{ id: string }>(
      `INSERT INTO customers (external_key, name) VALUES ('cust-b', 'Customer B') RETURNING id`,
    );
    customerBId = custB.rows[0].id;
  });

  afterAll(async () => {
    await dropTestDatabase(dbName, pool, "auth");
    await closeAdminPool();
  });

  async function makeAccount(subject: string): Promise<string> {
    const acct = await pool.query<{ id: string }>(
      `INSERT INTO accounts (oidc_issuer, oidc_subject, username, display_name)
       VALUES ('test-issuer', $1, $1, $1)
       RETURNING id`,
      [subject],
    );
    return acct.rows[0].id;
  }

  /** Insert a pending analyst invitation, returning its raw token. */
  async function makeAnalystInvitation(
    email: string,
    customerIds: string[],
    opts: { status?: string; expiresInDays?: number } = {},
  ): Promise<{ token: string; id: string }> {
    const token = `tok-${email}-${customerIds.length}-${opts.status ?? "pending"}`;
    const status = opts.status ?? "pending";
    const days = opts.expiresInDays ?? 7;
    const row = await pool.query<{ id: string }>(
      `INSERT INTO analyst_invitations
         (email, customer_ids, invited_by, token_hash, status, expires_at)
       VALUES ($1, $2, $3, $4, $5, NOW() + ($6 || ' days')::interval)
       RETURNING id`,
      [email, customerIds, inviterId, hashToken(token), status, String(days)],
    );
    return { token, id: row.rows[0].id };
  }

  // -------------------------------------------------------------------------
  // Resolver
  // -------------------------------------------------------------------------

  it("resolves a pending analyst token as 'analyst'", async () => {
    const { token } = await makeAnalystInvitation("analyst1@example.com", [
      customerAId,
    ]);
    expect(await resolveInvitationType(pool, token)).toBe("analyst");
  });

  it("resolves an unknown token as 'not_found'", async () => {
    expect(await resolveInvitationType(pool, "no-such-token")).toBe(
      "not_found",
    );
  });

  it("resolves a terminal analyst token as 'not_found'", async () => {
    const { token } = await makeAnalystInvitation(
      "accepted@example.com",
      [customerAId],
      { status: "accepted" },
    );
    expect(await resolveInvitationType(pool, token)).toBe("not_found");
  });

  it("resolves a pending member token as 'member'", async () => {
    // A member invitation requires a real role + customer.
    const role = await pool.query<{ id: number }>(
      `SELECT id FROM roles WHERE name = 'User' AND auth_context = 'general' LIMIT 1`,
    );
    const memberToken = "member-token-xyz";
    await pool.query(
      `INSERT INTO invitations (token_hash, customer_id, invited_email, role_id, invited_by)
       VALUES ($1, $2, 'memb@example.com', $3, $4)`,
      [hashToken(memberToken), customerAId, role.rows[0].id, inviterId],
    );
    expect(await resolveInvitationType(pool, memberToken)).toBe("member");
  });

  // -------------------------------------------------------------------------
  // Diagnostic
  // -------------------------------------------------------------------------

  it("diagnoses terminal analyst states to canonical reasons", async () => {
    const accepted = await makeAnalystInvitation(
      "diag-accepted@example.com",
      [],
      { status: "accepted" },
    );
    const revoked = await makeAnalystInvitation(
      "diag-revoked@example.com",
      [],
      {
        status: "revoked",
      },
    );
    const expired = await makeAnalystInvitation(
      "diag-expired@example.com",
      [],
      {
        status: "pending",
        expiresInDays: -1,
      },
    );

    expect(await diagnoseTerminalInvitation(pool, accepted.token)).toEqual({
      source: "analyst_invitation",
      id: accepted.id,
      reason: "already_consumed",
    });
    expect(await diagnoseTerminalInvitation(pool, revoked.token)).toEqual({
      source: "analyst_invitation",
      id: revoked.id,
      reason: "revoked",
    });
    expect(await diagnoseTerminalInvitation(pool, expired.token)).toEqual({
      source: "analyst_invitation",
      id: expired.id,
      reason: "expired",
    });
  });

  it("diagnoses an unknown token as source 'none'", async () => {
    expect(await diagnoseTerminalInvitation(pool, "nope")).toEqual({
      source: "none",
    });
  });

  // -------------------------------------------------------------------------
  // Accept transaction
  // -------------------------------------------------------------------------

  it("accepts: sets analyst_eligible, assigns customers via invited_by, consumes invite", async () => {
    const accountId = await makeAccount("accept-success");
    const { token, id } = await makeAnalystInvitation(
      "accept-success@example.com",
      [customerAId, customerBId],
    );

    const res = await acceptAnalystInvitation(pool, {
      token,
      accountId,
      email: "Accept-Success@Example.com", // case-insensitive match
      emailVerified: true,
    });

    expect(res).toEqual({
      outcome: "accepted",
      invitationId: id,
      customerIds: [customerAId, customerBId],
    });

    const acct = await pool.query<{ analyst_eligible: boolean }>(
      `SELECT analyst_eligible FROM accounts WHERE id = $1`,
      [accountId],
    );
    expect(acct.rows[0].analyst_eligible).toBe(true);

    const assignments = await pool.query<{
      customer_id: string;
      assigned_by: string;
    }>(
      `SELECT customer_id, assigned_by FROM analyst_customer_assignments
       WHERE account_id = $1 ORDER BY customer_id`,
      [accountId],
    );
    expect(assignments.rows).toHaveLength(2);
    // assigned_by sourced from the invitation's invited_by, not the accepter.
    for (const row of assignments.rows) {
      expect(row.assigned_by).toBe(inviterId);
    }

    const inv = await pool.query<{ status: string }>(
      `SELECT status FROM analyst_invitations WHERE id = $1`,
      [id],
    );
    expect(inv.rows[0].status).toBe("accepted");
  });

  it("accepts an empty customer_ids invite: eligible but no assignments", async () => {
    const accountId = await makeAccount("accept-empty");
    const { token } = await makeAnalystInvitation(
      "accept-empty@example.com",
      [],
    );

    const res = await acceptAnalystInvitation(pool, {
      token,
      accountId,
      email: "accept-empty@example.com",
      emailVerified: true,
    });
    expect(res.outcome).toBe("accepted");

    const acct = await pool.query<{ analyst_eligible: boolean }>(
      `SELECT analyst_eligible FROM accounts WHERE id = $1`,
      [accountId],
    );
    expect(acct.rows[0].analyst_eligible).toBe(true);

    const assignments = await pool.query(
      `SELECT 1 FROM analyst_customer_assignments WHERE account_id = $1`,
      [accountId],
    );
    expect(assignments.rows).toHaveLength(0);
  });

  it("email_verified=false is retryable and keeps the invite pending", async () => {
    const accountId = await makeAccount("accept-unverified");
    const { token, id } = await makeAnalystInvitation(
      "accept-unverified@example.com",
      [customerAId],
    );

    const res = await acceptAnalystInvitation(pool, {
      token,
      accountId,
      email: "accept-unverified@example.com",
      emailVerified: false,
    });
    expect(res).toEqual({
      outcome: "retryable",
      reason: "email_verified_false",
      invitationId: id,
    });

    const inv = await pool.query<{ status: string }>(
      `SELECT status FROM analyst_invitations WHERE id = $1`,
      [id],
    );
    expect(inv.rows[0].status).toBe("pending");
  });

  it("email mismatch keeps pending; the correct account then succeeds (item 42-1)", async () => {
    const wrongAccount = await makeAccount("wrong-acct");
    const rightAccount = await makeAccount("right-acct");
    const { token, id } = await makeAnalystInvitation(
      "retry-target@example.com",
      [customerAId],
    );

    const first = await acceptAnalystInvitation(pool, {
      token,
      accountId: wrongAccount,
      email: "someone-else@example.com",
      emailVerified: true,
    });
    expect(first).toEqual({
      outcome: "retryable",
      reason: "email_mismatch",
      invitationId: id,
    });

    // Row still pending → resolver still routes to analyst.
    expect(await resolveInvitationType(pool, token)).toBe("analyst");

    const second = await acceptAnalystInvitation(pool, {
      token,
      accountId: rightAccount,
      email: "retry-target@example.com",
      emailVerified: true,
    });
    expect(second.outcome).toBe("accepted");

    const inv = await pool.query<{ status: string }>(
      `SELECT status FROM analyst_invitations WHERE id = $1`,
      [id],
    );
    expect(inv.rows[0].status).toBe("accepted");
  });

  it("concurrent accepts on the same token serialize via FOR UPDATE — exactly one wins", async () => {
    const accountId = await makeAccount("concurrent-acct");
    const { token, id } = await makeAnalystInvitation(
      "concurrent@example.com",
      [customerAId],
    );

    const params = {
      token,
      accountId,
      email: "concurrent@example.com",
      emailVerified: true,
    };
    const [a, b] = await Promise.all([
      acceptAnalystInvitation(pool, params),
      acceptAnalystInvitation(pool, params),
    ]);

    const outcomes = [a.outcome, b.outcome].sort();
    // One acquires the pending row and accepts; the other finds it already
    // consumed (non-retryable already_consumed).
    expect(outcomes).toEqual(["accepted", "non_retryable"]);
    const loser = a.outcome === "non_retryable" ? a : b;
    expect(loser).toMatchObject({
      outcome: "non_retryable",
      reason: "already_consumed",
      invitationId: id,
    });
  });
});
