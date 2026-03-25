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
import { changeMemberRole, listMembers, removeMember } from "../members";

const MIGRATIONS_DIR = join(process.cwd(), "migrations", "auth");
const LOCK_ID = 1003;

describe.skipIf(!hasPostgres)("member management (DB integration)", () => {
  let pool: Pool;
  let dbName: string;

  // Test fixtures
  let managerAccountId: string;
  let manager2AccountId: string;
  let userAccountId: string;
  let nonMemberAccountId: string;
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

    // Lookup built-in roles
    const roles = await pool.query<{ id: number; name: string }>(
      `SELECT id, name FROM roles
       WHERE auth_context = 'general' AND name IN ('User', 'Manager')`,
    );
    for (const r of roles.rows) {
      if (r.name === "User") userRoleId = r.id;
      if (r.name === "Manager") managerRoleId = r.id;
    }

    // Create customer
    const cust = await pool.query<{ id: string }>(
      `INSERT INTO customers (external_key, name)
       VALUES ('members-test-cust', 'Members Test Customer')
       RETURNING id`,
    );
    customerId = cust.rows[0].id;

    // Manager account
    const mgr = await pool.query<{ id: string }>(
      `INSERT INTO accounts (oidc_issuer, oidc_subject, username, display_name, email)
       VALUES ('test-issuer', 'mgr-m-001', 'manager1', 'Manager One', 'manager1@example.com')
       RETURNING id`,
    );
    managerAccountId = mgr.rows[0].id;
    await pool.query(
      `INSERT INTO account_customer_memberships (account_id, customer_id, role_id)
       VALUES ($1, $2, $3)`,
      [managerAccountId, customerId, managerRoleId],
    );

    // Second Manager account
    const mgr2 = await pool.query<{ id: string }>(
      `INSERT INTO accounts (oidc_issuer, oidc_subject, username, display_name, email)
       VALUES ('test-issuer', 'mgr-m-002', 'manager2', 'Manager Two', 'manager2@example.com')
       RETURNING id`,
    );
    manager2AccountId = mgr2.rows[0].id;
    await pool.query(
      `INSERT INTO account_customer_memberships (account_id, customer_id, role_id)
       VALUES ($1, $2, $3)`,
      [manager2AccountId, customerId, managerRoleId],
    );

    // Regular User account
    const usr = await pool.query<{ id: string }>(
      `INSERT INTO accounts (oidc_issuer, oidc_subject, username, display_name, email)
       VALUES ('test-issuer', 'usr-m-001', 'user1', 'User One', 'user1@example.com')
       RETURNING id`,
    );
    userAccountId = usr.rows[0].id;
    await pool.query(
      `INSERT INTO account_customer_memberships (account_id, customer_id, role_id)
       VALUES ($1, $2, $3)`,
      [userAccountId, customerId, userRoleId],
    );

    // Non-member account (no membership)
    const nm = await pool.query<{ id: string }>(
      `INSERT INTO accounts (oidc_issuer, oidc_subject, username, display_name, email)
       VALUES ('test-issuer', 'nm-m-001', 'nonmember', 'Non Member', 'nonmember@example.com')
       RETURNING id`,
    );
    nonMemberAccountId = nm.rows[0].id;
  });

  afterAll(async () => {
    await dropTestDatabase(dbName, pool, "auth");
    await closeAdminPool();
  });

  async function withClient<T>(
    fn: (client: PoolClient) => Promise<T>,
  ): Promise<T> {
    const client = await pool.connect();
    try {
      return await fn(client);
    } finally {
      client.release();
    }
  }

  // =========================================================================
  // listMembers
  // =========================================================================

  describe("listMembers", () => {
    it("returns all members of a customer", async () => {
      const members = await withClient((client) =>
        listMembers(client, {
          actorId: managerAccountId,
          customerId,
        }),
      );

      expect(members).toHaveLength(3);

      const usernames = members.map((m) => m.username).sort();
      expect(usernames).toEqual(["manager1", "manager2", "user1"]);

      const manager = members.find((m) => m.username === "manager1");
      expect(manager).toBeDefined();
      expect(manager?.roleName).toBe("Manager");
      expect(manager?.email).toBe("manager1@example.com");
    });

    it("rejects non-Manager actors", async () => {
      await expect(
        withClient((client) =>
          listMembers(client, {
            actorId: userAccountId,
            customerId,
          }),
        ),
      ).rejects.toThrow(HttpError);

      try {
        await withClient((client) =>
          listMembers(client, {
            actorId: userAccountId,
            customerId,
          }),
        );
      } catch (err) {
        expect(err).toBeInstanceOf(HttpError);
        expect((err as HttpError).statusCode).toBe(403);
      }
    });

    it("rejects non-member actors", async () => {
      await expect(
        withClient((client) =>
          listMembers(client, {
            actorId: nonMemberAccountId,
            customerId,
          }),
        ),
      ).rejects.toThrow(HttpError);
    });

    it("returns all expected fields per member", async () => {
      // Set a known last_sign_in_at for verification
      await pool.query(
        `UPDATE accounts SET last_sign_in_at = '2026-01-15T10:00:00Z'
         WHERE id = $1`,
        [userAccountId],
      );

      const members = await withClient((client) =>
        listMembers(client, {
          actorId: managerAccountId,
          customerId,
        }),
      );

      const user = members.find((m) => m.username === "user1");
      expect(user).toBeDefined();
      expect(user?.accountId).toBe(userAccountId);
      expect(user?.displayName).toBe("User One");
      expect(user?.email).toBe("user1@example.com");
      expect(user?.roleName).toBe("User");
      expect(user?.roleId).toBe(userRoleId);
      expect(user?.lastSignInAt).toBe("2026-01-15T10:00:00.000Z");

      // Clean up
      await pool.query(
        `UPDATE accounts SET last_sign_in_at = NULL WHERE id = $1`,
        [userAccountId],
      );
    });
  });

  // =========================================================================
  // removeMember
  // =========================================================================

  describe("removeMember", () => {
    it("allows Manager to remove a User member", async () => {
      // Add a temporary user to remove
      const tmp = await pool.query<{ id: string }>(
        `INSERT INTO accounts (oidc_issuer, oidc_subject, username, display_name, email)
         VALUES ('test-issuer', 'tmp-rm-001', 'tmpremove', 'Tmp Remove', 'tmpremove@example.com')
         RETURNING id`,
      );
      await pool.query(
        `INSERT INTO account_customer_memberships (account_id, customer_id, role_id)
         VALUES ($1, $2, $3)`,
        [tmp.rows[0].id, customerId, userRoleId],
      );

      await removeMember(pool, {
        actorId: managerAccountId,
        targetAccountId: tmp.rows[0].id,
        customerId,
      });

      const check = await pool.query(
        `SELECT 1 FROM account_customer_memberships
         WHERE account_id = $1 AND customer_id = $2`,
        [tmp.rows[0].id, customerId],
      );
      expect(check.rows).toHaveLength(0);
    });

    it("allows Manager to remove themselves if other Managers exist", async () => {
      // Add a third manager to remove self safely
      const tmp = await pool.query<{ id: string }>(
        `INSERT INTO accounts (oidc_issuer, oidc_subject, username, display_name, email)
         VALUES ('test-issuer', 'mgr-self-rm', 'selfremovemgr', 'Self Remove Mgr', 'selfremovemgr@example.com')
         RETURNING id`,
      );
      await pool.query(
        `INSERT INTO account_customer_memberships (account_id, customer_id, role_id)
         VALUES ($1, $2, $3)`,
        [tmp.rows[0].id, customerId, managerRoleId],
      );

      await removeMember(pool, {
        actorId: tmp.rows[0].id,
        targetAccountId: tmp.rows[0].id,
        customerId,
      });

      const check = await pool.query(
        `SELECT 1 FROM account_customer_memberships
         WHERE account_id = $1 AND customer_id = $2`,
        [tmp.rows[0].id, customerId],
      );
      expect(check.rows).toHaveLength(0);
    });

    it("blocks removal of non-existent membership", async () => {
      try {
        await removeMember(pool, {
          actorId: managerAccountId,
          targetAccountId: nonMemberAccountId,
          customerId,
        });
        expect.unreachable("should have thrown");
      } catch (err) {
        expect(err).toBeInstanceOf(HttpError);
        expect((err as HttpError).statusCode).toBe(404);
      }
    });

    it("blocks non-Manager from removing members", async () => {
      try {
        await removeMember(pool, {
          actorId: userAccountId,
          targetAccountId: userAccountId,
          customerId,
        });
        expect.unreachable("should have thrown");
      } catch (err) {
        expect(err).toBeInstanceOf(HttpError);
        expect((err as HttpError).statusCode).toBe(403);
      }
    });
  });

  // =========================================================================
  // Last Manager protection
  // =========================================================================

  describe("last Manager protection", () => {
    let soloCustomerId: string;
    let soloManagerId: string;
    let soloUserId: string;

    beforeAll(async () => {
      // Create a customer with a single Manager
      const cust = await pool.query<{ id: string }>(
        `INSERT INTO customers (external_key, name)
         VALUES ('solo-mgr-cust', 'Solo Manager Customer')
         RETURNING id`,
      );
      soloCustomerId = cust.rows[0].id;

      const mgr = await pool.query<{ id: string }>(
        `INSERT INTO accounts (oidc_issuer, oidc_subject, username, display_name, email)
         VALUES ('test-issuer', 'solo-mgr-001', 'solomgr', 'Solo Manager', 'solomgr@example.com')
         RETURNING id`,
      );
      soloManagerId = mgr.rows[0].id;
      await pool.query(
        `INSERT INTO account_customer_memberships (account_id, customer_id, role_id)
         VALUES ($1, $2, $3)`,
        [soloManagerId, soloCustomerId, managerRoleId],
      );

      const usr = await pool.query<{ id: string }>(
        `INSERT INTO accounts (oidc_issuer, oidc_subject, username, display_name, email)
         VALUES ('test-issuer', 'solo-usr-001', 'solousr', 'Solo User', 'solousr@example.com')
         RETURNING id`,
      );
      soloUserId = usr.rows[0].id;
      await pool.query(
        `INSERT INTO account_customer_memberships (account_id, customer_id, role_id)
         VALUES ($1, $2, $3)`,
        [soloUserId, soloCustomerId, userRoleId],
      );
    });

    it("blocks removal of the last Manager", async () => {
      try {
        await removeMember(pool, {
          actorId: soloManagerId,
          targetAccountId: soloManagerId,
          customerId: soloCustomerId,
        });
        expect.unreachable("should have thrown");
      } catch (err) {
        expect(err).toBeInstanceOf(HttpError);
        expect((err as HttpError).statusCode).toBe(409);
        expect((err as HttpError).message).toBe(
          "last_manager_cannot_be_removed",
        );
      }
    });

    it("blocks demotion of the last Manager to User", async () => {
      try {
        await changeMemberRole(pool, {
          actorId: soloManagerId,
          targetAccountId: soloManagerId,
          customerId: soloCustomerId,
          roleId: userRoleId,
        });
        expect.unreachable("should have thrown");
      } catch (err) {
        expect(err).toBeInstanceOf(HttpError);
        expect((err as HttpError).statusCode).toBe(409);
        expect((err as HttpError).message).toBe(
          "last_manager_cannot_be_removed",
        );
      }
    });

    it("allows promoting User to Manager (no last-Manager concern)", async () => {
      await changeMemberRole(pool, {
        actorId: soloManagerId,
        targetAccountId: soloUserId,
        customerId: soloCustomerId,
        roleId: managerRoleId,
      });

      const check = await pool.query<{ role_id: number }>(
        `SELECT role_id FROM account_customer_memberships
         WHERE account_id = $1 AND customer_id = $2`,
        [soloUserId, soloCustomerId],
      );
      expect(check.rows[0].role_id).toBe(managerRoleId);

      // Restore to User for subsequent tests
      await changeMemberRole(pool, {
        actorId: soloManagerId,
        targetAccountId: soloUserId,
        customerId: soloCustomerId,
        roleId: userRoleId,
      });
    });
  });

  // =========================================================================
  // changeMemberRole
  // =========================================================================

  describe("changeMemberRole", () => {
    it("changes a User to Manager", async () => {
      // Add a temp user
      const tmp = await pool.query<{ id: string }>(
        `INSERT INTO accounts (oidc_issuer, oidc_subject, username, display_name, email)
         VALUES ('test-issuer', 'role-chg-001', 'rolechg', 'Role Change', 'rolechg@example.com')
         RETURNING id`,
      );
      await pool.query(
        `INSERT INTO account_customer_memberships (account_id, customer_id, role_id)
         VALUES ($1, $2, $3)`,
        [tmp.rows[0].id, customerId, userRoleId],
      );

      await changeMemberRole(pool, {
        actorId: managerAccountId,
        targetAccountId: tmp.rows[0].id,
        customerId,
        roleId: managerRoleId,
      });

      const check = await pool.query<{ role_id: number }>(
        `SELECT role_id FROM account_customer_memberships
         WHERE account_id = $1 AND customer_id = $2`,
        [tmp.rows[0].id, customerId],
      );
      expect(check.rows[0].role_id).toBe(managerRoleId);

      // Clean up
      await pool.query(
        `DELETE FROM account_customer_memberships
         WHERE account_id = $1 AND customer_id = $2`,
        [tmp.rows[0].id, customerId],
      );
    });

    it("no-ops when setting the same role", async () => {
      await changeMemberRole(pool, {
        actorId: managerAccountId,
        targetAccountId: userAccountId,
        customerId,
        roleId: userRoleId,
      });

      const check = await pool.query<{ role_id: number }>(
        `SELECT role_id FROM account_customer_memberships
         WHERE account_id = $1 AND customer_id = $2`,
        [userAccountId, customerId],
      );
      expect(check.rows[0].role_id).toBe(userRoleId);
    });

    it("rejects invalid role ID", async () => {
      try {
        await changeMemberRole(pool, {
          actorId: managerAccountId,
          targetAccountId: userAccountId,
          customerId,
          roleId: 99999,
        });
        expect.unreachable("should have thrown");
      } catch (err) {
        expect(err).toBeInstanceOf(HttpError);
        expect((err as HttpError).statusCode).toBe(400);
      }
    });

    it("rejects non-Manager actors", async () => {
      try {
        await changeMemberRole(pool, {
          actorId: userAccountId,
          targetAccountId: userAccountId,
          customerId,
          roleId: managerRoleId,
        });
        expect.unreachable("should have thrown");
      } catch (err) {
        expect(err).toBeInstanceOf(HttpError);
        expect((err as HttpError).statusCode).toBe(403);
      }
    });

    it("allows Manager to demote themselves when other Managers exist", async () => {
      // manager2 demotes themselves to User (manager1 still exists)
      await changeMemberRole(pool, {
        actorId: manager2AccountId,
        targetAccountId: manager2AccountId,
        customerId,
        roleId: userRoleId,
      });

      const check = await pool.query<{ role_id: number }>(
        `SELECT role_id FROM account_customer_memberships
         WHERE account_id = $1 AND customer_id = $2`,
        [manager2AccountId, customerId],
      );
      expect(check.rows[0].role_id).toBe(userRoleId);

      // Restore to Manager for subsequent tests
      await pool.query(
        `UPDATE account_customer_memberships
         SET role_id = $1 WHERE account_id = $2 AND customer_id = $3`,
        [managerRoleId, manager2AccountId, customerId],
      );
    });

    it("rejects admin-context role (DB trigger)", async () => {
      // Look up System Administrator role (admin context)
      const adminRole = await pool.query<{ id: number }>(
        `SELECT id FROM roles WHERE name = 'System Administrator'`,
      );
      const adminRoleId = adminRole.rows[0].id;

      // The assertValidGeneralRole check should reject before the
      // DB trigger fires, since it only accepts general-context roles.
      try {
        await changeMemberRole(pool, {
          actorId: managerAccountId,
          targetAccountId: userAccountId,
          customerId,
          roleId: adminRoleId,
        });
        expect.unreachable("should have thrown");
      } catch (err) {
        expect(err).toBeInstanceOf(HttpError);
        expect((err as HttpError).statusCode).toBe(400);
        expect((err as HttpError).message).toBe("Invalid role");
      }
    });

    it("rejects changing role of non-member", async () => {
      try {
        await changeMemberRole(pool, {
          actorId: managerAccountId,
          targetAccountId: nonMemberAccountId,
          customerId,
          roleId: userRoleId,
        });
        expect.unreachable("should have thrown");
      } catch (err) {
        expect(err).toBeInstanceOf(HttpError);
        expect((err as HttpError).statusCode).toBe(404);
      }
    });
  });

  // =========================================================================
  // Concurrency: FOR UPDATE prevents double removal of last Manager
  // =========================================================================

  describe("concurrent last Manager removal", () => {
    it("only one concurrent removal succeeds when two Managers exist", async () => {
      // Create customer with exactly 2 managers
      const cust = await pool.query<{ id: string }>(
        `INSERT INTO customers (external_key, name)
         VALUES ('conc-mgr-cust', 'Concurrent Manager Customer')
         RETURNING id`,
      );
      const concCustomerId = cust.rows[0].id;

      const m1 = await pool.query<{ id: string }>(
        `INSERT INTO accounts (oidc_issuer, oidc_subject, username, display_name, email)
         VALUES ('test-issuer', 'conc-mgr-001', 'concmgr1', 'Conc Mgr 1', 'concmgr1@example.com')
         RETURNING id`,
      );
      const m2 = await pool.query<{ id: string }>(
        `INSERT INTO accounts (oidc_issuer, oidc_subject, username, display_name, email)
         VALUES ('test-issuer', 'conc-mgr-002', 'concmgr2', 'Conc Mgr 2', 'concmgr2@example.com')
         RETURNING id`,
      );

      await pool.query(
        `INSERT INTO account_customer_memberships (account_id, customer_id, role_id)
         VALUES ($1, $3, $5), ($2, $4, $6)`,
        [
          m1.rows[0].id,
          m2.rows[0].id,
          concCustomerId,
          concCustomerId,
          managerRoleId,
          managerRoleId,
        ],
      );

      // Both try to remove the other concurrently
      const results = await Promise.allSettled([
        removeMember(pool, {
          actorId: m1.rows[0].id,
          targetAccountId: m2.rows[0].id,
          customerId: concCustomerId,
        }),
        removeMember(pool, {
          actorId: m2.rows[0].id,
          targetAccountId: m1.rows[0].id,
          customerId: concCustomerId,
        }),
      ]);

      const successes = results.filter((r) => r.status === "fulfilled");
      const failures = results.filter((r) => r.status === "rejected");

      // Exactly one must succeed, one must fail (403 or 409 depending
      // on serialization order — the loser may fail at permission check
      // because their membership was deleted by the winner).
      expect(successes).toHaveLength(1);
      expect(failures).toHaveLength(1);
      const err = (failures[0] as PromiseRejectedResult).reason;
      expect(err).toBeInstanceOf(HttpError);
      expect([403, 409]).toContain((err as HttpError).statusCode);

      // Invariant: exactly one Manager remains
      const remaining = await pool.query(
        `SELECT account_id FROM account_customer_memberships
         WHERE customer_id = $1`,
        [concCustomerId],
      );
      expect(remaining.rows).toHaveLength(1);
    });
  });
});
