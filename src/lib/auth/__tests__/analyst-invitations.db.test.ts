import { join } from "node:path";
import type { Pool } from "pg";
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import {
  closeAdminPool,
  createTestDatabase,
  dropTestDatabase,
  hasPostgres,
} from "../../db/__tests__/db-test-helpers";
import { withTransaction } from "../../db/client";
import { runMigrations } from "../../db/migrate";
import {
  acceptAnalystInvitation,
  createAnalystInvitation,
  deliverAnalystInvitation,
  diagnoseTerminalInvitation,
  listPendingAnalystInvitations,
  resolveInvitationType,
  revokeAnalystInvitation,
} from "../analyst-invitations";
import { hashToken } from "../invitations";

// The lib transitively imports `server-only` (via the email + audit modules);
// stub it so the module is importable under vitest.
vi.mock("server-only", () => ({}));

const MIGRATIONS_DIR = join(process.cwd(), "migrations", "auth");

// ---------------------------------------------------------------------------
// DB-backed integration tests for the analyst invitation acceptance path
// (#268): the dual token resolver, the terminal diagnostic, and the
// FOR UPDATE analyst-accept transaction.
// ---------------------------------------------------------------------------

describe.skipIf(!hasPostgres)("analyst invitation acceptance (DB)", () => {
  const LOCK_ID = 1268;
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

describe.skipIf(!hasPostgres)("analyst invitations (DB integration)", () => {
  const LOCK_ID = 1267;
  let pool: Pool;
  let dbName: string;

  let adminAccountId: string;
  let activeCustomerA: string;
  let activeCustomerB: string;
  let suspendedCustomer: string;

  beforeAll(async () => {
    const result = await createTestDatabase("analyst_invitations", "auth");
    pool = result.pool;
    dbName = result.dbName;

    await pool.query(`
      DO $$ BEGIN
        IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'aimer_auth') THEN
          CREATE ROLE aimer_auth LOGIN PASSWORD 'changeme';
        END IF;
      END $$
    `);

    await runMigrations(pool, MIGRATIONS_DIR, LOCK_ID);

    const admin = await pool.query<{ id: string }>(
      `INSERT INTO accounts (oidc_issuer, oidc_subject, username, display_name, email)
       VALUES ('test-issuer', 'admin-001', 'admin', 'Admin', 'admin@example.com')
       RETURNING id`,
    );
    adminAccountId = admin.rows[0].id;

    const ca = await pool.query<{ id: string }>(
      `INSERT INTO customers (external_key, name, status)
       VALUES ('cust-a', 'Customer A', 'active') RETURNING id`,
    );
    activeCustomerA = ca.rows[0].id;

    const cb = await pool.query<{ id: string }>(
      `INSERT INTO customers (external_key, name, status)
       VALUES ('cust-b', 'Customer B', 'active') RETURNING id`,
    );
    activeCustomerB = cb.rows[0].id;

    const cs = await pool.query<{ id: string }>(
      `INSERT INTO customers (external_key, name, status)
       VALUES ('cust-s', 'Suspended Customer', 'suspended') RETURNING id`,
    );
    suspendedCustomer = cs.rows[0].id;
  });

  afterEach(async () => {
    await pool.query(`DELETE FROM analyst_invitations`);
    await pool.query(`DELETE FROM analyst_customer_assignments`);
    await pool.query(`DELETE FROM accounts WHERE email <> 'admin@example.com'`);
  });

  afterAll(async () => {
    await dropTestDatabase(dbName, pool, "auth");
    await closeAdminPool();
  });

  function create(email: string, customerIds: string[]) {
    return withTransaction(pool, (client) =>
      createAnalystInvitation(client, {
        accountId: adminAccountId,
        email,
        customerIds,
      }),
    );
  }

  // -------------------------------------------------------------------------
  // Create + refresh
  // -------------------------------------------------------------------------

  it("creates a new pending invitation (refreshed = false)", async () => {
    const inv = await create("analyst@example.com", [activeCustomerA]);
    expect(inv.refreshed).toBe(false);
    expect(inv.email).toBe("analyst@example.com");
    expect(inv.customerIds).toEqual([activeCustomerA]);
    expect(inv.token).toBeTruthy();

    const row = await pool.query(
      `SELECT status, token_hash FROM analyst_invitations WHERE id = $1`,
      [inv.id],
    );
    expect(row.rows[0].status).toBe("pending");
    // Raw token is never persisted — only its hash.
    expect(row.rows[0].token_hash).toBe(hashToken(inv.token));
  });

  it("normalizes the email to lower-case", async () => {
    const inv = await create("Analyst@Example.COM", [activeCustomerA]);
    expect(inv.email).toBe("analyst@example.com");
    const row = await pool.query<{ email: string }>(
      `SELECT email FROM analyst_invitations WHERE id = $1`,
      [inv.id],
    );
    expect(row.rows[0].email).toBe("analyst@example.com");
  });

  it("refreshes an existing pending row in place (token, expiry, customers)", async () => {
    const first = await create("dup@example.com", [activeCustomerA]);

    // Force the first row's expiry into the near future so the refresh's
    // 7-day extension is observably later.
    await pool.query(
      `UPDATE analyst_invitations SET expires_at = NOW() + INTERVAL '1 day'
       WHERE id = $1`,
      [first.id],
    );
    const before = await pool.query<{ token_hash: string; expires_at: Date }>(
      `SELECT token_hash, expires_at FROM analyst_invitations WHERE id = $1`,
      [first.id],
    );

    const second = await create("dup@example.com", [
      activeCustomerA,
      activeCustomerB,
    ]);

    expect(second.refreshed).toBe(true);
    // Same row reused (pending-unique on lower(email)).
    expect(second.id).toBe(first.id);

    const after = await pool.query<{
      token_hash: string;
      expires_at: Date;
      customer_ids: string[];
    }>(
      `SELECT token_hash, expires_at, customer_ids
       FROM analyst_invitations WHERE id = $1`,
      [first.id],
    );
    // Token changed.
    expect(after.rows[0].token_hash).not.toBe(before.rows[0].token_hash);
    expect(after.rows[0].token_hash).toBe(hashToken(second.token));
    // Expiry extended.
    expect(after.rows[0].expires_at.getTime()).toBeGreaterThan(
      before.rows[0].expires_at.getTime(),
    );
    // customer_ids replaced.
    expect(after.rows[0].customer_ids.sort()).toEqual(
      [activeCustomerA, activeCustomerB].sort(),
    );

    // Exactly one pending row exists for this email.
    const count = await pool.query(
      `SELECT count(*) FROM analyst_invitations
       WHERE lower(email) = 'dup@example.com' AND status = 'pending'`,
    );
    expect(count.rows[0].count).toBe("1");
  });

  // -------------------------------------------------------------------------
  // customer_ids validation
  // -------------------------------------------------------------------------

  it("rejects an empty customerIds array", async () => {
    await expect(create("a@example.com", [])).rejects.toMatchObject({
      message: "invalid_customer_ids",
      statusCode: 400,
    });
  });

  it("rejects a non-UUID customer id", async () => {
    await expect(create("a@example.com", ["not-a-uuid"])).rejects.toMatchObject(
      { message: "invalid_customer_ids", statusCode: 400 },
    );
  });

  it("rejects a missing customer", async () => {
    await expect(
      create("a@example.com", ["00000000-0000-0000-0000-0000000000ff"]),
    ).rejects.toMatchObject({
      message: "invalid_customer_ids",
      statusCode: 400,
    });
  });

  it("rejects an inactive (suspended) customer", async () => {
    await expect(
      create("a@example.com", [activeCustomerA, suspendedCustomer]),
    ).rejects.toMatchObject({
      message: "invalid_customer_ids",
      statusCode: 400,
    });
  });

  it("rejects an invalid email", async () => {
    await expect(
      create("not-an-email", [activeCustomerA]),
    ).rejects.toMatchObject({ message: "invalid_email", statusCode: 400 });
  });

  // -------------------------------------------------------------------------
  // already_assigned (409)
  // -------------------------------------------------------------------------

  async function makeAnalyst(
    email: string,
    eligible: boolean,
    assignedCustomerIds: string[],
  ): Promise<string> {
    const acc = await pool.query<{ id: string }>(
      `INSERT INTO accounts (oidc_issuer, oidc_subject, username, display_name, email, analyst_eligible)
       VALUES ('test-issuer', $1, $1, $1, $2, $3)
       RETURNING id`,
      [`sub-${email}`, email, eligible],
    );
    const accId = acc.rows[0].id;
    for (const cid of assignedCustomerIds) {
      await pool.query(
        `INSERT INTO analyst_customer_assignments (account_id, customer_id, assigned_by)
         VALUES ($1, $2, $3)`,
        [accId, cid, adminAccountId],
      );
    }
    return accId;
  }

  it("returns 409 already_assigned when every requested customer is assigned to an eligible account", async () => {
    await makeAnalyst("dup-analyst@example.com", true, [
      activeCustomerA,
      activeCustomerB,
    ]);

    await expect(
      create("dup-analyst@example.com", [activeCustomerA, activeCustomerB]),
    ).rejects.toMatchObject({ message: "already_assigned", statusCode: 409 });
  });

  it("proceeds when at least one requested customer is not yet assigned (no partial 409)", async () => {
    await makeAnalyst("partial@example.com", true, [activeCustomerA]);

    const inv = await create("partial@example.com", [
      activeCustomerA,
      activeCustomerB,
    ]);
    expect(inv.refreshed).toBe(false);
    expect(inv.customerIds.sort()).toEqual(
      [activeCustomerA, activeCustomerB].sort(),
    );
  });

  it("ignores stale assignments on a revoked (analyst_eligible = false) account", async () => {
    await makeAnalyst("revoked-analyst@example.com", false, [
      activeCustomerA,
      activeCustomerB,
    ]);

    // Even though both customers have assignment rows, the account is not
    // eligible, so the request must proceed (not 409).
    const inv = await create("revoked-analyst@example.com", [
      activeCustomerA,
      activeCustomerB,
    ]);
    expect(inv.id).toBeTruthy();
  });

  // -------------------------------------------------------------------------
  // List
  // -------------------------------------------------------------------------

  it("lists only pending, unexpired invitations in camelCase", async () => {
    const inv = await create("list@example.com", [activeCustomerA]);

    const list = await listPendingAnalystInvitations(pool);
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({
      id: inv.id,
      email: "list@example.com",
      customerIds: [activeCustomerA],
      invitedBy: adminAccountId,
    });
    expect(typeof list[0].expiresAt).toBe("string");
  });

  it("excludes pending-but-expired rows from the list", async () => {
    const inv = await create("expired@example.com", [activeCustomerA]);
    await pool.query(
      `UPDATE analyst_invitations SET expires_at = NOW() - INTERVAL '1 hour'
       WHERE id = $1`,
      [inv.id],
    );

    const list = await listPendingAnalystInvitations(pool);
    expect(list.find((i) => i.id === inv.id)).toBeUndefined();
  });

  // -------------------------------------------------------------------------
  // Revoke
  // -------------------------------------------------------------------------

  function revoke(id: string) {
    return withTransaction(pool, (client) =>
      revokeAnalystInvitation(client, id),
    );
  }

  it("revokes a pending, unexpired invitation", async () => {
    const inv = await create("rev@example.com", [activeCustomerA]);
    const res = await revoke(inv.id);
    expect(res).toEqual({ id: inv.id, status: "revoked" });

    const row = await pool.query<{ status: string }>(
      `SELECT status FROM analyst_invitations WHERE id = $1`,
      [inv.id],
    );
    expect(row.rows[0].status).toBe("revoked");
  });

  it("is idempotent on an already-revoked invitation", async () => {
    const inv = await create("rev2@example.com", [activeCustomerA]);
    await revoke(inv.id);
    const res = await revoke(inv.id);
    expect(res).toEqual({ id: inv.id, status: "revoked" });
  });

  it("returns 409 already_expired for a pending-but-expired invitation", async () => {
    const inv = await create("rev3@example.com", [activeCustomerA]);
    await pool.query(
      `UPDATE analyst_invitations SET expires_at = NOW() - INTERVAL '1 hour'
       WHERE id = $1`,
      [inv.id],
    );
    await expect(revoke(inv.id)).rejects.toMatchObject({
      message: "already_expired",
      statusCode: 409,
    });
  });

  it("returns 409 already_expired for an explicitly expired invitation", async () => {
    const inv = await create("rev4@example.com", [activeCustomerA]);
    await pool.query(
      `UPDATE analyst_invitations SET status = 'expired' WHERE id = $1`,
      [inv.id],
    );
    await expect(revoke(inv.id)).rejects.toMatchObject({
      message: "already_expired",
      statusCode: 409,
    });
  });

  it("returns 409 already_consumed for an accepted invitation", async () => {
    const inv = await create("rev5@example.com", [activeCustomerA]);
    await pool.query(
      `UPDATE analyst_invitations SET status = 'accepted' WHERE id = $1`,
      [inv.id],
    );
    await expect(revoke(inv.id)).rejects.toMatchObject({
      message: "already_consumed",
      statusCode: 409,
    });
  });

  it("returns 404 not_found for a missing invitation", async () => {
    await expect(
      revoke("00000000-0000-0000-0000-0000000000aa"),
    ).rejects.toMatchObject({ message: "not_found", statusCode: 404 });
  });

  // -------------------------------------------------------------------------
  // Post-commit delivery: email failure does not roll back the row
  // -------------------------------------------------------------------------

  it("records emailDelivery='sent' and keeps the row on a successful send", async () => {
    const inv = await create("deliver-ok@example.com", [activeCustomerA]);
    const audits: Array<Record<string, unknown>> = [];
    const capture = async (p: unknown) => {
      audits.push(p as Record<string, unknown>);
    };

    await deliverAnalystInvitation(
      {
        invitationId: inv.id,
        email: inv.email,
        token: inv.token,
        customerNames: inv.customerNames,
        customerIds: inv.customerIds,
        expiresAt: inv.expiresAt,
        baseUrl: "https://example.test",
        refreshed: inv.refreshed,
        actor: { accountId: adminAccountId },
      },
      {
        send: async () => {},
        audit: capture,
      },
    );

    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({
      action: "invitation.created",
      targetType: "analyst_invitation",
      targetId: inv.id,
      details: { refreshed: false, emailDelivery: "sent" },
    });

    const row = await pool.query<{ status: string }>(
      `SELECT status FROM analyst_invitations WHERE id = $1`,
      [inv.id],
    );
    expect(row.rows[0].status).toBe("pending");
  });

  it("records emailDelivery='failed' without rolling back the invitation row", async () => {
    const inv = await create("deliver-fail@example.com", [activeCustomerA]);
    const audits: Array<Record<string, unknown>> = [];
    const capture = async (p: unknown) => {
      audits.push(p as Record<string, unknown>);
    };

    await deliverAnalystInvitation(
      {
        invitationId: inv.id,
        email: inv.email,
        token: inv.token,
        customerNames: inv.customerNames,
        customerIds: inv.customerIds,
        expiresAt: inv.expiresAt,
        baseUrl: "https://example.test",
        refreshed: inv.refreshed,
        actor: { accountId: adminAccountId },
      },
      {
        send: async () => {
          throw new Error("SMTP down");
        },
        audit: capture,
      },
    );

    expect(audits).toHaveLength(1);
    expect(audits[0].details).toMatchObject({ emailDelivery: "failed" });

    // The committed invitation row is untouched by the email failure.
    const row = await pool.query<{ status: string }>(
      `SELECT status FROM analyst_invitations WHERE id = $1`,
      [inv.id],
    );
    expect(row.rows[0].status).toBe("pending");
  });
});
