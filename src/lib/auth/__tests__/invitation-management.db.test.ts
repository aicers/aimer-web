import { join } from "node:path";
import type { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  closeAdminPool,
  createTestDatabase,
  dropTestDatabase,
  hasPostgres,
  runInTransaction,
} from "../../db/__tests__/db-test-helpers";
import { runMigrations } from "../../db/migrate";
import { HttpError } from "../errors";
import {
  listPendingInvitations,
  revokeInvitation,
} from "../invitation-management";
import { createInvitation } from "../invitations";

const MIGRATIONS_DIR = join(process.cwd(), "migrations", "auth");
const LOCK_ID = 1003;

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

    // Create test customers
    const cust = await pool.query<{ id: string }>(
      `INSERT INTO customers (external_key, name)
       VALUES ('mgmt-cust', 'Mgmt Customer')
       RETURNING id`,
    );
    customerId = cust.rows[0].id;

    const otherCust = await pool.query<{ id: string }>(
      `INSERT INTO customers (external_key, name)
       VALUES ('mgmt-other', 'Other Mgmt Customer')
       RETURNING id`,
    );
    otherCustomerId = otherCust.rows[0].id;

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

    // Manager account (member of customerId)
    const mgr = await pool.query<{ id: string }>(
      `INSERT INTO accounts (oidc_issuer, oidc_subject, username, display_name, email)
       VALUES ('test-issuer', 'mgmt-manager-001', 'mgmt-manager', 'Mgmt Manager', 'mgmt-manager@example.com')
       RETURNING id`,
    );
    managerAccountId = mgr.rows[0].id;

    await pool.query(
      `INSERT INTO account_customer_memberships (account_id, customer_id, role_id)
       VALUES ($1, $2, $3)`,
      [managerAccountId, customerId, managerRoleId],
    );

    // User account (member of customerId with User role — no read/write permission)
    const usr = await pool.query<{ id: string }>(
      `INSERT INTO accounts (oidc_issuer, oidc_subject, username, display_name, email)
       VALUES ('test-issuer', 'mgmt-user-001', 'mgmt-user', 'Mgmt User', 'mgmt-user@example.com')
       RETURNING id`,
    );
    userAccountId = usr.rows[0].id;

    await pool.query(
      `INSERT INTO account_customer_memberships (account_id, customer_id, role_id)
       VALUES ($1, $2, $3)`,
      [userAccountId, customerId, userRoleId],
    );

    // Manager of otherCustomer (for cross-customer isolation tests)
    const otherMgr = await pool.query<{ id: string }>(
      `INSERT INTO accounts (oidc_issuer, oidc_subject, username, display_name, email)
       VALUES ('test-issuer', 'mgmt-other-mgr-001', 'other-mgr', 'Other Manager', 'other-mgr@example.com')
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

  const txn = <T>(fn: Parameters<typeof runInTransaction<T>>[1]) =>
    runInTransaction<T>(pool, fn);

  // Helper: create a pending invitation in the primary customer
  async function seedInvitation(email: string, role = "User") {
    return txn((client) =>
      createInvitation(client, {
        accountId: managerAccountId,
        customerId,
        email,
        roleName: role,
      }),
    );
  }

  // Helper: create a pending invitation in the other customer
  async function seedOtherInvitation(email: string) {
    return txn((client) =>
      createInvitation(client, {
        accountId: otherManagerAccountId,
        customerId: otherCustomerId,
        email,
        roleName: "User",
      }),
    );
  }

  // =========================================================================
  // listPendingInvitations
  // =========================================================================

  it("lists pending invitations for a customer", async () => {
    await seedInvitation("list-a@example.com");
    await seedInvitation("list-b@example.com", "Manager");

    const list = await txn((client) =>
      listPendingInvitations(client, {
        accountId: managerAccountId,
        customerId,
      }),
    );

    const emails = list.map((i) => i.email);
    expect(emails).toContain("list-a@example.com");
    expect(emails).toContain("list-b@example.com");

    // Check shape
    const item = list.find((i) => i.email === "list-b@example.com");
    expect(item).toBeDefined();
    expect(item?.role).toBe("Manager");
    expect(item?.id).toBeDefined();
    expect(item?.createdAt).toBeDefined();
    expect(item?.expiresAt).toBeDefined();
  });

  it("returns empty array when no pending invitations exist", async () => {
    // Create a fresh customer with no invitations
    const fresh = await pool.query<{ id: string }>(
      `INSERT INTO customers (external_key, name)
       VALUES ('mgmt-empty', 'Empty Customer')
       RETURNING id`,
    );
    const roles = await pool.query<{ id: number }>(
      `SELECT id FROM roles WHERE name = 'Manager' AND auth_context = 'general'`,
    );
    await pool.query(
      `INSERT INTO account_customer_memberships (account_id, customer_id, role_id)
       VALUES ($1, $2, $3)`,
      [managerAccountId, fresh.rows[0].id, roles.rows[0].id],
    );

    const list = await txn((client) =>
      listPendingInvitations(client, {
        accountId: managerAccountId,
        customerId: fresh.rows[0].id,
      }),
    );

    expect(list).toEqual([]);
  });

  it("lists invitations ordered by created_at descending", async () => {
    const inv1 = await seedInvitation("order-a@example.com");

    // Backdate the first invitation so the second is newer
    await pool.query(
      `UPDATE invitations SET created_at = NOW() - INTERVAL '1 hour' WHERE id = $1`,
      [inv1.id],
    );

    await seedInvitation("order-b@example.com");

    const list = await txn((client) =>
      listPendingInvitations(client, {
        accountId: managerAccountId,
        customerId,
      }),
    );

    const orderA = list.findIndex((i) => i.email === "order-a@example.com");
    const orderB = list.findIndex((i) => i.email === "order-b@example.com");
    expect(orderA).toBeGreaterThan(-1);
    expect(orderB).toBeGreaterThan(-1);
    // B (newer) should appear before A (older) in DESC order
    expect(orderB).toBeLessThan(orderA);
  });

  it("excludes expired invitations from listing", async () => {
    const inv = await seedInvitation("expired-list@example.com");

    await pool.query(
      `UPDATE invitations SET expires_at = NOW() - INTERVAL '1 second' WHERE id = $1`,
      [inv.id],
    );

    const list = await txn((client) =>
      listPendingInvitations(client, {
        accountId: managerAccountId,
        customerId,
      }),
    );

    expect(list.map((i) => i.email)).not.toContain("expired-list@example.com");
  });

  it("excludes accepted invitations from listing", async () => {
    const inv = await seedInvitation("accepted-list@example.com");

    await pool.query(
      `UPDATE invitations SET status = 'accepted' WHERE id = $1`,
      [inv.id],
    );

    const list = await txn((client) =>
      listPendingInvitations(client, {
        accountId: managerAccountId,
        customerId,
      }),
    );

    expect(list.map((i) => i.email)).not.toContain("accepted-list@example.com");
  });

  it("excludes revoked invitations from listing", async () => {
    const inv = await seedInvitation("revoked-list@example.com");

    await pool.query(
      `UPDATE invitations SET status = 'revoked' WHERE id = $1`,
      [inv.id],
    );

    const list = await txn((client) =>
      listPendingInvitations(client, {
        accountId: managerAccountId,
        customerId,
      }),
    );

    expect(list.map((i) => i.email)).not.toContain("revoked-list@example.com");
  });

  it("does not include invitations from other customers", async () => {
    await seedOtherInvitation("cross-cust-isolation@example.com");

    const list = await txn((client) =>
      listPendingInvitations(client, {
        accountId: managerAccountId,
        customerId,
      }),
    );

    expect(list.map((i) => i.email)).not.toContain(
      "cross-cust-isolation@example.com",
    );
  });

  it("rejects listing by User role of the same customer (403)", async () => {
    await expect(
      txn((client) =>
        listPendingInvitations(client, {
          accountId: userAccountId,
          customerId,
        }),
      ),
    ).rejects.toThrow("Forbidden");
  });

  it("rejects listing without any membership (403)", async () => {
    await expect(
      txn((client) =>
        listPendingInvitations(client, {
          accountId: userAccountId,
          customerId: otherCustomerId,
        }),
      ),
    ).rejects.toThrow("Forbidden");
  });

  // =========================================================================
  // revokeInvitation
  // =========================================================================

  it("revokes a pending invitation", async () => {
    const inv = await seedInvitation("revoke-me@example.com");

    await txn((client) =>
      revokeInvitation(client, {
        accountId: managerAccountId,
        invitationId: inv.id,
      }),
    );

    const row = await pool.query<{ status: string }>(
      `SELECT status FROM invitations WHERE id = $1`,
      [inv.id],
    );
    expect(row.rows[0].status).toBe("revoked");
  });

  it("revoked invitation no longer appears in listing", async () => {
    const inv = await seedInvitation("revoke-list@example.com");

    await txn((client) =>
      revokeInvitation(client, {
        accountId: managerAccountId,
        invitationId: inv.id,
      }),
    );

    const list = await txn((client) =>
      listPendingInvitations(client, {
        accountId: managerAccountId,
        customerId,
      }),
    );

    expect(list.map((i) => i.email)).not.toContain("revoke-list@example.com");
  });

  it("returns 404 when revoking non-existent invitation", async () => {
    try {
      await txn((client) =>
        revokeInvitation(client, {
          accountId: managerAccountId,
          invitationId: "00000000-0000-0000-0000-000000000000",
        }),
      );
      expect.unreachable("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(HttpError);
      expect((err as HttpError).statusCode).toBe(404);
    }
  });

  it("returns 404 when revoking already accepted invitation", async () => {
    const inv = await seedInvitation("already-accepted@example.com");

    await pool.query(
      `UPDATE invitations SET status = 'accepted' WHERE id = $1`,
      [inv.id],
    );

    try {
      await txn((client) =>
        revokeInvitation(client, {
          accountId: managerAccountId,
          invitationId: inv.id,
        }),
      );
      expect.unreachable("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(HttpError);
      expect((err as HttpError).statusCode).toBe(404);
    }
  });

  it("returns 404 when revoking already revoked invitation", async () => {
    const inv = await seedInvitation("already-revoked@example.com");

    await txn((client) =>
      revokeInvitation(client, {
        accountId: managerAccountId,
        invitationId: inv.id,
      }),
    );

    try {
      await txn((client) =>
        revokeInvitation(client, {
          accountId: managerAccountId,
          invitationId: inv.id,
        }),
      );
      expect.unreachable("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(HttpError);
      expect((err as HttpError).statusCode).toBe(404);
    }
  });

  it("returns 404 when revoking an expired pending invitation", async () => {
    const inv = await seedInvitation("expired-revoke@example.com");

    await pool.query(
      `UPDATE invitations SET expires_at = NOW() - INTERVAL '1 second' WHERE id = $1`,
      [inv.id],
    );

    try {
      await txn((client) =>
        revokeInvitation(client, {
          accountId: managerAccountId,
          invitationId: inv.id,
        }),
      );
      expect.unreachable("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(HttpError);
      expect((err as HttpError).statusCode).toBe(404);
    }
  });

  it("handles concurrent revocation safely (only one succeeds)", async () => {
    const inv = await seedInvitation("concurrent-revoke@example.com");

    // Give otherManager write permission on this customer too
    const roles = await pool.query<{ id: number }>(
      `SELECT id FROM roles WHERE name = 'Manager' AND auth_context = 'general'`,
    );
    await pool.query(
      `INSERT INTO account_customer_memberships (account_id, customer_id, role_id)
       VALUES ($1, $2, $3)
       ON CONFLICT (account_id, customer_id) DO NOTHING`,
      [otherManagerAccountId, customerId, roles.rows[0].id],
    );

    const results = await Promise.allSettled([
      txn((client) =>
        revokeInvitation(client, {
          accountId: managerAccountId,
          invitationId: inv.id,
        }),
      ),
      txn((client) =>
        revokeInvitation(client, {
          accountId: otherManagerAccountId,
          invitationId: inv.id,
        }),
      ),
    ]);

    // One succeeds, the other gets 404 (status is no longer 'pending')
    const statuses = results.map((r) =>
      r.status === "fulfilled" ? "ok" : "rejected",
    );
    expect(statuses).toContain("ok");
    expect(statuses).toContain("rejected");

    const rejected = results.find((r) => r.status === "rejected") as
      | PromiseRejectedResult
      | undefined;
    expect(rejected?.reason).toBeInstanceOf(HttpError);
    expect((rejected?.reason as HttpError).statusCode).toBe(404);

    // Verify row is revoked
    const row = await pool.query<{ status: string }>(
      `SELECT status FROM invitations WHERE id = $1`,
      [inv.id],
    );
    expect(row.rows[0].status).toBe("revoked");
  });

  it("returns 404 when User role revokes (no permission leak)", async () => {
    const inv = await seedInvitation("no-perm-revoke@example.com");

    try {
      await txn((client) =>
        revokeInvitation(client, {
          accountId: userAccountId,
          invitationId: inv.id,
        }),
      );
      expect.unreachable("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(HttpError);
      expect((err as HttpError).statusCode).toBe(404);
    }
  });

  it("returns 404 when Manager of different customer revokes (no tenant leak)", async () => {
    const inv = await seedInvitation("cross-revoke@example.com");

    try {
      await txn((client) =>
        revokeInvitation(client, {
          accountId: otherManagerAccountId,
          invitationId: inv.id,
        }),
      );
      expect.unreachable("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(HttpError);
      expect((err as HttpError).statusCode).toBe(404);
    }
  });
});
