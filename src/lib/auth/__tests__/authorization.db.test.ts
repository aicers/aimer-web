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
  assertAuthorized,
  authorize,
  listAccessibleCustomers,
  listAccessibleCustomersDetailed,
  listAccessibleEnvironments,
} from "../authorization";
import { HttpError } from "../errors";

const MIGRATIONS_DIR = join(process.cwd(), "migrations", "auth");
const LOCK_ID = 1029;

describe.skipIf(!hasPostgres)("authorize() (DB integration)", () => {
  let pool: Pool;
  let dbName: string;

  // Role IDs
  let userRoleId: number;
  let managerRoleId: number;
  let sysAdminRoleId: number;

  // Accounts
  let userAccountId: string;
  let managerAccountId: string;
  let analystAccountId: string;
  let adminAccountId: string;
  let multiRoleAccountId: string;
  let noAccessAccountId: string;

  // Customers
  let activeCustomerId: string;
  let suspendedCustomerId: string;
  let customerBId: string;
  let customerCId: string;

  // AICE environments
  const activeAiceId = "aice-active.example.com";
  const suspendedAiceId = "aice-suspended.example.com";

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

  beforeAll(async () => {
    const result = await createTestDatabase("authz", "auth");
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
      `SELECT id, name FROM roles WHERE name IN ('User', 'Manager', 'Analyst', 'System Administrator')`,
    );
    for (const r of roles.rows) {
      if (r.name === "User") userRoleId = r.id;
      if (r.name === "Manager") managerRoleId = r.id;
      if (r.name === "System Administrator") sysAdminRoleId = r.id;
    }

    // Create customers
    const c1 = await pool.query<{ id: string }>(
      `INSERT INTO customers (external_key, name, status) VALUES ('cust-active', 'Active Customer', 'active') RETURNING id`,
    );
    activeCustomerId = c1.rows[0].id;

    const c2 = await pool.query<{ id: string }>(
      `INSERT INTO customers (external_key, name, status) VALUES ('cust-suspended', 'Suspended Customer', 'suspended') RETURNING id`,
    );
    suspendedCustomerId = c2.rows[0].id;

    const c3 = await pool.query<{ id: string }>(
      `INSERT INTO customers (external_key, name, status) VALUES ('cust-b', 'Customer B', 'active') RETURNING id`,
    );
    customerBId = c3.rows[0].id;

    const c4 = await pool.query<{ id: string }>(
      `INSERT INTO customers (external_key, name, status) VALUES ('cust-c', 'Customer C', 'active') RETURNING id`,
    );
    customerCId = c4.rows[0].id;

    // Create AICE environments
    await pool.query(
      `INSERT INTO aice_environments (aice_id, name, status) VALUES ($1, 'Active Env', 'active')`,
      [activeAiceId],
    );
    await pool.query(
      `INSERT INTO aice_environments (aice_id, name, status) VALUES ($1, 'Suspended Env', 'suspended')`,
      [suspendedAiceId],
    );

    // Link active environment to active customer
    await pool.query(
      `INSERT INTO aice_environment_customers (aice_id, customer_id) VALUES ($1, $2)`,
      [activeAiceId, activeCustomerId],
    );

    // Create accounts
    const mkAccount = async (
      sub: string,
      name: string,
      opts: { analyst_eligible?: boolean; admin_eligible?: boolean } = {},
    ) => {
      const row = await pool.query<{ id: string }>(
        `INSERT INTO accounts (oidc_issuer, oidc_subject, username, display_name, analyst_eligible, admin_eligible)
         VALUES ('test-issuer', $1, $2, $3, $4, $5) RETURNING id`,
        [
          sub,
          name,
          name,
          opts.analyst_eligible ?? false,
          opts.admin_eligible ?? false,
        ],
      );
      return row.rows[0].id;
    };

    userAccountId = await mkAccount("user-001", "user1");
    managerAccountId = await mkAccount("mgr-001", "manager1");
    analystAccountId = await mkAccount("analyst-001", "analyst1", {
      analyst_eligible: true,
    });
    adminAccountId = await mkAccount("admin-001", "admin1", {
      admin_eligible: true,
    });
    multiRoleAccountId = await mkAccount("multi-001", "multi1", {
      analyst_eligible: true,
    });
    noAccessAccountId = await mkAccount("noaccess-001", "noaccess1");

    // Memberships
    await pool.query(
      `INSERT INTO account_customer_memberships (account_id, customer_id, role_id) VALUES ($1, $2, $3)`,
      [userAccountId, activeCustomerId, userRoleId],
    );
    await pool.query(
      `INSERT INTO account_customer_memberships (account_id, customer_id, role_id) VALUES ($1, $2, $3)`,
      [managerAccountId, activeCustomerId, managerRoleId],
    );

    // Multi-role: User in customer A, Manager in customer B, Analyst in customer C
    await pool.query(
      `INSERT INTO account_customer_memberships (account_id, customer_id, role_id) VALUES ($1, $2, $3)`,
      [multiRoleAccountId, activeCustomerId, userRoleId],
    );
    await pool.query(
      `INSERT INTO account_customer_memberships (account_id, customer_id, role_id) VALUES ($1, $2, $3)`,
      [multiRoleAccountId, customerBId, managerRoleId],
    );

    // Analyst assignments
    await pool.query(
      `INSERT INTO analyst_customer_assignments (account_id, customer_id, assigned_by) VALUES ($1, $2, $3)`,
      [analystAccountId, activeCustomerId, adminAccountId],
    );
    await pool.query(
      `INSERT INTO analyst_customer_assignments (account_id, customer_id, assigned_by) VALUES ($1, $2, $3)`,
      [multiRoleAccountId, customerCId, adminAccountId],
    );
  });

  afterAll(async () => {
    await dropTestDatabase(dbName, pool, "auth");
    await closeAdminPool();
  });

  // -------------------------------------------------------------------------
  // General flow per role (#4-7)
  // -------------------------------------------------------------------------

  describe("general flow per role", () => {
    it("User has basic permissions (workspace:read)", async () => {
      const result = await withClient((c) =>
        authorize(c, "general", userAccountId, "workspace:read", {
          customerId: activeCustomerId,
        }),
      );
      expect(result.authorized).toBe(true);
    });

    it("User lacks Manager permissions (customer-members:write)", async () => {
      const result = await withClient((c) =>
        authorize(c, "general", userAccountId, "customer-members:write", {
          customerId: activeCustomerId,
        }),
      );
      expect(result.authorized).toBe(false);
    });

    it("Manager has customer-members:write", async () => {
      const result = await withClient((c) =>
        authorize(c, "general", managerAccountId, "customer-members:write", {
          customerId: activeCustomerId,
        }),
      );
      expect(result.authorized).toBe(true);
    });

    it("Manager also has basic permissions (workspace:read)", async () => {
      const result = await withClient((c) =>
        authorize(c, "general", managerAccountId, "workspace:read", {
          customerId: activeCustomerId,
        }),
      );
      expect(result.authorized).toBe(true);
    });

    it("Analyst has analyst-specific permissions (analyses:configure)", async () => {
      const result = await withClient((c) =>
        authorize(c, "general", analystAccountId, "analyses:configure", {
          customerId: activeCustomerId,
        }),
      );
      expect(result.authorized).toBe(true);
    });

    it("Analyst also has basic permissions (workspace:read)", async () => {
      const result = await withClient((c) =>
        authorize(c, "general", analystAccountId, "workspace:read", {
          customerId: activeCustomerId,
        }),
      );
      expect(result.authorized).toBe(true);
    });
  });

  // -------------------------------------------------------------------------
  // Analyst blocked without eligibility (#6-1)
  // -------------------------------------------------------------------------

  describe("analyst blocked without eligibility", () => {
    it("rejects analyst permissions when analyst_eligible=false", async () => {
      // noAccessAccountId has analyst_eligible=false, even if we add an assignment
      await pool.query(
        `INSERT INTO analyst_customer_assignments (account_id, customer_id, assigned_by)
         VALUES ($1, $2, $3) ON CONFLICT DO NOTHING`,
        [noAccessAccountId, activeCustomerId, adminAccountId],
      );
      // Also need a membership or assignment for any access
      const result = await withClient((c) =>
        authorize(c, "general", noAccessAccountId, "analyses:configure", {
          customerId: activeCustomerId,
        }),
      );
      expect(result.authorized).toBe(false);

      // Cleanup
      await pool.query(
        `DELETE FROM analyst_customer_assignments WHERE account_id = $1 AND customer_id = $2`,
        [noAccessAccountId, activeCustomerId],
      );
    });
  });

  // -------------------------------------------------------------------------
  // Analyst blocked for unassigned customer (#6-2)
  // -------------------------------------------------------------------------

  describe("analyst blocked for unassigned customer", () => {
    it("rejects analyst permissions for customer without assignment", async () => {
      // analystAccountId is analyst-eligible but only assigned to activeCustomerId, not customerBId
      const result = await withClient((c) =>
        authorize(c, "general", analystAccountId, "analyses:configure", {
          customerId: customerBId,
        }),
      );
      expect(result.authorized).toBe(false);
    });
  });

  // -------------------------------------------------------------------------
  // System Admin has no general permissions (#9)
  // -------------------------------------------------------------------------

  describe("System Admin has no general permissions", () => {
    it("rejects general-context permissions for admin", async () => {
      const result = await withClient((c) =>
        authorize(c, "admin", adminAccountId, "customer-settings:write", {
          customerId: activeCustomerId,
        }),
      );
      expect(result.authorized).toBe(false);
    });

    it("grants admin-context permissions", async () => {
      const result = await withClient((c) =>
        authorize(c, "admin", adminAccountId, "accounts:read"),
      );
      expect(result.authorized).toBe(true);
    });

    it("rejects admin-context when admin_eligible=false", async () => {
      const result = await withClient((c) =>
        authorize(c, "admin", userAccountId, "accounts:read"),
      );
      expect(result.authorized).toBe(false);
    });
  });

  // -------------------------------------------------------------------------
  // Immediate effect: analyst_eligible change (#22-1)
  // -------------------------------------------------------------------------

  describe("analyst_eligible change immediate blocking", () => {
    it("blocks analyst features immediately after revoking eligibility", async () => {
      // Verify analyst works before
      let result = await withClient((c) =>
        authorize(c, "general", analystAccountId, "analyses:configure", {
          customerId: activeCustomerId,
        }),
      );
      expect(result.authorized).toBe(true);

      // Revoke eligibility
      await pool.query(
        `UPDATE accounts SET analyst_eligible = false WHERE id = $1`,
        [analystAccountId],
      );

      result = await withClient((c) =>
        authorize(c, "general", analystAccountId, "analyses:configure", {
          customerId: activeCustomerId,
        }),
      );
      expect(result.authorized).toBe(false);

      // Restore
      await pool.query(
        `UPDATE accounts SET analyst_eligible = true WHERE id = $1`,
        [analystAccountId],
      );
    });
  });

  // -------------------------------------------------------------------------
  // Immediate effect: analyst_customer_assignments deletion (#22-2)
  // -------------------------------------------------------------------------

  describe("analyst_customer_assignments deletion immediate blocking", () => {
    it("blocks access immediately after assignment removal", async () => {
      let result = await withClient((c) =>
        authorize(c, "general", analystAccountId, "analyses:configure", {
          customerId: activeCustomerId,
        }),
      );
      expect(result.authorized).toBe(true);

      // Remove assignment
      await pool.query(
        `DELETE FROM analyst_customer_assignments WHERE account_id = $1 AND customer_id = $2`,
        [analystAccountId, activeCustomerId],
      );

      result = await withClient((c) =>
        authorize(c, "general", analystAccountId, "analyses:configure", {
          customerId: activeCustomerId,
        }),
      );
      expect(result.authorized).toBe(false);

      // Restore
      await pool.query(
        `INSERT INTO analyst_customer_assignments (account_id, customer_id, assigned_by) VALUES ($1, $2, $3)`,
        [analystAccountId, activeCustomerId, adminAccountId],
      );
    });
  });

  // -------------------------------------------------------------------------
  // Immediate effect: membership role change (#23)
  // -------------------------------------------------------------------------

  describe("membership role change immediate effect", () => {
    it("applies new permissions immediately after role change", async () => {
      // User initially lacks customer-members:write
      let result = await withClient((c) =>
        authorize(c, "general", userAccountId, "customer-members:write", {
          customerId: activeCustomerId,
        }),
      );
      expect(result.authorized).toBe(false);

      // Promote to Manager
      await pool.query(
        `UPDATE account_customer_memberships SET role_id = $1 WHERE account_id = $2 AND customer_id = $3`,
        [managerRoleId, userAccountId, activeCustomerId],
      );

      result = await withClient((c) =>
        authorize(c, "general", userAccountId, "customer-members:write", {
          customerId: activeCustomerId,
        }),
      );
      expect(result.authorized).toBe(true);

      // Restore to User
      await pool.query(
        `UPDATE account_customer_memberships SET role_id = $1 WHERE account_id = $2 AND customer_id = $3`,
        [userRoleId, userAccountId, activeCustomerId],
      );
    });
  });

  // -------------------------------------------------------------------------
  // Immediate effect: membership deletion (#24)
  // -------------------------------------------------------------------------

  describe("membership deletion immediate blocking", () => {
    it("blocks access immediately after membership removal", async () => {
      let result = await withClient((c) =>
        authorize(c, "general", userAccountId, "workspace:read", {
          customerId: activeCustomerId,
        }),
      );
      expect(result.authorized).toBe(true);

      await pool.query(
        `DELETE FROM account_customer_memberships WHERE account_id = $1 AND customer_id = $2`,
        [userAccountId, activeCustomerId],
      );

      result = await withClient((c) =>
        authorize(c, "general", userAccountId, "workspace:read", {
          customerId: activeCustomerId,
        }),
      );
      expect(result.authorized).toBe(false);

      // Restore
      await pool.query(
        `INSERT INTO account_customer_memberships (account_id, customer_id, role_id) VALUES ($1, $2, $3)`,
        [userAccountId, activeCustomerId, userRoleId],
      );
    });
  });

  // -------------------------------------------------------------------------
  // Multiple customers different roles (#25)
  // -------------------------------------------------------------------------

  describe("multiple customers different roles", () => {
    it("returns different permissions per customer", async () => {
      // multiRoleAccountId: User in activeCustomerId, Manager in customerBId, Analyst in customerCId
      const resultA = await withClient((c) =>
        authorize(c, "general", multiRoleAccountId, "customer-members:write", {
          customerId: activeCustomerId,
        }),
      );
      expect(resultA.authorized).toBe(false); // User role

      const resultB = await withClient((c) =>
        authorize(c, "general", multiRoleAccountId, "customer-members:write", {
          customerId: customerBId,
        }),
      );
      expect(resultB.authorized).toBe(true); // Manager role

      const resultC = await withClient((c) =>
        authorize(c, "general", multiRoleAccountId, "analyses:configure", {
          customerId: customerCId,
        }),
      );
      expect(resultC.authorized).toBe(true); // Analyst role
    });
  });

  // -------------------------------------------------------------------------
  // Inactive customer rejection (#32-1)
  // -------------------------------------------------------------------------

  describe("inactive customer rejection", () => {
    it("rejects authorization for suspended customer", async () => {
      // Add membership to suspended customer
      await pool.query(
        `INSERT INTO account_customer_memberships (account_id, customer_id, role_id) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING`,
        [userAccountId, suspendedCustomerId, userRoleId],
      );

      const result = await withClient((c) =>
        authorize(c, "general", userAccountId, "workspace:read", {
          customerId: suspendedCustomerId,
        }),
      );
      expect(result.authorized).toBe(false);

      await pool.query(
        `DELETE FROM account_customer_memberships WHERE account_id = $1 AND customer_id = $2`,
        [userAccountId, suspendedCustomerId],
      );
    });
  });

  // -------------------------------------------------------------------------
  // Inactive environment rejection (#32-2)
  // -------------------------------------------------------------------------

  describe("inactive environment rejection", () => {
    it("rejects authorization for suspended environment", async () => {
      const result = await withClient((c) =>
        authorize(c, "general", userAccountId, "workspace:read", {
          customerId: activeCustomerId,
          aiceId: suspendedAiceId,
        }),
      );
      expect(result.authorized).toBe(false);
    });

    it("rejects when environment is not linked to customer", async () => {
      // activeAiceId is linked to activeCustomerId but not customerBId
      await pool.query(
        `INSERT INTO account_customer_memberships (account_id, customer_id, role_id) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING`,
        [managerAccountId, customerBId, managerRoleId],
      );

      const result = await withClient((c) =>
        authorize(c, "general", managerAccountId, "workspace:read", {
          customerId: customerBId,
          aiceId: activeAiceId,
        }),
      );
      expect(result.authorized).toBe(false);

      await pool.query(
        `DELETE FROM account_customer_memberships WHERE account_id = $1 AND customer_id = $2`,
        [managerAccountId, customerBId],
      );
    });
  });

  // -------------------------------------------------------------------------
  // requiresAiceId enforcement (#32-3, #32-4)
  // -------------------------------------------------------------------------

  describe("requiresAiceId enforcement", () => {
    it("rejects when requiresAiceId=true and aiceId is missing", async () => {
      const result = await withClient((c) =>
        authorize(c, "general", userAccountId, "workspace:read", {
          customerId: activeCustomerId,
          requiresAiceId: true,
        }),
      );
      expect(result.authorized).toBe(false);
    });

    it("allows when requiresAiceId=true and aiceId is provided", async () => {
      const result = await withClient((c) =>
        authorize(c, "general", userAccountId, "workspace:read", {
          customerId: activeCustomerId,
          aiceId: activeAiceId,
          requiresAiceId: true,
        }),
      );
      expect(result.authorized).toBe(true);
    });

    it("allows Manager access without aiceId when requiresAiceId is not set", async () => {
      const result = await withClient((c) =>
        authorize(c, "general", managerAccountId, "customer-members:write", {
          customerId: activeCustomerId,
        }),
      );
      expect(result.authorized).toBe(true);
    });
  });

  // -------------------------------------------------------------------------
  // operationKind enforcement (#34, #34-1, #34-1a, #34-1b, #34-2)
  // -------------------------------------------------------------------------

  describe("operationKind enforcement", () => {
    // bridgeScope must be built lazily — describe runs before beforeAll.
    const mkBridgeScope = () => ({
      aiceId: activeAiceId,
      customerIds: [activeCustomerId],
    });

    it("rejects write in bridge session", async () => {
      const result = await withClient((c) =>
        authorize(c, "general", userAccountId, "workspace:read", {
          customerId: activeCustomerId,
          operationKind: "write",
          bridgeScope: mkBridgeScope(),
        }),
      );
      expect(result.authorized).toBe(false);
    });

    it("allows read in bridge session", async () => {
      const result = await withClient((c) =>
        authorize(c, "general", userAccountId, "workspace:read", {
          customerId: activeCustomerId,
          operationKind: "read",
          bridgeScope: mkBridgeScope(),
        }),
      );
      expect(result.authorized).toBe(true);
    });

    it("allows ingest in bridge session", async () => {
      const result = await withClient((c) =>
        authorize(c, "general", userAccountId, "workspace:read", {
          customerId: activeCustomerId,
          operationKind: "ingest",
          bridgeScope: mkBridgeScope(),
        }),
      );
      expect(result.authorized).toBe(true);
    });

    it("allows process in bridge session", async () => {
      const result = await withClient((c) =>
        authorize(c, "general", userAccountId, "workspace:read", {
          customerId: activeCustomerId,
          operationKind: "process",
          bridgeScope: mkBridgeScope(),
        }),
      );
      expect(result.authorized).toBe(true);
    });

    it("allows write in direct access session (no bridge)", async () => {
      const result = await withClient((c) =>
        authorize(c, "general", managerAccountId, "customer-members:write", {
          customerId: activeCustomerId,
          operationKind: "write",
        }),
      );
      expect(result.authorized).toBe(true);
    });
  });

  // -------------------------------------------------------------------------
  // allowInBridge enforcement (#34-3, #34-4, #34-5)
  // -------------------------------------------------------------------------

  describe("allowInBridge enforcement", () => {
    const mkBridgeScope = () => ({
      aiceId: activeAiceId,
      customerIds: [activeCustomerId],
    });

    it("rejects bridge session when allowInBridge=false", async () => {
      const result = await withClient((c) =>
        authorize(c, "general", managerAccountId, "customer-members:read", {
          customerId: activeCustomerId,
          allowInBridge: false,
          bridgeScope: mkBridgeScope(),
        }),
      );
      expect(result.authorized).toBe(false);
    });

    it("allows direct session when allowInBridge=false", async () => {
      const result = await withClient((c) =>
        authorize(c, "general", managerAccountId, "customer-members:read", {
          customerId: activeCustomerId,
          allowInBridge: false,
        }),
      );
      expect(result.authorized).toBe(true);
    });

    it("allowInBridge=false evaluated before operationKind in bridge", async () => {
      const result = await withClient((c) =>
        authorize(c, "general", userAccountId, "workspace:read", {
          customerId: activeCustomerId,
          operationKind: "read",
          allowInBridge: false,
          bridgeScope: mkBridgeScope(),
        }),
      );
      expect(result.authorized).toBe(false);
    });
  });

  // -------------------------------------------------------------------------
  // Bridge scope — customer/aice out of scope
  // -------------------------------------------------------------------------

  describe("bridge scope restriction", () => {
    const mkBridgeScope = () => ({
      aiceId: activeAiceId,
      customerIds: [activeCustomerId],
    });

    it("rejects when customerId is not in bridge scope", async () => {
      await pool.query(
        `INSERT INTO account_customer_memberships (account_id, customer_id, role_id) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING`,
        [userAccountId, customerBId, userRoleId],
      );

      const result = await withClient((c) =>
        authorize(c, "general", userAccountId, "workspace:read", {
          customerId: customerBId,
          bridgeScope: mkBridgeScope(),
        }),
      );
      expect(result.authorized).toBe(false);

      await pool.query(
        `DELETE FROM account_customer_memberships WHERE account_id = $1 AND customer_id = $2`,
        [userAccountId, customerBId],
      );
    });

    it("rejects when aiceId does not match bridge scope", async () => {
      const result = await withClient((c) =>
        authorize(c, "general", userAccountId, "workspace:read", {
          customerId: activeCustomerId,
          aiceId: "other-aice.example.com",
          bridgeScope: mkBridgeScope(),
        }),
      );
      expect(result.authorized).toBe(false);
    });
  });

  // -------------------------------------------------------------------------
  // role_permissions change immediate effect (#35-5)
  // -------------------------------------------------------------------------

  describe("role_permissions change immediate effect", () => {
    it("reflects permission removal immediately", async () => {
      // Manager has customer-members:write
      let result = await withClient((c) =>
        authorize(c, "general", managerAccountId, "customer-members:write", {
          customerId: activeCustomerId,
        }),
      );
      expect(result.authorized).toBe(true);

      // Remove permission from Manager role
      await pool.query(
        `DELETE FROM role_permissions WHERE role_id = $1 AND permission = 'customer-members:write'`,
        [managerRoleId],
      );

      result = await withClient((c) =>
        authorize(c, "general", managerAccountId, "customer-members:write", {
          customerId: activeCustomerId,
        }),
      );
      expect(result.authorized).toBe(false);

      // Restore
      await pool.query(
        `INSERT INTO role_permissions (role_id, permission) VALUES ($1, 'customer-members:write')`,
        [managerRoleId],
      );
    });
  });

  // -------------------------------------------------------------------------
  // DB trigger rejection for admin role in membership (#38)
  // -------------------------------------------------------------------------

  describe("DB trigger rejection for admin role in membership", () => {
    it("rejects inserting System Administrator role into memberships", async () => {
      await expect(
        pool.query(
          `INSERT INTO account_customer_memberships (account_id, customer_id, role_id) VALUES ($1, $2, $3)`,
          [noAccessAccountId, activeCustomerId, sysAdminRoleId],
        ),
      ).rejects.toThrow(/auth_context=general/);
    });
  });

  // -------------------------------------------------------------------------
  // assertAuthorized wrapper
  // -------------------------------------------------------------------------

  describe("assertAuthorized", () => {
    it("throws HttpError 403 when not authorized", async () => {
      await expect(
        withClient((c) =>
          assertAuthorized(c, "general", noAccessAccountId, "workspace:read", {
            customerId: activeCustomerId,
          }),
        ),
      ).rejects.toThrow(HttpError);

      try {
        await withClient((c) =>
          assertAuthorized(c, "general", noAccessAccountId, "workspace:read", {
            customerId: activeCustomerId,
          }),
        );
      } catch (err) {
        expect(err).toBeInstanceOf(HttpError);
        expect((err as HttpError).statusCode).toBe(403);
      }
    });

    it("returns permissions set when authorized", async () => {
      const permissions = await withClient((c) =>
        assertAuthorized(c, "general", userAccountId, "workspace:read", {
          customerId: activeCustomerId,
        }),
      );
      expect(permissions).toBeInstanceOf(Set);
      expect(permissions.has("workspace:read")).toBe(true);
    });
  });

  // -------------------------------------------------------------------------
  // No membership and no analyst assignment
  // -------------------------------------------------------------------------

  describe("no access", () => {
    it("rejects when account has no membership or analyst assignment", async () => {
      const result = await withClient((c) =>
        authorize(c, "general", noAccessAccountId, "workspace:read", {
          customerId: activeCustomerId,
        }),
      );
      expect(result.authorized).toBe(false);
    });

    it("rejects general context without customerId", async () => {
      const result = await withClient((c) =>
        authorize(c, "general", userAccountId, "workspace:read"),
      );
      expect(result.authorized).toBe(false);
    });
  });

  // -------------------------------------------------------------------------
  // Permission union — membership + analyst (#33)
  // -------------------------------------------------------------------------

  describe("permission union", () => {
    it("analyst-only account gets analyst permissions for assigned customer", async () => {
      // analystAccountId has no membership, only analyst assignment
      const result = await withClient((c) =>
        authorize(c, "general", analystAccountId, "analyses:configure", {
          customerId: activeCustomerId,
        }),
      );
      expect(result.authorized).toBe(true);
      expect(result.permissions?.has("dashboard:customize")).toBe(true);
    });

    it("union of membership + analyst when both exist", async () => {
      // multiRoleAccountId: User in activeCustomerId + assign analyst to activeCustomerId
      await pool.query(
        `INSERT INTO analyst_customer_assignments (account_id, customer_id, assigned_by) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING`,
        [multiRoleAccountId, activeCustomerId, adminAccountId],
      );

      const result = await withClient((c) =>
        authorize(c, "general", multiRoleAccountId, "analyses:configure", {
          customerId: activeCustomerId,
        }),
      );
      expect(result.authorized).toBe(true);
      // Also has User permissions from membership
      expect(result.permissions?.has("workspace:read")).toBe(true);
      // And Analyst permissions
      expect(result.permissions?.has("dashboard:customize")).toBe(true);

      await pool.query(
        `DELETE FROM analyst_customer_assignments WHERE account_id = $1 AND customer_id = $2`,
        [multiRoleAccountId, activeCustomerId],
      );
    });
  });

  // -------------------------------------------------------------------------
  // Sessions DB invariant — admin + bridge CHECK violation (#35-6)
  // -------------------------------------------------------------------------

  describe("sessions DB invariant", () => {
    it("rejects admin session with bridge context", async () => {
      await expect(
        pool.query(
          `INSERT INTO sessions (account_id, auth_context, ip_address, user_agent, bridge_aice_id, bridge_customer_ids)
           VALUES ($1, 'admin', '127.0.0.1', 'test', 'some-aice.example.com', $2)`,
          [adminAccountId, [activeCustomerId]],
        ),
      ).rejects.toThrow();
    });

    it("rejects bridge_aice_id without bridge_customer_ids", async () => {
      await expect(
        pool.query(
          `INSERT INTO sessions (account_id, auth_context, ip_address, user_agent, bridge_aice_id)
           VALUES ($1, 'general', '127.0.0.1', 'test', 'some-aice.example.com')`,
          [userAccountId],
        ),
      ).rejects.toThrow();
    });

    it("rejects bridge_customer_ids without bridge_aice_id", async () => {
      await expect(
        pool.query(
          `INSERT INTO sessions (account_id, auth_context, ip_address, user_agent, bridge_customer_ids)
           VALUES ($1, 'general', '127.0.0.1', 'test', $2)`,
          [userAccountId, [activeCustomerId]],
        ),
      ).rejects.toThrow();
    });
  });

  // -------------------------------------------------------------------------
  // listAccessibleCustomers (#33, #33-1)
  // -------------------------------------------------------------------------

  describe("listAccessibleCustomers", () => {
    it("returns union of membership + analyst customers", async () => {
      // multiRoleAccountId: User in activeCustomerId, Manager in customerBId, Analyst in customerCId
      const customers = await withClient((c) =>
        listAccessibleCustomers(c, multiRoleAccountId),
      );
      const ids = customers.map((c) => c.id);
      expect(ids).toContain(activeCustomerId);
      expect(ids).toContain(customerBId);
      expect(ids).toContain(customerCId);
    });

    it("excludes suspended customers", async () => {
      await pool.query(
        `INSERT INTO account_customer_memberships (account_id, customer_id, role_id)
         VALUES ($1, $2, $3) ON CONFLICT DO NOTHING`,
        [userAccountId, suspendedCustomerId, userRoleId],
      );

      const customers = await withClient((c) =>
        listAccessibleCustomers(c, userAccountId),
      );
      const ids = customers.map((c) => c.id);
      expect(ids).not.toContain(suspendedCustomerId);

      await pool.query(
        `DELETE FROM account_customer_memberships WHERE account_id = $1 AND customer_id = $2`,
        [userAccountId, suspendedCustomerId],
      );
    });

    it("restricts to bridge scope when provided", async () => {
      const bridgeScope = {
        aiceId: activeAiceId,
        customerIds: [activeCustomerId],
      };
      const customers = await withClient((c) =>
        listAccessibleCustomers(c, multiRoleAccountId, bridgeScope),
      );
      const ids = customers.map((c) => c.id);
      expect(ids).toContain(activeCustomerId);
      expect(ids).not.toContain(customerBId);
      expect(ids).not.toContain(customerCId);
    });

    it("returns empty for account with no access", async () => {
      const customers = await withClient((c) =>
        listAccessibleCustomers(c, noAccessAccountId),
      );
      expect(customers).toHaveLength(0);
    });
  });

  // -------------------------------------------------------------------------
  // listAccessibleCustomersDetailed (#31)
  // -------------------------------------------------------------------------

  describe("listAccessibleCustomersDetailed", () => {
    it("returns role and isAnalyst fields for multi-role account", async () => {
      const customers = await withClient((c) =>
        listAccessibleCustomersDetailed(c, multiRoleAccountId),
      );
      const byId = new Map(customers.map((c) => [c.id, c]));

      // User membership in activeCustomer
      const active = byId.get(activeCustomerId);
      expect(active).toBeDefined();
      expect(active?.role).toBe("User");
      expect(active?.isAnalyst).toBe(false);

      // Manager membership in customerB
      const b = byId.get(customerBId);
      expect(b).toBeDefined();
      expect(b?.role).toBe("Manager");
      expect(b?.isAnalyst).toBe(false);

      // Analyst-only in customerC (no membership)
      const cust = byId.get(customerCId);
      expect(cust).toBeDefined();
      expect(cust?.role).toBeNull();
      expect(cust?.isAnalyst).toBe(true);
    });

    it("returns analyst-only access without membership", async () => {
      const customers = await withClient((c) =>
        listAccessibleCustomersDetailed(c, analystAccountId),
      );
      const byId = new Map(customers.map((c) => [c.id, c]));

      const active = byId.get(activeCustomerId);
      expect(active).toBeDefined();
      expect(active?.role).toBeNull();
      expect(active?.isAnalyst).toBe(true);
    });

    it("returns role for membership-only account", async () => {
      const customers = await withClient((c) =>
        listAccessibleCustomersDetailed(c, managerAccountId),
      );
      const byId = new Map(customers.map((c) => [c.id, c]));

      const active = byId.get(activeCustomerId);
      expect(active).toBeDefined();
      expect(active?.role).toBe("Manager");
      expect(active?.isAnalyst).toBe(false);
    });

    it("excludes suspended customers", async () => {
      await pool.query(
        `INSERT INTO account_customer_memberships (account_id, customer_id, role_id)
         VALUES ($1, $2, $3) ON CONFLICT DO NOTHING`,
        [userAccountId, suspendedCustomerId, userRoleId],
      );

      const customers = await withClient((c) =>
        listAccessibleCustomersDetailed(c, userAccountId),
      );
      const ids = customers.map((c) => c.id);
      expect(ids).not.toContain(suspendedCustomerId);

      await pool.query(
        `DELETE FROM account_customer_memberships WHERE account_id = $1 AND customer_id = $2`,
        [userAccountId, suspendedCustomerId],
      );
    });

    it("restricts to bridge scope when provided", async () => {
      const bridgeScope = {
        aiceId: activeAiceId,
        customerIds: [activeCustomerId],
      };
      const customers = await withClient((c) =>
        listAccessibleCustomersDetailed(c, multiRoleAccountId, bridgeScope),
      );
      const ids = customers.map((c) => c.id);
      expect(ids).toContain(activeCustomerId);
      expect(ids).not.toContain(customerBId);
      expect(ids).not.toContain(customerCId);
    });

    it("returns empty for account with no access", async () => {
      const customers = await withClient((c) =>
        listAccessibleCustomersDetailed(c, noAccessAccountId),
      );
      expect(customers).toHaveLength(0);
    });
  });

  // -------------------------------------------------------------------------
  // listAccessibleEnvironments (#33-2, #33-3)
  // -------------------------------------------------------------------------

  describe("listAccessibleEnvironments", () => {
    it("returns active environments linked to customer", async () => {
      const envs = await withClient((c) =>
        listAccessibleEnvironments(c, managerAccountId, activeCustomerId),
      );
      const ids = envs.map((e) => e.aiceId);
      expect(ids).toContain(activeAiceId);
      // suspendedAiceId is not linked to activeCustomerId, so not present
    });

    it("excludes suspended environments", async () => {
      // Link suspended env to active customer
      await pool.query(
        `INSERT INTO aice_environment_customers (aice_id, customer_id)
         VALUES ($1, $2) ON CONFLICT DO NOTHING`,
        [suspendedAiceId, activeCustomerId],
      );

      const envs = await withClient((c) =>
        listAccessibleEnvironments(c, managerAccountId, activeCustomerId),
      );
      const ids = envs.map((e) => e.aiceId);
      expect(ids).not.toContain(suspendedAiceId);

      await pool.query(
        `DELETE FROM aice_environment_customers WHERE aice_id = $1 AND customer_id = $2`,
        [suspendedAiceId, activeCustomerId],
      );
    });

    it("restricts to bridge scope aiceId when provided", async () => {
      // Add another active env linked to activeCustomerId
      await pool.query(
        `INSERT INTO aice_environments (aice_id, name, status)
         VALUES ('other-active.example.com', 'Other Env', 'active') ON CONFLICT DO NOTHING`,
      );
      await pool.query(
        `INSERT INTO aice_environment_customers (aice_id, customer_id)
         VALUES ('other-active.example.com', $1) ON CONFLICT DO NOTHING`,
        [activeCustomerId],
      );

      const bridgeScope = {
        aiceId: activeAiceId,
        customerIds: [activeCustomerId],
      };
      const envs = await withClient((c) =>
        listAccessibleEnvironments(
          c,
          managerAccountId,
          activeCustomerId,
          bridgeScope,
        ),
      );
      expect(envs).toHaveLength(1);
      expect(envs[0].aiceId).toBe(activeAiceId);

      await pool.query(
        `DELETE FROM aice_environment_customers WHERE aice_id = 'other-active.example.com'`,
      );
      await pool.query(
        `DELETE FROM aice_environments WHERE aice_id = 'other-active.example.com'`,
      );
    });

    it("returns empty for account without access to customer", async () => {
      const envs = await withClient((c) =>
        listAccessibleEnvironments(c, noAccessAccountId, activeCustomerId),
      );
      expect(envs).toHaveLength(0);
    });

    it("returns empty when customerId is outside bridge scope", async () => {
      const bridgeScope = {
        aiceId: activeAiceId,
        customerIds: [suspendedCustomerId], // activeCustomerId not in scope
      };
      const envs = await withClient((c) =>
        listAccessibleEnvironments(
          c,
          managerAccountId,
          activeCustomerId,
          bridgeScope,
        ),
      );
      expect(envs).toHaveLength(0);
    });
  });
});
