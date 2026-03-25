import { join } from "node:path";
import type { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  closeAdminPool,
  createTestDatabase,
  dropTestDatabase,
  hasPostgres,
} from "../../db/__tests__/db-test-helpers";
import { runMigrations } from "../../db/migrate";
import { HttpError } from "../errors";
import {
  listPendingInvitations,
  revokeInvitation,
} from "../invitation-management";
import { createInvitation } from "../invitations";

const MIGRATIONS_DIR = join(process.cwd(), "migrations", "auth");
const LOCK_ID = 1001;

describe.skipIf(!hasPostgres)("invitation management (DB integration)", () => {
  let pool: Pool;
  let dbName: string;

  let managerAccountId: string;
  let userAccountId: string;
  let customerId: string;
  let otherCustomerId: string;
  let otherManagerAccountId: string;

  beforeAll(async () => {
    const result = await createTestDatabase("inv_mgmt", "auth");
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

    // Create customers
    const cust = await pool.query<{ id: string }>(
      `INSERT INTO customers (external_key, name)
         VALUES ('mgmt-cust', 'Mgmt Customer')
         RETURNING id`,
    );
    customerId = cust.rows[0].id;

    // Lookup roles
    const roles = await pool.query<{ id: number; name: string }>(
      `SELECT id, name FROM roles
         WHERE auth_context = 'general' AND name IN ('User', 'Manager')`,
    );
    let userRoleId: number | undefined;
    let managerRoleId: number | undefined;
    for (const r of roles.rows) {
      if (r.name === "User") userRoleId = r.id;
      if (r.name === "Manager") managerRoleId = r.id;
    }

    // Manager account
    const mgr = await pool.query<{ id: string }>(
      `INSERT INTO accounts (oidc_issuer, oidc_subject, username, display_name, email)
         VALUES ('test-issuer', 'mgmt-mgr-001', 'mgmt-manager', 'Manager', 'mgmt-manager@example.com')
         RETURNING id`,
    );
    managerAccountId = mgr.rows[0].id;

    await pool.query(
      `INSERT INTO account_customer_memberships (account_id, customer_id, role_id)
         VALUES ($1, $2, $3)`,
      [managerAccountId, customerId, managerRoleId],
    );

    // User account (has membership but no customer-members:read/write)
    const usr = await pool.query<{ id: string }>(
      `INSERT INTO accounts (oidc_issuer, oidc_subject, username, display_name, email)
         VALUES ('test-issuer', 'mgmt-usr-001', 'mgmt-user', 'User', 'mgmt-user@example.com')
         RETURNING id`,
    );
    userAccountId = usr.rows[0].id;

    await pool.query(
      `INSERT INTO account_customer_memberships (account_id, customer_id, role_id)
         VALUES ($1, $2, $3)`,
      [userAccountId, customerId, userRoleId],
    );

    // Other customer + its own manager (for cross-customer isolation tests)
    const otherCust = await pool.query<{ id: string }>(
      `INSERT INTO customers (external_key, name)
         VALUES ('mgmt-other', 'Other Customer')
         RETURNING id`,
    );
    otherCustomerId = otherCust.rows[0].id;

    const otherMgr = await pool.query<{ id: string }>(
      `INSERT INTO accounts (oidc_issuer, oidc_subject, username, display_name, email)
         VALUES ('test-issuer', 'mgmt-other-mgr', 'other-manager', 'Other Manager', 'other-mgr@example.com')
         RETURNING id`,
    );
    otherManagerAccountId = otherMgr.rows[0].id;

    await pool.query(
      `INSERT INTO account_customer_memberships (account_id, customer_id, role_id)
         VALUES ($1, $2, $3)`,
      [otherManagerAccountId, otherCustomerId, managerRoleId],
    );
  });

  afterAll(async () => {
    await dropTestDatabase(dbName, pool, "auth");
    await closeAdminPool();
  });

  // Helper: create a pending invitation
  async function createPending(email: string, role = "User") {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const result = await createInvitation(client, {
        accountId: managerAccountId,
        customerId,
        email,
        roleName: role,
      });
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
  // List pending invitations
  // =========================================================================

  it("lists pending invitations for a customer", async () => {
    await createPending("list-a@example.com", "User");
    await createPending("list-b@example.com", "Manager");

    const invitations = await listPendingInvitations(
      pool,
      managerAccountId,
      customerId,
    );

    const emails = invitations.map((i) => i.email);
    expect(emails).toContain("list-a@example.com");
    expect(emails).toContain("list-b@example.com");

    for (const inv of invitations) {
      expect(inv.id).toBeDefined();
      expect(inv.role).toBeDefined();
      expect(inv.createdAt).toBeDefined();
      expect(inv.expiresAt).toBeDefined();
    }
  });

  it("does not list expired invitations", async () => {
    const inv = await createPending("expired-list@example.com");

    await pool.query(
      `UPDATE invitations SET expires_at = NOW() - INTERVAL '1 second' WHERE id = $1`,
      [inv.id],
    );

    const invitations = await listPendingInvitations(
      pool,
      managerAccountId,
      customerId,
    );
    const emails = invitations.map((i) => i.email);
    expect(emails).not.toContain("expired-list@example.com");
  });

  it("does not list accepted invitations", async () => {
    const inv = await createPending("accepted-list@example.com");

    await pool.query(
      `UPDATE invitations SET status = 'accepted' WHERE id = $1`,
      [inv.id],
    );

    const invitations = await listPendingInvitations(
      pool,
      managerAccountId,
      customerId,
    );
    const emails = invitations.map((i) => i.email);
    expect(emails).not.toContain("accepted-list@example.com");
  });

  it("does not list revoked invitations", async () => {
    const inv = await createPending("revoked-list@example.com");

    await pool.query(
      `UPDATE invitations SET status = 'revoked' WHERE id = $1`,
      [inv.id],
    );

    const invitations = await listPendingInvitations(
      pool,
      managerAccountId,
      customerId,
    );
    const emails = invitations.map((i) => i.email);
    expect(emails).not.toContain("revoked-list@example.com");
  });

  it("rejects User role listing (no customer-members:read permission)", async () => {
    // User role has membership but lacks customer-members:read
    try {
      await listPendingInvitations(pool, userAccountId, customerId);
      expect.unreachable("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(HttpError);
      expect((err as HttpError).statusCode).toBe(403);
    }
  });

  it("rejects listing without any membership (403)", async () => {
    const outsider = await pool.query<{ id: string }>(
      `INSERT INTO accounts (oidc_issuer, oidc_subject, username, display_name)
         VALUES ('test-issuer', 'mgmt-outsider-001', 'outsider', 'Outsider')
         RETURNING id`,
    );

    try {
      await listPendingInvitations(pool, outsider.rows[0].id, customerId);
      expect.unreachable("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(HttpError);
      expect((err as HttpError).statusCode).toBe(403);
    }
  });

  it("returns empty array when no pending invitations exist", async () => {
    // Create a fresh customer with no invitations
    const freshCust = await pool.query<{ id: string }>(
      `INSERT INTO customers (external_key, name)
         VALUES ('mgmt-empty', 'Empty Customer')
         RETURNING id`,
    );

    // Give manager access to this customer
    const roles = await pool.query<{ id: number }>(
      `SELECT id FROM roles WHERE name = 'Manager' AND auth_context = 'general'`,
    );
    await pool.query(
      `INSERT INTO account_customer_memberships (account_id, customer_id, role_id)
         VALUES ($1, $2, $3)`,
      [managerAccountId, freshCust.rows[0].id, roles.rows[0].id],
    );

    const invitations = await listPendingInvitations(
      pool,
      managerAccountId,
      freshCust.rows[0].id,
    );
    expect(invitations).toEqual([]);
  });

  it("returns invitations ordered by created_at DESC (newest first)", async () => {
    const inv1 = await createPending("order-first@example.com");
    const inv2 = await createPending("order-second@example.com");

    const invitations = await listPendingInvitations(
      pool,
      managerAccountId,
      customerId,
    );

    const idx1 = invitations.findIndex((i) => i.id === inv1.id);
    const idx2 = invitations.findIndex((i) => i.id === inv2.id);
    // inv2 was created later, so it should appear first (lower index)
    expect(idx2).toBeLessThan(idx1);
  });

  it("returns correct field values in response", async () => {
    const inv = await createPending("fields-check@example.com", "Manager");

    const invitations = await listPendingInvitations(
      pool,
      managerAccountId,
      customerId,
    );
    const found = invitations.find((i) => i.id === inv.id);

    expect(found).toBeDefined();
    expect(found?.email).toBe("fields-check@example.com");
    expect(found?.role).toBe("Manager");
    // createdAt and expiresAt should be valid ISO strings
    expect(() => new Date(found?.createdAt as string)).not.toThrow();
    expect(() => new Date(found?.expiresAt as string)).not.toThrow();
    expect(new Date(found?.expiresAt as string).getTime()).toBeGreaterThan(
      new Date(found?.createdAt as string).getTime(),
    );
  });

  it("does not return invitations from another customer", async () => {
    // Create invitation in other customer
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await createInvitation(client, {
        accountId: otherManagerAccountId,
        customerId: otherCustomerId,
        email: "cross-customer@example.com",
        roleName: "User",
      });
      await client.query("COMMIT");
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }

    // List for primary customer — should not include other customer's invitation
    const invitations = await listPendingInvitations(
      pool,
      managerAccountId,
      customerId,
    );
    const emails = invitations.map((i) => i.email);
    expect(emails).not.toContain("cross-customer@example.com");
  });

  // =========================================================================
  // Revoke invitation
  // =========================================================================

  it("revokes a pending invitation (soft delete)", async () => {
    const inv = await createPending("revoke-test@example.com");

    await revokeInvitation(pool, managerAccountId, inv.id);

    const row = await pool.query<{ status: string }>(
      `SELECT status FROM invitations WHERE id = $1`,
      [inv.id],
    );
    expect(row.rows[0].status).toBe("revoked");
  });

  it("revoked invitation no longer appears in list", async () => {
    const inv = await createPending("revoke-vanish@example.com");

    // Verify it appears before revoke
    let invitations = await listPendingInvitations(
      pool,
      managerAccountId,
      customerId,
    );
    expect(invitations.map((i) => i.email)).toContain(
      "revoke-vanish@example.com",
    );

    await revokeInvitation(pool, managerAccountId, inv.id);

    // Verify it no longer appears
    invitations = await listPendingInvitations(
      pool,
      managerAccountId,
      customerId,
    );
    expect(invitations.map((i) => i.email)).not.toContain(
      "revoke-vanish@example.com",
    );
  });

  it("returns 404 when revoking non-existent invitation", async () => {
    try {
      await revokeInvitation(
        pool,
        managerAccountId,
        "00000000-0000-0000-0000-000000000000",
      );
      expect.unreachable("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(HttpError);
      expect((err as HttpError).statusCode).toBe(404);
    }
  });

  it("returns 404 when revoking already-accepted invitation", async () => {
    const inv = await createPending("revoke-accepted@example.com");
    await pool.query(
      `UPDATE invitations SET status = 'accepted' WHERE id = $1`,
      [inv.id],
    );

    try {
      await revokeInvitation(pool, managerAccountId, inv.id);
      expect.unreachable("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(HttpError);
      expect((err as HttpError).statusCode).toBe(404);
    }
  });

  it("returns 404 when revoking already-revoked invitation", async () => {
    const inv = await createPending("revoke-double@example.com");
    await revokeInvitation(pool, managerAccountId, inv.id);

    try {
      await revokeInvitation(pool, managerAccountId, inv.id);
      expect.unreachable("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(HttpError);
      expect((err as HttpError).statusCode).toBe(404);
    }
  });

  it("returns 404 when revoking expired invitation", async () => {
    const inv = await createPending("revoke-expired@example.com");
    await pool.query(
      `UPDATE invitations SET expires_at = NOW() - INTERVAL '1 second' WHERE id = $1`,
      [inv.id],
    );

    try {
      await revokeInvitation(pool, managerAccountId, inv.id);
      expect.unreachable("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(HttpError);
      expect((err as HttpError).statusCode).toBe(404);
    }
  });

  it("rejects cross-customer revocation (403)", async () => {
    // Create invitation in primary customer
    const inv = await createPending("cross-revoke@example.com");

    // Other customer's manager tries to revoke it → 403
    try {
      await revokeInvitation(pool, otherManagerAccountId, inv.id);
      expect.unreachable("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(HttpError);
      expect((err as HttpError).statusCode).toBe(403);
    }

    // Verify invitation is still pending (not revoked)
    const row = await pool.query<{ status: string }>(
      `SELECT status FROM invitations WHERE id = $1`,
      [inv.id],
    );
    expect(row.rows[0].status).toBe("pending");
  });

  it("rejects revocation without customer-members:write permission (403)", async () => {
    const inv = await createPending("revoke-forbidden@example.com");

    try {
      await revokeInvitation(pool, userAccountId, inv.id);
      expect.unreachable("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(HttpError);
      expect((err as HttpError).statusCode).toBe(403);
    }
  });
});
