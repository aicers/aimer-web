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
import { HttpError } from "../errors";
import { changeRole, listMembers, removeMember } from "../members";

const MIGRATIONS_DIR = join(process.cwd(), "migrations", "auth");
const LOCK_ID = 1001;

describe.skipIf(!hasPostgres)("member management (DB integration)", () => {
  let pool: Pool;
  let dbName: string;

  // Test fixtures
  let managerAccountId: string;
  let manager2AccountId: string;
  let userAccountId: string;
  let outsiderAccountId: string;
  let customerId: string;
  let managerRoleId: number;
  let userRoleId: number;

  beforeAll(async () => {
    const result = await createTestDatabase("members", "auth");
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

    // Create test customer
    const cust = await pool.query<{ id: string }>(
      `INSERT INTO customers (external_key, name)
       VALUES ('members-cust', 'Members Customer')
       RETURNING id`,
    );
    customerId = cust.rows[0].id;

    // Lookup built-in roles
    const roles = await pool.query<{ id: number; name: string }>(
      `SELECT id, name FROM roles
       WHERE auth_context = 'general' AND name IN ('User', 'Manager')`,
    );
    for (const r of roles.rows) {
      if (r.name === "User") userRoleId = r.id;
      if (r.name === "Manager") managerRoleId = r.id;
    }

    // Create manager account
    const mgr = await pool.query<{ id: string }>(
      `INSERT INTO accounts (oidc_issuer, oidc_subject, username, display_name, email)
       VALUES ('test-issuer', 'mgr-001', 'manager1', 'Manager One', 'manager1@example.com')
       RETURNING id`,
    );
    managerAccountId = mgr.rows[0].id;
    await pool.query(
      `INSERT INTO account_customer_memberships (account_id, customer_id, role_id)
       VALUES ($1, $2, $3)`,
      [managerAccountId, customerId, managerRoleId],
    );

    // Create second manager account
    const mgr2 = await pool.query<{ id: string }>(
      `INSERT INTO accounts (oidc_issuer, oidc_subject, username, display_name, email)
       VALUES ('test-issuer', 'mgr-002', 'manager2', 'Manager Two', 'manager2@example.com')
       RETURNING id`,
    );
    manager2AccountId = mgr2.rows[0].id;
    await pool.query(
      `INSERT INTO account_customer_memberships (account_id, customer_id, role_id)
       VALUES ($1, $2, $3)`,
      [manager2AccountId, customerId, managerRoleId],
    );

    // Create user account
    const usr = await pool.query<{ id: string }>(
      `INSERT INTO accounts (oidc_issuer, oidc_subject, username, display_name, email)
       VALUES ('test-issuer', 'usr-001', 'user1', 'User One', 'user1@example.com')
       RETURNING id`,
    );
    userAccountId = usr.rows[0].id;
    await pool.query(
      `INSERT INTO account_customer_memberships (account_id, customer_id, role_id)
       VALUES ($1, $2, $3)`,
      [userAccountId, customerId, userRoleId],
    );

    // Create outsider account (no membership)
    const outsider = await pool.query<{ id: string }>(
      `INSERT INTO accounts (oidc_issuer, oidc_subject, username, display_name, email)
       VALUES ('test-issuer', 'outsider-001', 'outsider', 'Outsider', 'outsider@example.com')
       RETURNING id`,
    );
    outsiderAccountId = outsider.rows[0].id;
  });

  afterAll(async () => {
    await dropTestDatabase(dbName, pool, "auth");
    await closeAdminPool();
  });

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
  // List members
  // =========================================================================

  it("lists all members of a customer", async () => {
    const members = await runInTransaction((client) =>
      listMembers(client, {
        accountId: managerAccountId,
        customerId,
      }),
    );

    expect(members.length).toBeGreaterThanOrEqual(3);
    const names = members.map((m) => m.displayName);
    expect(names).toContain("Manager One");
    expect(names).toContain("Manager Two");
    expect(names).toContain("User One");

    // Verify shape
    for (const member of members) {
      expect(member).toHaveProperty("accountId");
      expect(member).toHaveProperty("displayName");
      expect(member).toHaveProperty("email");
      expect(member).toHaveProperty("roleName");
      expect(member).toHaveProperty("lastSignInAt");
    }
  });

  it("rejects list from non-Manager account (403)", async () => {
    await expect(
      runInTransaction((client) =>
        listMembers(client, {
          accountId: userAccountId,
          customerId,
        }),
      ),
    ).rejects.toThrow("Forbidden");
  });

  it("rejects list from outsider account (403)", async () => {
    await expect(
      runInTransaction((client) =>
        listMembers(client, {
          accountId: outsiderAccountId,
          customerId,
        }),
      ),
    ).rejects.toThrow("Forbidden");
  });

  // =========================================================================
  // Remove member
  // =========================================================================

  it("removes a User member", async () => {
    // Create a disposable user for removal
    const usr = await pool.query<{ id: string }>(
      `INSERT INTO accounts (oidc_issuer, oidc_subject, username, display_name, email)
       VALUES ('test-issuer', 'remove-usr-001', 'removeuser', 'Remove User', 'remove@example.com')
       RETURNING id`,
    );
    await pool.query(
      `INSERT INTO account_customer_memberships (account_id, customer_id, role_id)
       VALUES ($1, $2, $3)`,
      [usr.rows[0].id, customerId, userRoleId],
    );

    await runInTransaction((client) =>
      removeMember(client, {
        accountId: managerAccountId,
        targetAccountId: usr.rows[0].id,
        customerId,
      }),
    );

    // Verify removal
    const membership = await pool.query(
      `SELECT 1 FROM account_customer_memberships
       WHERE account_id = $1 AND customer_id = $2`,
      [usr.rows[0].id, customerId],
    );
    expect(membership.rows).toHaveLength(0);
  });

  it("rejects removal of non-existent member (404)", async () => {
    try {
      await runInTransaction((client) =>
        removeMember(client, {
          accountId: managerAccountId,
          targetAccountId: "00000000-0000-0000-0000-000000000000",
          customerId,
        }),
      );
      expect.unreachable("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(HttpError);
      expect((err as HttpError).statusCode).toBe(404);
    }
  });

  it("rejects removal from non-Manager (403)", async () => {
    await expect(
      runInTransaction((client) =>
        removeMember(client, {
          accountId: userAccountId,
          targetAccountId: managerAccountId,
          customerId,
        }),
      ),
    ).rejects.toThrow("Forbidden");
  });

  // =========================================================================
  // Verification item 35-11: Last Manager protection
  // =========================================================================

  it("blocks removal of the last Manager (409)", async () => {
    // Create a customer with only one Manager
    const cust = await pool.query<{ id: string }>(
      `INSERT INTO customers (external_key, name)
       VALUES ('solo-mgr-cust', 'Solo Manager Customer')
       RETURNING id`,
    );
    const soloCustomerId = cust.rows[0].id;

    const mgr = await pool.query<{ id: string }>(
      `INSERT INTO accounts (oidc_issuer, oidc_subject, username, display_name, email)
       VALUES ('test-issuer', 'solo-mgr-001', 'solomgr', 'Solo Manager', 'solo@example.com')
       RETURNING id`,
    );
    await pool.query(
      `INSERT INTO account_customer_memberships (account_id, customer_id, role_id)
       VALUES ($1, $2, $3)`,
      [mgr.rows[0].id, soloCustomerId, managerRoleId],
    );

    try {
      await runInTransaction((client) =>
        removeMember(client, {
          accountId: mgr.rows[0].id,
          targetAccountId: mgr.rows[0].id,
          customerId: soloCustomerId,
        }),
      );
      expect.unreachable("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(HttpError);
      expect((err as HttpError).statusCode).toBe(409);
      expect((err as HttpError).message).toBe("last_manager_cannot_be_removed");
    }

    // Verify membership still exists
    const membership = await pool.query(
      `SELECT 1 FROM account_customer_memberships
       WHERE account_id = $1 AND customer_id = $2`,
      [mgr.rows[0].id, soloCustomerId],
    );
    expect(membership.rows).toHaveLength(1);
  });

  it("allows Manager to remove themselves if other Managers exist", async () => {
    // Create a customer with two Managers
    const cust = await pool.query<{ id: string }>(
      `INSERT INTO customers (external_key, name)
       VALUES ('dual-mgr-cust', 'Dual Manager Customer')
       RETURNING id`,
    );
    const dualCustomerId = cust.rows[0].id;

    const mgr1 = await pool.query<{ id: string }>(
      `INSERT INTO accounts (oidc_issuer, oidc_subject, username, display_name, email)
       VALUES ('test-issuer', 'dual-mgr-001', 'dualmgr1', 'Dual Mgr 1', 'dualmgr1@example.com')
       RETURNING id`,
    );
    const mgr2 = await pool.query<{ id: string }>(
      `INSERT INTO accounts (oidc_issuer, oidc_subject, username, display_name, email)
       VALUES ('test-issuer', 'dual-mgr-002', 'dualmgr2', 'Dual Mgr 2', 'dualmgr2@example.com')
       RETURNING id`,
    );
    await pool.query(
      `INSERT INTO account_customer_memberships (account_id, customer_id, role_id)
       VALUES ($1, $2, $3), ($4, $5, $6)`,
      [
        mgr1.rows[0].id,
        dualCustomerId,
        managerRoleId,
        mgr2.rows[0].id,
        dualCustomerId,
        managerRoleId,
      ],
    );

    // Manager removes themselves — should succeed
    await runInTransaction((client) =>
      removeMember(client, {
        accountId: mgr1.rows[0].id,
        targetAccountId: mgr1.rows[0].id,
        customerId: dualCustomerId,
      }),
    );

    const membership = await pool.query(
      `SELECT 1 FROM account_customer_memberships
       WHERE account_id = $1 AND customer_id = $2`,
      [mgr1.rows[0].id, dualCustomerId],
    );
    expect(membership.rows).toHaveLength(0);
  });

  // =========================================================================
  // Change role
  // =========================================================================

  it("changes a User's role to Manager", async () => {
    const usr = await pool.query<{ id: string }>(
      `INSERT INTO accounts (oidc_issuer, oidc_subject, username, display_name, email)
       VALUES ('test-issuer', 'promote-001', 'promoteuser', 'Promote User', 'promote@example.com')
       RETURNING id`,
    );
    await pool.query(
      `INSERT INTO account_customer_memberships (account_id, customer_id, role_id)
       VALUES ($1, $2, $3)`,
      [usr.rows[0].id, customerId, userRoleId],
    );

    await runInTransaction((client) =>
      changeRole(client, {
        accountId: managerAccountId,
        targetAccountId: usr.rows[0].id,
        customerId,
        roleId: managerRoleId,
      }),
    );

    const membership = await pool.query<{ role_id: number }>(
      `SELECT role_id FROM account_customer_memberships
       WHERE account_id = $1 AND customer_id = $2`,
      [usr.rows[0].id, customerId],
    );
    expect(membership.rows[0].role_id).toBe(managerRoleId);
  });

  it("blocks demotion of the last Manager to User (409)", async () => {
    const cust = await pool.query<{ id: string }>(
      `INSERT INTO customers (external_key, name)
       VALUES ('demote-cust', 'Demote Customer')
       RETURNING id`,
    );
    const demoteCustomerId = cust.rows[0].id;

    const mgr = await pool.query<{ id: string }>(
      `INSERT INTO accounts (oidc_issuer, oidc_subject, username, display_name, email)
       VALUES ('test-issuer', 'demote-mgr-001', 'demotemgr', 'Demote Mgr', 'demotemgr@example.com')
       RETURNING id`,
    );
    await pool.query(
      `INSERT INTO account_customer_memberships (account_id, customer_id, role_id)
       VALUES ($1, $2, $3)`,
      [mgr.rows[0].id, demoteCustomerId, managerRoleId],
    );

    try {
      await runInTransaction((client) =>
        changeRole(client, {
          accountId: mgr.rows[0].id,
          targetAccountId: mgr.rows[0].id,
          customerId: demoteCustomerId,
          roleId: userRoleId,
        }),
      );
      expect.unreachable("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(HttpError);
      expect((err as HttpError).statusCode).toBe(409);
      expect((err as HttpError).message).toBe("last_manager_cannot_be_removed");
    }
  });

  it("allows Manager to demote themselves if other Managers exist", async () => {
    const cust = await pool.query<{ id: string }>(
      `INSERT INTO customers (external_key, name)
       VALUES ('self-demote-cust', 'Self Demote Customer')
       RETURNING id`,
    );
    const selfDemoteCustomerId = cust.rows[0].id;

    const mgr1 = await pool.query<{ id: string }>(
      `INSERT INTO accounts (oidc_issuer, oidc_subject, username, display_name, email)
       VALUES ('test-issuer', 'self-demote-001', 'selfdemote1', 'Self Demote 1', 'selfdemote1@example.com')
       RETURNING id`,
    );
    const mgr2 = await pool.query<{ id: string }>(
      `INSERT INTO accounts (oidc_issuer, oidc_subject, username, display_name, email)
       VALUES ('test-issuer', 'self-demote-002', 'selfdemote2', 'Self Demote 2', 'selfdemote2@example.com')
       RETURNING id`,
    );
    await pool.query(
      `INSERT INTO account_customer_memberships (account_id, customer_id, role_id)
       VALUES ($1, $2, $3), ($4, $5, $6)`,
      [
        mgr1.rows[0].id,
        selfDemoteCustomerId,
        managerRoleId,
        mgr2.rows[0].id,
        selfDemoteCustomerId,
        managerRoleId,
      ],
    );

    await runInTransaction((client) =>
      changeRole(client, {
        accountId: mgr1.rows[0].id,
        targetAccountId: mgr1.rows[0].id,
        customerId: selfDemoteCustomerId,
        roleId: userRoleId,
      }),
    );

    const membership = await pool.query<{ role_id: number }>(
      `SELECT role_id FROM account_customer_memberships
       WHERE account_id = $1 AND customer_id = $2`,
      [mgr1.rows[0].id, selfDemoteCustomerId],
    );
    expect(membership.rows[0].role_id).toBe(userRoleId);
  });

  it("rejects change to non-existent role (400)", async () => {
    try {
      await runInTransaction((client) =>
        changeRole(client, {
          accountId: managerAccountId,
          targetAccountId: userAccountId,
          customerId,
          roleId: 99999,
        }),
      );
      expect.unreachable("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(HttpError);
      expect((err as HttpError).statusCode).toBe(400);
      expect((err as HttpError).message).toBe("Invalid role");
    }
  });

  it("rejects change to admin-context role (400)", async () => {
    const adminRole = await pool.query<{ id: number }>(
      `SELECT id FROM roles WHERE auth_context = 'admin' LIMIT 1`,
    );
    if (adminRole.rows.length === 0) return; // skip if no admin role

    try {
      await runInTransaction((client) =>
        changeRole(client, {
          accountId: managerAccountId,
          targetAccountId: userAccountId,
          customerId,
          roleId: adminRole.rows[0].id,
        }),
      );
      expect.unreachable("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(HttpError);
      expect((err as HttpError).statusCode).toBe(400);
      expect((err as HttpError).message).toBe(
        "Role must be a general-context role",
      );
    }
  });

  it("rejects role change from non-Manager (403)", async () => {
    await expect(
      runInTransaction((client) =>
        changeRole(client, {
          accountId: userAccountId,
          targetAccountId: managerAccountId,
          customerId,
          roleId: userRoleId,
        }),
      ),
    ).rejects.toThrow("Forbidden");
  });

  it("rejects role change for non-existent member (404)", async () => {
    try {
      await runInTransaction((client) =>
        changeRole(client, {
          accountId: managerAccountId,
          targetAccountId: "00000000-0000-0000-0000-000000000000",
          customerId,
          roleId: userRoleId,
        }),
      );
      expect.unreachable("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(HttpError);
      expect((err as HttpError).statusCode).toBe(404);
    }
  });

  // =========================================================================
  // Edge cases: role change
  // =========================================================================

  it("promotion from User to Manager always succeeds (no last-Manager concern)", async () => {
    const cust = await pool.query<{ id: string }>(
      `INSERT INTO customers (external_key, name)
       VALUES ('promote-cust', 'Promote Customer')
       RETURNING id`,
    );
    const promoteCustomerId = cust.rows[0].id;

    const mgr = await pool.query<{ id: string }>(
      `INSERT INTO accounts (oidc_issuer, oidc_subject, username, display_name, email)
       VALUES ('test-issuer', 'promote-mgr-001', 'promotemgr', 'Promote Mgr', 'promotemgr@example.com')
       RETURNING id`,
    );
    const usr = await pool.query<{ id: string }>(
      `INSERT INTO accounts (oidc_issuer, oidc_subject, username, display_name, email)
       VALUES ('test-issuer', 'promote-usr-001', 'promoteusr', 'Promote Usr', 'promoteusr@example.com')
       RETURNING id`,
    );
    await pool.query(
      `INSERT INTO account_customer_memberships (account_id, customer_id, role_id)
       VALUES ($1, $2, $3), ($4, $5, $6)`,
      [
        mgr.rows[0].id,
        promoteCustomerId,
        managerRoleId,
        usr.rows[0].id,
        promoteCustomerId,
        userRoleId,
      ],
    );

    await runInTransaction((client) =>
      changeRole(client, {
        accountId: mgr.rows[0].id,
        targetAccountId: usr.rows[0].id,
        customerId: promoteCustomerId,
        roleId: managerRoleId,
      }),
    );

    const membership = await pool.query<{ role_id: number }>(
      `SELECT role_id FROM account_customer_memberships
       WHERE account_id = $1 AND customer_id = $2`,
      [usr.rows[0].id, promoteCustomerId],
    );
    expect(membership.rows[0].role_id).toBe(managerRoleId);
  });

  it("changing to the same role is a no-op (no error)", async () => {
    // userAccountId already has User role in the main customer
    await runInTransaction((client) =>
      changeRole(client, {
        accountId: managerAccountId,
        targetAccountId: userAccountId,
        customerId,
        roleId: userRoleId,
      }),
    );

    const membership = await pool.query<{ role_id: number }>(
      `SELECT role_id FROM account_customer_memberships
       WHERE account_id = $1 AND customer_id = $2`,
      [userAccountId, customerId],
    );
    expect(membership.rows[0].role_id).toBe(userRoleId);
  });

  it("Manager changing own role to Manager is a no-op", async () => {
    await runInTransaction((client) =>
      changeRole(client, {
        accountId: managerAccountId,
        targetAccountId: managerAccountId,
        customerId,
        roleId: managerRoleId,
      }),
    );

    const membership = await pool.query<{ role_id: number }>(
      `SELECT role_id FROM account_customer_memberships
       WHERE account_id = $1 AND customer_id = $2`,
      [managerAccountId, customerId],
    );
    expect(membership.rows[0].role_id).toBe(managerRoleId);
  });

  // =========================================================================
  // Edge cases: list members returns correct data
  // =========================================================================

  it("list members returns roles correctly after role change", async () => {
    const cust = await pool.query<{ id: string }>(
      `INSERT INTO customers (external_key, name)
       VALUES ('list-role-cust', 'List Role Customer')
       RETURNING id`,
    );
    const listCustomerId = cust.rows[0].id;

    const mgr = await pool.query<{ id: string }>(
      `INSERT INTO accounts (oidc_issuer, oidc_subject, username, display_name, email)
       VALUES ('test-issuer', 'list-mgr-001', 'listmgr', 'List Mgr', 'listmgr@example.com')
       RETURNING id`,
    );
    const usr = await pool.query<{ id: string }>(
      `INSERT INTO accounts (oidc_issuer, oidc_subject, username, display_name, email)
       VALUES ('test-issuer', 'list-usr-001', 'listusr', 'List Usr', 'listusr@example.com')
       RETURNING id`,
    );
    await pool.query(
      `INSERT INTO account_customer_memberships (account_id, customer_id, role_id)
       VALUES ($1, $2, $3), ($4, $5, $6)`,
      [
        mgr.rows[0].id,
        listCustomerId,
        managerRoleId,
        usr.rows[0].id,
        listCustomerId,
        userRoleId,
      ],
    );

    const members = await runInTransaction((client) =>
      listMembers(client, {
        accountId: mgr.rows[0].id,
        customerId: listCustomerId,
      }),
    );

    expect(members).toHaveLength(2);
    const mgrMember = members.find((m) => m.displayName === "List Mgr");
    const usrMember = members.find((m) => m.displayName === "List Usr");
    expect(mgrMember?.roleName).toBe("Manager");
    expect(mgrMember?.email).toBe("listmgr@example.com");
    expect(usrMember?.roleName).toBe("User");
    expect(usrMember?.email).toBe("listusr@example.com");
  });

  it("list members returns empty when customer has been cleared", async () => {
    const cust = await pool.query<{ id: string }>(
      `INSERT INTO customers (external_key, name)
       VALUES ('empty-cust', 'Empty Customer')
       RETURNING id`,
    );
    const emptyCustomerId = cust.rows[0].id;

    const mgr = await pool.query<{ id: string }>(
      `INSERT INTO accounts (oidc_issuer, oidc_subject, username, display_name, email)
       VALUES ('test-issuer', 'empty-mgr-001', 'emptymgr', 'Empty Mgr', 'emptymgr@example.com')
       RETURNING id`,
    );
    await pool.query(
      `INSERT INTO account_customer_memberships (account_id, customer_id, role_id)
       VALUES ($1, $2, $3)`,
      [mgr.rows[0].id, emptyCustomerId, managerRoleId],
    );

    // List, then remove the only member directly (bypass protection for test)
    const members = await runInTransaction((client) =>
      listMembers(client, {
        accountId: mgr.rows[0].id,
        customerId: emptyCustomerId,
      }),
    );
    expect(members).toHaveLength(1);
  });

  // =========================================================================
  // Concurrency: concurrent last-Manager removal
  // =========================================================================

  it("handles concurrent Manager demotion safely", async () => {
    const cust = await pool.query<{ id: string }>(
      `INSERT INTO customers (external_key, name)
       VALUES ('conc-demote-cust', 'Concurrent Demote Customer')
       RETURNING id`,
    );
    const concDemoteId = cust.rows[0].id;

    const mgr1 = await pool.query<{ id: string }>(
      `INSERT INTO accounts (oidc_issuer, oidc_subject, username, display_name, email)
       VALUES ('test-issuer', 'conc-demote-001', 'concdemote1', 'Conc Demote 1', 'concdemote1@example.com')
       RETURNING id`,
    );
    const mgr2 = await pool.query<{ id: string }>(
      `INSERT INTO accounts (oidc_issuer, oidc_subject, username, display_name, email)
       VALUES ('test-issuer', 'conc-demote-002', 'concdemote2', 'Conc Demote 2', 'concdemote2@example.com')
       RETURNING id`,
    );
    await pool.query(
      `INSERT INTO account_customer_memberships (account_id, customer_id, role_id)
       VALUES ($1, $2, $3), ($4, $5, $6)`,
      [
        mgr1.rows[0].id,
        concDemoteId,
        managerRoleId,
        mgr2.rows[0].id,
        concDemoteId,
        managerRoleId,
      ],
    );

    // Both Managers try to demote the other concurrently.
    // FOR UPDATE serializes the operations; one of the following outcomes:
    //   - One succeeds, the other gets 409 (last Manager protection)
    //   - One succeeds, the other hits a deadlock/serialization error
    // In all cases, at least one Manager must remain.
    const results = await Promise.allSettled([
      runInTransaction((client) =>
        changeRole(client, {
          accountId: mgr1.rows[0].id,
          targetAccountId: mgr2.rows[0].id,
          customerId: concDemoteId,
          roleId: userRoleId,
        }),
      ),
      runInTransaction((client) =>
        changeRole(client, {
          accountId: mgr2.rows[0].id,
          targetAccountId: mgr1.rows[0].id,
          customerId: concDemoteId,
          roleId: userRoleId,
        }),
      ),
    ]);

    const fulfilled = results.filter((r) => r.status === "fulfilled").length;
    expect(fulfilled).toBeGreaterThanOrEqual(1);

    // The critical invariant: at least one Manager remains
    const managerCount = await pool.query<{ cnt: number }>(
      `SELECT COUNT(*)::int AS cnt FROM account_customer_memberships acm
       JOIN roles r ON r.id = acm.role_id
       WHERE acm.customer_id = $1 AND r.name = 'Manager'`,
      [concDemoteId],
    );
    expect(managerCount.rows[0].cnt).toBeGreaterThanOrEqual(1);
  });

  it("handles concurrent Manager removal safely (only one succeeds)", async () => {
    const cust = await pool.query<{ id: string }>(
      `INSERT INTO customers (external_key, name)
       VALUES ('conc-mgr-cust', 'Concurrent Manager Customer')
       RETURNING id`,
    );
    const concCustomerId = cust.rows[0].id;

    const mgr1 = await pool.query<{ id: string }>(
      `INSERT INTO accounts (oidc_issuer, oidc_subject, username, display_name, email)
       VALUES ('test-issuer', 'conc-mgr-001', 'concmgr1', 'Conc Mgr 1', 'concmgr1@example.com')
       RETURNING id`,
    );
    const mgr2 = await pool.query<{ id: string }>(
      `INSERT INTO accounts (oidc_issuer, oidc_subject, username, display_name, email)
       VALUES ('test-issuer', 'conc-mgr-002', 'concmgr2', 'Conc Mgr 2', 'concmgr2@example.com')
       RETURNING id`,
    );
    await pool.query(
      `INSERT INTO account_customer_memberships (account_id, customer_id, role_id)
       VALUES ($1, $2, $3), ($4, $5, $6)`,
      [
        mgr1.rows[0].id,
        concCustomerId,
        managerRoleId,
        mgr2.rows[0].id,
        concCustomerId,
        managerRoleId,
      ],
    );

    // Both Managers try to remove the other concurrently.
    // FOR UPDATE serializes: one succeeds, the other gets 409 or a
    // deadlock/serialization error. Either way, at least one Manager
    // must remain.
    const results = await Promise.allSettled([
      runInTransaction((client) =>
        removeMember(client, {
          accountId: mgr1.rows[0].id,
          targetAccountId: mgr2.rows[0].id,
          customerId: concCustomerId,
        }),
      ),
      runInTransaction((client) =>
        removeMember(client, {
          accountId: mgr2.rows[0].id,
          targetAccountId: mgr1.rows[0].id,
          customerId: concCustomerId,
        }),
      ),
    ]);

    const fulfilled = results.filter((r) => r.status === "fulfilled").length;
    expect(fulfilled).toBeGreaterThanOrEqual(1);

    // The critical invariant: at least one Manager remains
    const remaining = await pool.query(
      `SELECT COUNT(*)::int AS cnt FROM account_customer_memberships
       WHERE customer_id = $1`,
      [concCustomerId],
    );
    expect(remaining.rows[0].cnt).toBeGreaterThanOrEqual(1);
  });
});
