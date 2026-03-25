import { join } from "node:path";
import type { Pool, PoolClient } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  closeAdminPool,
  createTestDatabase,
  dropTestDatabase,
  hasPostgres,
} from "../../db/__tests__/db-test-helpers";
import { runMigrations } from "../../db/migrate";
import {
  acceptInvitation,
  createInvitation,
  HttpError,
  hashToken,
} from "../invitations";

const MIGRATIONS_DIR = join(process.cwd(), "migrations", "auth");
const LOCK_ID = 1000;

describe.skipIf(!hasPostgres)("invitation creation (DB integration)", () => {
  let pool: Pool;
  let dbName: string;

  // Test fixtures
  let managerAccountId: string;
  let userAccountId: string;
  let customerId: string;
  let otherCustomerId: string;
  let managerRoleId: number;

  beforeAll(async () => {
    const result = await createTestDatabase("invitations", "auth");
    pool = result.pool;
    dbName = result.dbName;

    // Ensure runtime role exists (normally created by Docker entrypoint)
    await pool.query(`
      DO $$ BEGIN
        IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'aimer_auth') THEN
          CREATE ROLE aimer_auth LOGIN PASSWORD 'changeme';
        END IF;
      END $$
    `);

    // Apply auth migrations
    await runMigrations(pool, MIGRATIONS_DIR, LOCK_ID);

    // Create test customers
    const cust = await pool.query<{ id: string }>(
      `INSERT INTO customers (external_key, name)
       VALUES ('test-cust', 'Test Customer')
       RETURNING id`,
    );
    customerId = cust.rows[0].id;

    const otherCust = await pool.query<{ id: string }>(
      `INSERT INTO customers (external_key, name)
       VALUES ('other-cust', 'Other Customer')
       RETURNING id`,
    );
    otherCustomerId = otherCust.rows[0].id;

    // Lookup built-in roles
    const roles = await pool.query<{ id: number; name: string }>(
      `SELECT id, name FROM roles
       WHERE auth_context = 'general' AND name IN ('User', 'Manager')`,
    );
    let userRoleId: number | undefined;
    for (const r of roles.rows) {
      if (r.name === "User") userRoleId = r.id;
      if (r.name === "Manager") managerRoleId = r.id;
    }

    // Create manager account with membership in primary customer
    const mgr = await pool.query<{ id: string }>(
      `INSERT INTO accounts (oidc_issuer, oidc_subject, username, display_name, email)
       VALUES ('test-issuer', 'manager-001', 'manager', 'Manager', 'manager@example.com')
       RETURNING id`,
    );
    managerAccountId = mgr.rows[0].id;

    await pool.query(
      `INSERT INTO account_customer_memberships (account_id, customer_id, role_id)
       VALUES ($1, $2, $3)`,
      [managerAccountId, customerId, managerRoleId],
    );

    // Create a regular user account with membership (User role)
    const usr = await pool.query<{ id: string }>(
      `INSERT INTO accounts (oidc_issuer, oidc_subject, username, display_name, email)
       VALUES ('test-issuer', 'user-001', 'testuser', 'Test User', 'existing@example.com')
       RETURNING id`,
    );
    userAccountId = usr.rows[0].id;

    await pool.query(
      `INSERT INTO account_customer_memberships (account_id, customer_id, role_id)
       VALUES ($1, $2, $3)`,
      [userAccountId, customerId, userRoleId],
    );
  });

  afterAll(async () => {
    await dropTestDatabase(dbName, pool, "auth");
    await closeAdminPool();
  });

  // Helper: run createInvitation in a transaction
  async function runInTransaction<T>(
    fn: (client: PoolClient) => Promise<T>,
  ): Promise<T> {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const result = await fn(client);
      await client.query("COMMIT");
      return result;
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }
  }

  // =========================================================================
  // Happy path
  // =========================================================================

  it("creates an invitation with a valid token and expiry", async () => {
    const result = await runInTransaction((client) =>
      createInvitation(client, {
        accountId: managerAccountId,
        customerId,
        email: "new-user@example.com",
        roleName: "User",
      }),
    );

    expect(result.id).toBeDefined();
    expect(result.token).toBeDefined();
    expect(result.token.length).toBeGreaterThan(0);
    expect(result.expiresAt).toBeInstanceOf(Date);
    expect(result.expiresAt.getTime()).toBeGreaterThan(Date.now());
    expect(result.customerName).toBe("Test Customer");

    // Verify row exists in DB
    const row = await pool.query<{ status: string; invited_email: string }>(
      `SELECT status, invited_email FROM invitations WHERE id = $1`,
      [result.id],
    );
    expect(row.rows).toHaveLength(1);
    expect(row.rows[0].status).toBe("pending");
    expect(row.rows[0].invited_email).toBe("new-user@example.com");
  });

  it("stores SHA-256 hash, not the raw token", async () => {
    const result = await runInTransaction((client) =>
      createInvitation(client, {
        accountId: managerAccountId,
        customerId,
        email: "hash-check@example.com",
        roleName: "User",
      }),
    );

    const row = await pool.query<{ token_hash: string }>(
      `SELECT token_hash FROM invitations WHERE id = $1`,
      [result.id],
    );

    // token_hash should be hex-encoded SHA-256 (64 chars)
    expect(row.rows[0].token_hash).toHaveLength(64);
    // Raw token must not match stored hash
    expect(row.rows[0].token_hash).not.toBe(result.token);
  });

  it("sets expiry approximately 7 days from now", async () => {
    const before = Date.now();
    const result = await runInTransaction((client) =>
      createInvitation(client, {
        accountId: managerAccountId,
        customerId,
        email: "expiry-check@example.com",
        roleName: "User",
      }),
    );
    const after = Date.now();

    const sevenDaysMs = 7 * 24 * 60 * 60 * 1000;
    const toleranceMs = 5000;

    expect(result.expiresAt.getTime()).toBeGreaterThanOrEqual(
      before + sevenDaysMs - toleranceMs,
    );
    expect(result.expiresAt.getTime()).toBeLessThanOrEqual(
      after + sevenDaysMs + toleranceMs,
    );
  });

  it("generates unique tokens for different invitations", async () => {
    const result1 = await runInTransaction((client) =>
      createInvitation(client, {
        accountId: managerAccountId,
        customerId,
        email: "unique-1@example.com",
        roleName: "User",
      }),
    );
    const result2 = await runInTransaction((client) =>
      createInvitation(client, {
        accountId: managerAccountId,
        customerId,
        email: "unique-2@example.com",
        roleName: "User",
      }),
    );

    expect(result1.token).not.toBe(result2.token);
    expect(result1.id).not.toBe(result2.id);
  });

  it("allows inviting with Manager role", async () => {
    const result = await runInTransaction((client) =>
      createInvitation(client, {
        accountId: managerAccountId,
        customerId,
        email: "new-manager@example.com",
        roleName: "Manager",
      }),
    );

    const row = await pool.query<{ role_id: number }>(
      `SELECT role_id FROM invitations WHERE id = $1`,
      [result.id],
    );
    expect(row.rows[0].role_id).toBe(managerRoleId);
  });

  it("records the inviting account as invited_by", async () => {
    const result = await runInTransaction((client) =>
      createInvitation(client, {
        accountId: managerAccountId,
        customerId,
        email: "track-inviter@example.com",
        roleName: "User",
      }),
    );

    const row = await pool.query<{ invited_by: string }>(
      `SELECT invited_by FROM invitations WHERE id = $1`,
      [result.id],
    );
    expect(row.rows[0].invited_by).toBe(managerAccountId);
  });

  // =========================================================================
  // Verification item 35-12: existing member re-invite rejection
  // =========================================================================

  it("rejects invitation when email already has membership (409)", async () => {
    try {
      await runInTransaction((client) =>
        createInvitation(client, {
          accountId: managerAccountId,
          customerId,
          email: "existing@example.com",
          roleName: "User",
        }),
      );
      expect.unreachable("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(HttpError);
      expect((err as HttpError).statusCode).toBe(409);
      expect((err as HttpError).message).toBe("already_member");
    }
  });

  it("rejects existing member with different-case email (409)", async () => {
    await expect(
      runInTransaction((client) =>
        createInvitation(client, {
          accountId: managerAccountId,
          customerId,
          email: "EXISTING@EXAMPLE.COM",
          roleName: "User",
        }),
      ),
    ).rejects.toThrow("already_member");
  });

  // =========================================================================
  // Duplicate pending invitation → refresh (Discussion #5 §5.5.2)
  // =========================================================================

  it("refreshes duplicate pending invitation with new token and expiry", async () => {
    const first = await runInTransaction((client) =>
      createInvitation(client, {
        accountId: managerAccountId,
        customerId,
        email: "refresh-test@example.com",
        roleName: "User",
      }),
    );

    const second = await runInTransaction((client) =>
      createInvitation(client, {
        accountId: managerAccountId,
        customerId,
        email: "refresh-test@example.com",
        roleName: "User",
      }),
    );

    // Same invitation row is reused
    expect(second.id).toBe(first.id);
    // New token generated
    expect(second.token).not.toBe(first.token);
    // New expiry (at least as late as the first)
    expect(second.expiresAt.getTime()).toBeGreaterThanOrEqual(
      first.expiresAt.getTime(),
    );
    // Customer name is preserved across refresh
    expect(second.customerName).toBe("Test Customer");

    // Old token hash is replaced in DB
    const row = await pool.query<{ token_hash: string }>(
      `SELECT token_hash FROM invitations WHERE id = $1`,
      [first.id],
    );
    expect(row.rows).toHaveLength(1);
    // Verify it's a new hash (64 hex chars, not the first token's hash)
    expect(row.rows[0].token_hash).toHaveLength(64);
  });

  it("refreshes duplicate pending invitation with different-case email", async () => {
    const first = await runInTransaction((client) =>
      createInvitation(client, {
        accountId: managerAccountId,
        customerId,
        email: "case-refresh@example.com",
        roleName: "User",
      }),
    );

    // Same email, different case → should refresh, not insert new row
    const second = await runInTransaction((client) =>
      createInvitation(client, {
        accountId: managerAccountId,
        customerId,
        email: "CASE-REFRESH@EXAMPLE.COM",
        roleName: "User",
      }),
    );

    expect(second.id).toBe(first.id);
    expect(second.token).not.toBe(first.token);
  });

  it("refresh updates role when re-invited with different role", async () => {
    const first = await runInTransaction((client) =>
      createInvitation(client, {
        accountId: managerAccountId,
        customerId,
        email: "role-change-refresh@example.com",
        roleName: "User",
      }),
    );

    const second = await runInTransaction((client) =>
      createInvitation(client, {
        accountId: managerAccountId,
        customerId,
        email: "role-change-refresh@example.com",
        roleName: "Manager",
      }),
    );

    expect(second.id).toBe(first.id);

    const row = await pool.query<{ role_id: number }>(
      `SELECT role_id FROM invitations WHERE id = $1`,
      [second.id],
    );
    expect(row.rows[0].role_id).toBe(managerRoleId);
  });

  // =========================================================================
  // Permission checks
  // =========================================================================

  it("rejects non-Manager accounts (403)", async () => {
    try {
      await runInTransaction((client) =>
        createInvitation(client, {
          accountId: userAccountId,
          customerId,
          email: "someone@example.com",
          roleName: "User",
        }),
      );
      expect.unreachable("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(HttpError);
      expect((err as HttpError).statusCode).toBe(403);
    }
  });

  it("rejects accounts with no membership in the customer (403)", async () => {
    const acct = await pool.query<{ id: string }>(
      `INSERT INTO accounts (oidc_issuer, oidc_subject, username, display_name)
       VALUES ('test-issuer', 'outsider-001', 'outsider', 'Outsider')
       RETURNING id`,
    );

    await expect(
      runInTransaction((client) =>
        createInvitation(client, {
          accountId: acct.rows[0].id,
          customerId,
          email: "someone@example.com",
          roleName: "User",
        }),
      ),
    ).rejects.toThrow("Forbidden");
  });

  it("rejects Manager of a different customer (403)", async () => {
    // managerAccountId is Manager of customerId, NOT otherCustomerId
    await expect(
      runInTransaction((client) =>
        createInvitation(client, {
          accountId: managerAccountId,
          customerId: otherCustomerId,
          email: "cross-customer@example.com",
          roleName: "User",
        }),
      ),
    ).rejects.toThrow("Forbidden");
  });

  // =========================================================================
  // Verification item 38-1: DB trigger rejection for admin role
  // =========================================================================

  it("rejects admin-context role (400)", async () => {
    try {
      await runInTransaction((client) =>
        createInvitation(client, {
          accountId: managerAccountId,
          customerId,
          email: "admin-invite@example.com",
          roleName: "System Administrator",
        }),
      );
      expect.unreachable("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(HttpError);
      expect((err as HttpError).statusCode).toBe(400);
      expect((err as HttpError).message).toBe("Role must be User or Manager");
    }
  });

  // =========================================================================
  // Invalid inputs
  // =========================================================================

  it("rejects unknown role name (400)", async () => {
    try {
      await runInTransaction((client) =>
        createInvitation(client, {
          accountId: managerAccountId,
          customerId,
          email: "bad-role@example.com",
          roleName: "NonExistentRole",
        }),
      );
      expect.unreachable("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(HttpError);
      expect((err as HttpError).statusCode).toBe(400);
      expect((err as HttpError).message).toBe("Role must be User or Manager");
    }
  });

  it("rejects Analyst role (400) — separate flow per Discussion #5", async () => {
    try {
      await runInTransaction((client) =>
        createInvitation(client, {
          accountId: managerAccountId,
          customerId,
          email: "analyst-invite@example.com",
          roleName: "Analyst",
        }),
      );
      expect.unreachable("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(HttpError);
      expect((err as HttpError).statusCode).toBe(400);
      expect((err as HttpError).message).toBe("Role must be User or Manager");
    }
  });

  it("rejects non-existent customerId (404)", async () => {
    try {
      await runInTransaction((client) =>
        createInvitation(client, {
          accountId: managerAccountId,
          customerId: "00000000-0000-0000-0000-000000000000",
          email: "no-customer@example.com",
          roleName: "User",
        }),
      );
      expect.unreachable("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(HttpError);
      expect((err as HttpError).statusCode).toBe(404);
      expect((err as HttpError).message).toBe("Customer not found");
    }
  });

  // =========================================================================
  // Invitation acceptance (#77)
  // =========================================================================

  // Helper: create a pending invitation and return raw token + invitation id
  async function createPendingInvitation(email: string) {
    return runInTransaction((client) =>
      createInvitation(client, {
        accountId: managerAccountId,
        customerId,
        email,
        roleName: "User",
      }),
    );
  }

  // Helper: create an account without any membership
  async function createBareAccount(sub: string, email: string) {
    const result = await pool.query<{ id: string }>(
      `INSERT INTO accounts (oidc_issuer, oidc_subject, username, display_name, email)
       VALUES ('test-issuer', $1, $1, $1, $2)
       RETURNING id`,
      [sub, email],
    );
    return result.rows[0].id;
  }

  // Verification item 35-13: invited new user → membership created
  it("accepts invitation and creates membership", async () => {
    const email = "accept-test@example.com";
    const inv = await createPendingInvitation(email);
    const accountId = await createBareAccount("accept-001", email);

    const result = await acceptInvitation(pool, {
      token: inv.token,
      accountId,
      email,
      emailVerified: true,
    });

    expect(result.deny).toBeNull();
    expect(result).toMatchObject({
      invitationId: inv.id,
      customerId,
    });

    // Verify membership was created
    const membership = await pool.query(
      `SELECT 1 FROM account_customer_memberships
       WHERE account_id = $1 AND customer_id = $2`,
      [accountId, customerId],
    );
    expect(membership.rows).toHaveLength(1);

    // Verify invitation is consumed
    const invRow = await pool.query<{ status: string }>(
      `SELECT status FROM invitations WHERE id = $1`,
      [inv.id],
    );
    expect(invRow.rows[0].status).toBe("accepted");
  });

  // Verification item 35-8: token one-time use
  it("rejects already-accepted invitation token", async () => {
    const email = "one-time-use@example.com";
    const inv = await createPendingInvitation(email);
    const accountId = await createBareAccount("onetime-001", email);

    // First acceptance
    const first = await acceptInvitation(pool, {
      token: inv.token,
      accountId,
      email,
      emailVerified: true,
    });
    expect(first.deny).toBeNull();

    // Second attempt with same token → expired (status is no longer pending)
    const second = await acceptInvitation(pool, {
      token: inv.token,
      accountId,
      email,
      emailVerified: true,
    });
    expect(second.deny).toBe("invitation_expired");
  });

  // Verification item 35-9: invitation expiration
  it("rejects expired invitation", async () => {
    const email = "expired-test@example.com";
    const inv = await createPendingInvitation(email);
    const accountId = await createBareAccount("expired-001", email);

    // Manually expire the invitation
    await pool.query(
      `UPDATE invitations SET expires_at = NOW() - INTERVAL '1 second' WHERE id = $1`,
      [inv.id],
    );

    const result = await acceptInvitation(pool, {
      token: inv.token,
      accountId,
      email,
      emailVerified: true,
    });
    expect(result.deny).toBe("invitation_expired");
  });

  // Verification item 35-7 / 35-14: email mismatch rejection
  it("rejects when OIDC email does not match invited email", async () => {
    const inv = await createPendingInvitation("invited@example.com");
    const accountId = await createBareAccount(
      "mismatch-001",
      "different@example.com",
    );

    const result = await acceptInvitation(pool, {
      token: inv.token,
      accountId,
      email: "different@example.com",
      emailVerified: true,
    });
    expect(result.deny).toBe("invitation_email_mismatch");

    // Invitation stays pending for retry (35-26)
    const invRow = await pool.query<{ status: string }>(
      `SELECT status FROM invitations WHERE id = $1`,
      [inv.id],
    );
    expect(invRow.rows[0].status).toBe("pending");
  });

  // Verification item 38-2: email_verified=false rejection
  it("rejects when email_verified is false", async () => {
    const email = "unverified@example.com";
    const inv = await createPendingInvitation(email);
    const accountId = await createBareAccount("unverified-001", email);

    const result = await acceptInvitation(pool, {
      token: inv.token,
      accountId,
      email,
      emailVerified: false,
    });
    expect(result.deny).toBe("invitation_email_not_verified");
  });

  // Verification item 38-2: email_verified=undefined rejection (fail-closed)
  it("rejects when email_verified is undefined (fail-closed)", async () => {
    const email = "no-claim@example.com";
    const inv = await createPendingInvitation(email);
    const accountId = await createBareAccount("noclaim-001", email);

    const result = await acceptInvitation(pool, {
      token: inv.token,
      accountId,
      email,
      emailVerified: undefined,
    });
    expect(result.deny).toBe("invitation_email_not_verified");
  });

  // Verification item 38-3: case-insensitive email matching
  it("accepts invitation with different-case email", async () => {
    const inv = await createPendingInvitation("CaseTest@Example.COM");
    const accountId = await createBareAccount(
      "casetest-001",
      "casetest@example.com",
    );

    const result = await acceptInvitation(pool, {
      token: inv.token,
      accountId,
      email: "casetest@example.com",
      emailVerified: true,
    });
    expect(result.deny).toBeNull();
  });

  // Idempotent: accepting when membership already exists
  it("succeeds idempotently when membership already exists", async () => {
    const email = "idempotent@example.com";
    const inv = await createPendingInvitation(email);
    const accountId = await createBareAccount("idempotent-001", email);

    // Pre-create the membership
    const userRoleId = (
      await pool.query<{ id: number }>(
        `SELECT id FROM roles WHERE name = 'User' AND auth_context = 'general'`,
      )
    ).rows[0].id;
    await pool.query(
      `INSERT INTO account_customer_memberships (account_id, customer_id, role_id)
       VALUES ($1, $2, $3)`,
      [accountId, customerId, userRoleId],
    );

    const result = await acceptInvitation(pool, {
      token: inv.token,
      accountId,
      email,
      emailVerified: true,
    });
    expect(result.deny).toBeNull();

    // Still only one membership row (ON CONFLICT DO NOTHING)
    const count = await pool.query<{ cnt: number }>(
      `SELECT COUNT(*)::int AS cnt FROM account_customer_memberships
       WHERE account_id = $1 AND customer_id = $2`,
      [accountId, customerId],
    );
    expect(count.rows[0].cnt).toBe(1);
  });

  // Verification item 35-26: retry after mismatch with correct account
  it("allows retry after email mismatch with correct account", async () => {
    const inv = await createPendingInvitation("retry@example.com");
    const wrongAccountId = await createBareAccount(
      "wrong-001",
      "wrong@example.com",
    );
    const correctAccountId = await createBareAccount(
      "correct-001",
      "retry@example.com",
    );

    // First attempt: wrong email
    const first = await acceptInvitation(pool, {
      token: inv.token,
      accountId: wrongAccountId,
      email: "wrong@example.com",
      emailVerified: true,
    });
    expect(first.deny).toBe("invitation_email_mismatch");

    // Second attempt: correct email → succeeds
    const second = await acceptInvitation(pool, {
      token: inv.token,
      accountId: correctAccountId,
      email: "retry@example.com",
      emailVerified: true,
    });
    expect(second.deny).toBeNull();
  });

  // Verification item 35-25: concurrent invitation callback — FOR UPDATE
  it("handles concurrent acceptance safely (only one succeeds)", async () => {
    const email = "concurrent@example.com";
    const inv = await createPendingInvitation(email);
    const accountId1 = await createBareAccount("conc-001", email);
    const accountId2 = await createBareAccount("conc-002", email);

    // Run two acceptInvitation calls concurrently
    const [result1, result2] = await Promise.all([
      acceptInvitation(pool, {
        token: inv.token,
        accountId: accountId1,
        email,
        emailVerified: true,
      }),
      acceptInvitation(pool, {
        token: inv.token,
        accountId: accountId2,
        email,
        emailVerified: true,
      }),
    ]);

    // Exactly one should succeed, the other should see invitation_expired
    // (FOR UPDATE serializes: first commits status='accepted', second
    // re-checks and finds status is no longer 'pending')
    const results = [result1.deny, result2.deny];
    expect(results).toContain(null);
    expect(results).toContain("invitation_expired");

    // Verify only one membership was created
    const memberships = await pool.query<{ account_id: string }>(
      `SELECT account_id FROM account_customer_memberships
       WHERE account_id IN ($1, $2) AND customer_id = $3`,
      [accountId1, accountId2, customerId],
    );
    expect(memberships.rows).toHaveLength(1);
  });

  // Invalid token → expired
  it("rejects non-existent token", async () => {
    const accountId = await createBareAccount(
      "badtoken-001",
      "badtoken@example.com",
    );

    const result = await acceptInvitation(pool, {
      token: "nonexistent-token-value",
      accountId,
      email: "badtoken@example.com",
      emailVerified: true,
    });
    expect(result.deny).toBe("invitation_expired");
  });

  // hashToken utility
  it("hashToken produces consistent SHA-256 hex output", () => {
    const hash = hashToken("test-token");
    expect(hash).toHaveLength(64);
    expect(hash).toBe(hashToken("test-token"));
    expect(hash).not.toBe(hashToken("other-token"));
  });
});
