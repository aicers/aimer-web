import { join } from "node:path";
import type { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runMigrations } from "../migrate";
import {
  closeAdminPool,
  createRolePool,
  createTestDatabase,
  dropTestDatabase,
  hasPostgres,
} from "./db-test-helpers";

const MIGRATIONS_ROOT = join(process.cwd(), "migrations");
const LOCK_ID_AUTH = 1000;
const LOCK_ID_AUDIT = 1001;

describe.skipIf(!hasPostgres)("Schema verification (auth_db)", () => {
  let dbName: string;
  let pool: Pool;

  beforeAll(async () => {
    const db = await createTestDatabase("schema_auth");
    dbName = db.dbName;
    pool = db.pool;

    // Apply all auth migrations
    await runMigrations(pool, join(MIGRATIONS_ROOT, "auth"), LOCK_ID_AUTH);
  });

  afterAll(async () => {
    await dropTestDatabase(dbName, pool);
  });

  it("applies all auth migrations cleanly", async () => {
    const { rows } = await pool.query(
      "SELECT version FROM _migrations ORDER BY version",
    );
    expect(rows).toHaveLength(26);
  });

  // -- Built-in roles --

  it("seeds 4 built-in roles with correct permission counts", async () => {
    const { rows } = await pool.query(`
      SELECT r.name, r.auth_context, COUNT(rp.permission)::int AS perm_count
      FROM roles r
      LEFT JOIN role_permissions rp ON rp.role_id = r.id
      WHERE r.is_builtin = true
      GROUP BY r.id, r.name, r.auth_context
      ORDER BY r.name
    `);

    // Counts include the redaction-ranges and retention permission
    // keys seeded by 0022_redaction_permissions.sql:
    //   read keys → User, Analyst, Manager, System Administrator (+2)
    //   write keys → Manager, System Administrator (+2)
    expect(rows).toEqual([
      { name: "Analyst", auth_context: "general", perm_count: 14 },
      { name: "Manager", auth_context: "general", perm_count: 15 },
      {
        name: "System Administrator",
        auth_context: "admin",
        perm_count: 17,
      },
      { name: "User", auth_context: "general", perm_count: 9 },
    ]);
  });

  it("seeds redaction-ranges and retention permissions on the right roles", async () => {
    const { rows } = await pool.query<{
      name: string;
      permission: string;
    }>(
      `SELECT r.name, rp.permission
       FROM roles r
       JOIN role_permissions rp ON rp.role_id = r.id
       WHERE rp.permission IN (
         'customer-redaction-ranges:read',
         'customer-redaction-ranges:write',
         'customer-retention:read',
         'customer-retention:write'
       )
       ORDER BY rp.permission, r.name`,
    );

    const grouped: Record<string, string[]> = {};
    for (const row of rows) {
      if (!grouped[row.permission]) grouped[row.permission] = [];
      grouped[row.permission].push(row.name);
    }
    for (const key of Object.keys(grouped)) grouped[key].sort();

    expect(grouped["customer-redaction-ranges:read"]).toEqual([
      "Analyst",
      "Manager",
      "System Administrator",
      "User",
    ]);
    expect(grouped["customer-redaction-ranges:write"]).toEqual([
      "Manager",
      "System Administrator",
    ]);
    expect(grouped["customer-retention:read"]).toEqual([
      "Analyst",
      "Manager",
      "System Administrator",
      "User",
    ]);
    expect(grouped["customer-retention:write"]).toEqual([
      "Manager",
      "System Administrator",
    ]);
  });

  // -- CHECK constraints: sessions --

  describe("sessions CHECK constraints", () => {
    let accountId: string;

    beforeAll(async () => {
      // Insert prerequisite data
      const { rows } = await pool.query(
        "INSERT INTO accounts (oidc_issuer, oidc_subject, username, display_name) VALUES ('test', 'sub1', 'testuser', 'Test') RETURNING id",
      );
      accountId = rows[0].id;
    });

    it("rejects admin session with bridge fields", async () => {
      await expect(
        pool.query(
          `INSERT INTO sessions (account_id, auth_context, bridge_aice_id, bridge_customer_ids, ip_address, user_agent)
           VALUES ($1, 'admin', 'aice1', ARRAY[$2]::uuid[], '1.1.1.1', 'test')`,
          [accountId, "00000000-0000-0000-0000-000000000001"],
        ),
      ).rejects.toThrow();
    });

    it("rejects session with only one bridge field NULL", async () => {
      await expect(
        pool.query(
          `INSERT INTO sessions (account_id, auth_context, bridge_aice_id, bridge_customer_ids, ip_address, user_agent)
           VALUES ($1, 'general', 'aice1', NULL, '1.1.1.1', 'test')`,
          [accountId],
        ),
      ).rejects.toThrow();
    });
  });

  // -- CHECK constraints: status enums --

  describe("status CHECK constraints reject invalid values", () => {
    it("customers.status", async () => {
      await expect(
        pool.query(
          "INSERT INTO customers (external_key, name, status) VALUES ('ck1', 'c', 'invalid')",
        ),
      ).rejects.toThrow();
    });

    it("customers.database_status", async () => {
      await expect(
        pool.query(
          "INSERT INTO customers (external_key, name, database_status) VALUES ('ck2', 'c', 'invalid')",
        ),
      ).rejects.toThrow();
    });

    it("accounts.status", async () => {
      await expect(
        pool.query(
          "INSERT INTO accounts (oidc_issuer, oidc_subject, username, display_name, status) VALUES ('i', 's2', 'u', 'd', 'invalid')",
        ),
      ).rejects.toThrow();
    });

    it("pending_connections.status", async () => {
      await expect(
        pool.query(
          "INSERT INTO pending_connections (jti, issuer, aice_id, customer_ids, status, expires_at) VALUES ('j1', 'i', 'a', ARRAY['x'], 'invalid', NOW())",
        ),
      ).rejects.toThrow();
    });

    it("invitations.status", async () => {
      await expect(
        pool.query(
          "INSERT INTO invitations (token_hash, customer_id, invited_email, role_id, invited_by, status) VALUES ('h1', gen_random_uuid(), 'a@b.c', 1, gen_random_uuid(), 'invalid')",
        ),
      ).rejects.toThrow();
    });

    it("analyst_invitations.status", async () => {
      await expect(
        pool.query(
          "INSERT INTO analyst_invitations (email, invited_by, token_hash, status) VALUES ('a@b.c', gen_random_uuid(), 'h2', 'invalid')",
        ),
      ).rejects.toThrow();
    });

    it("staged_event_customers.status", async () => {
      await expect(
        pool.query(
          "INSERT INTO staged_event_customers (payload_id, customer_id, status) VALUES (gen_random_uuid(), gen_random_uuid(), 'invalid')",
        ),
      ).rejects.toThrow();
    });
  });

  // -- UNIQUE constraints --

  describe("UNIQUE constraints reject duplicates", () => {
    it("accounts(oidc_issuer, oidc_subject)", async () => {
      await pool.query(
        "INSERT INTO accounts (oidc_issuer, oidc_subject, username, display_name) VALUES ('iss1', 'dup', 'u1', 'D1')",
      );
      await expect(
        pool.query(
          "INSERT INTO accounts (oidc_issuer, oidc_subject, username, display_name) VALUES ('iss1', 'dup', 'u2', 'D2')",
        ),
      ).rejects.toThrow();
    });

    it("invitations partial unique (customer_id, email) WHERE pending", async () => {
      // Create prerequisite customer and account
      const { rows: cRows } = await pool.query(
        "INSERT INTO customers (external_key, name) VALUES ('uniq_test', 'C') RETURNING id",
      );
      const custId = cRows[0].id;
      const { rows: aRows } = await pool.query(
        "INSERT INTO accounts (oidc_issuer, oidc_subject, username, display_name) VALUES ('iss2', 'sub_uniq', 'u3', 'D3') RETURNING id",
      );
      const acctId = aRows[0].id;
      // Get a general-context role
      const { rows: rRows } = await pool.query(
        "SELECT id FROM roles WHERE name = 'User'",
      );
      const roleId = rRows[0].id;

      await pool.query(
        "INSERT INTO invitations (token_hash, customer_id, invited_email, role_id, invited_by, status) VALUES ('t1', $1, 'dup@test.com', $2, $3, 'pending')",
        [custId, roleId, acctId],
      );
      await expect(
        pool.query(
          "INSERT INTO invitations (token_hash, customer_id, invited_email, role_id, invited_by, status) VALUES ('t2', $1, 'dup@test.com', $2, $3, 'pending')",
          [custId, roleId, acctId],
        ),
      ).rejects.toThrow();
    });

    it("customers.external_key", async () => {
      await pool.query(
        "INSERT INTO customers (external_key, name) VALUES ('dup_ek', 'C1')",
      );
      await expect(
        pool.query(
          "INSERT INTO customers (external_key, name) VALUES ('dup_ek', 'C2')",
        ),
      ).rejects.toThrow();
    });

    it("roles.name", async () => {
      await pool.query(
        "INSERT INTO roles (name, auth_context) VALUES ('uniq_role', 'general')",
      );
      await expect(
        pool.query(
          "INSERT INTO roles (name, auth_context) VALUES ('uniq_role', 'general')",
        ),
      ).rejects.toThrow();
    });

    it("pending_connections.jti", async () => {
      await pool.query(
        "INSERT INTO pending_connections (jti, issuer, aice_id, customer_ids, expires_at) VALUES ('dup_jti', 'i', 'a', ARRAY['x'], NOW())",
      );
      await expect(
        pool.query(
          "INSERT INTO pending_connections (jti, issuer, aice_id, customer_ids, expires_at) VALUES ('dup_jti', 'i', 'a', ARRAY['x'], NOW())",
        ),
      ).rejects.toThrow();
    });

    it("trust_registry(aice_id, issuer, kid)", async () => {
      // Create prerequisite aice_environment
      await pool.query(
        "INSERT INTO aice_environments (aice_id, name) VALUES ('aice_uniq', 'Env')",
      );
      await pool.query(
        "INSERT INTO trust_registry (aice_id, issuer, kid, public_key) VALUES ('aice_uniq', 'iss', 'kid1', '{}')",
      );
      await expect(
        pool.query(
          "INSERT INTO trust_registry (aice_id, issuer, kid, public_key) VALUES ('aice_uniq', 'iss', 'kid1', '{}')",
        ),
      ).rejects.toThrow();
    });
  });

  // -- Triggers --

  describe("triggers enforce auth_context separation", () => {
    let adminRoleId: number;
    let customerId: string;
    let accountId: string;

    beforeAll(async () => {
      const { rows: roles } = await pool.query(
        "SELECT id, auth_context FROM roles WHERE name IN ('System Administrator', 'User') ORDER BY name",
      );
      adminRoleId = roles.find((r) => r.auth_context === "admin")?.id;

      const { rows: cRows } = await pool.query(
        "INSERT INTO customers (external_key, name) VALUES ('trg_test', 'TrgC') RETURNING id",
      );
      customerId = cRows[0].id;

      const { rows: aRows } = await pool.query(
        "INSERT INTO accounts (oidc_issuer, oidc_subject, username, display_name) VALUES ('trg_iss', 'trg_sub', 'trg_u', 'Trg') RETURNING id",
      );
      accountId = aRows[0].id;
    });

    it("trg_membership_role_check rejects admin-context role", async () => {
      await expect(
        pool.query(
          "INSERT INTO account_customer_memberships (account_id, customer_id, role_id) VALUES ($1, $2, $3)",
          [accountId, customerId, adminRoleId],
        ),
      ).rejects.toThrow("auth_context=general");
    });

    it("trg_invitation_role_check rejects admin-context role", async () => {
      await expect(
        pool.query(
          "INSERT INTO invitations (token_hash, customer_id, invited_email, role_id, invited_by) VALUES ('trg_t1', $1, 'x@y.z', $2, $3)",
          [customerId, adminRoleId, accountId],
        ),
      ).rejects.toThrow("auth_context=general");
    });

    it("trg_roles_auth_context_guard rejects general→admin when referenced by memberships", async () => {
      // Create a custom general role referenced by a membership
      const { rows: rRows } = await pool.query(
        "INSERT INTO roles (name, auth_context) VALUES ('guard_test_m', 'general') RETURNING id",
      );
      const roleId = rRows[0].id;
      await pool.query(
        "INSERT INTO account_customer_memberships (account_id, customer_id, role_id) VALUES ($1, $2, $3)",
        [accountId, customerId, roleId],
      );

      await expect(
        pool.query("UPDATE roles SET auth_context = 'admin' WHERE id = $1", [
          roleId,
        ]),
      ).rejects.toThrow("account_customer_memberships");
    });

    it("trg_roles_auth_context_guard rejects general→admin when referenced by invitations", async () => {
      const { rows: rRows } = await pool.query(
        "INSERT INTO roles (name, auth_context) VALUES ('guard_test_i', 'general') RETURNING id",
      );
      const roleId = rRows[0].id;
      await pool.query(
        "INSERT INTO invitations (token_hash, customer_id, invited_email, role_id, invited_by) VALUES ('guard_i1', $1, 'g@h.i', $2, $3)",
        [customerId, roleId, accountId],
      );

      await expect(
        pool.query("UPDATE roles SET auth_context = 'admin' WHERE id = $1", [
          roleId,
        ]),
      ).rejects.toThrow("invitations");
    });

    it("trg_roles_auth_context_guard rejects general→admin when referenced by both", async () => {
      const { rows: rRows } = await pool.query(
        "INSERT INTO roles (name, auth_context) VALUES ('guard_test_b', 'general') RETURNING id",
      );
      const roleId = rRows[0].id;

      // Create a new account to avoid PK conflict
      const { rows: aRows } = await pool.query(
        "INSERT INTO accounts (oidc_issuer, oidc_subject, username, display_name) VALUES ('trg_iss2', 'trg_sub2', 'trg_u2', 'Trg2') RETURNING id",
      );
      const acctId2 = aRows[0].id;

      await pool.query(
        "INSERT INTO account_customer_memberships (account_id, customer_id, role_id) VALUES ($1, $2, $3)",
        [acctId2, customerId, roleId],
      );
      await pool.query(
        "INSERT INTO invitations (token_hash, customer_id, invited_email, role_id, invited_by) VALUES ('guard_b1', $1, 'b@c.d', $2, $3)",
        [customerId, roleId, acctId2],
      );

      await expect(
        pool.query("UPDATE roles SET auth_context = 'admin' WHERE id = $1", [
          roleId,
        ]),
      ).rejects.toThrow("account_customer_memberships");
    });
  });

  // -- Runtime role permissions --

  describe("runtime role (aimer_auth) permissions", () => {
    let rolePool: Pool;

    beforeAll(async () => {
      // Grant aimer_auth the necessary privileges on the test database.
      // The init-databases.sql only grants on the original auth_db, not
      // our test database. We must grant here.
      await pool.query(`GRANT CONNECT ON DATABASE ${dbName} TO aimer_auth`);
      await pool.query("GRANT USAGE ON SCHEMA public TO aimer_auth");
      // Re-run the runtime role grants (migration 0012 already ran but
      // on this test DB as superuser — the GRANT statements are
      // effective because the tables were created by the superuser).

      rolePool = createRolePool(dbName, "aimer_auth", "changeme");
    });

    afterAll(async () => {
      // Suppress FATAL errors that arrive asynchronously when the parent
      // afterAll terminates backends via dropTestDatabase.
      rolePool.on("error", () => {});
      await rolePool.end();
    });

    it("can SELECT, INSERT, UPDATE, DELETE on application tables", async () => {
      // Test CRUD on customers
      const { rows } = await rolePool.query(
        "INSERT INTO customers (external_key, name) VALUES ('role_test', 'RoleC') RETURNING id",
      );
      expect(rows).toHaveLength(1);

      const { rows: selected } = await rolePool.query(
        "SELECT name FROM customers WHERE external_key = 'role_test'",
      );
      expect(selected[0].name).toBe("RoleC");

      await rolePool.query(
        "UPDATE customers SET name = 'Updated' WHERE external_key = 'role_test'",
      );

      await rolePool.query(
        "DELETE FROM customers WHERE external_key = 'role_test'",
      );
    });

    it("can access all granted application tables", async () => {
      // Verify SELECT on every table granted in 0012_runtime_role.sql.
      // Full CRUD tables (13 total):
      const crudTables = [
        "system_settings",
        "customers",
        "accounts",
        "account_customer_memberships",
        "analyst_customer_assignments",
        "sessions",
        "aice_environments",
        "aice_environment_customers",
        "trust_registry",
        "pending_connections",
        "invitations",
        "analyst_invitations",
        "staged_event_payloads",
        "staged_event_customers",
      ];
      for (const table of crudTables) {
        const { rows } = await rolePool.query(`SELECT COUNT(*) FROM ${table}`);
        expect(Number(rows[0].count)).toBeGreaterThanOrEqual(0);
      }
    });

    it("can only SELECT on roles and role_permissions", async () => {
      // SELECT should work
      const { rows } = await rolePool.query("SELECT COUNT(*) FROM roles");
      expect(Number(rows[0].count)).toBeGreaterThan(0);

      // INSERT should fail
      await expect(
        rolePool.query(
          "INSERT INTO roles (name, auth_context) VALUES ('hack', 'general')",
        ),
      ).rejects.toThrow();
    });

    it("cannot perform DDL", async () => {
      await expect(
        rolePool.query("CREATE TABLE hack_table (id int)"),
      ).rejects.toThrow();
    });
  });
});

// -- Audit database tests --

describe.skipIf(!hasPostgres)("Schema verification (audit_db)", () => {
  let dbName: string;
  let pool: Pool;

  beforeAll(async () => {
    const db = await createTestDatabase("schema_audit", "audit");
    dbName = db.dbName;
    pool = db.pool;

    // Apply all audit migrations
    await runMigrations(pool, join(MIGRATIONS_ROOT, "audit"), LOCK_ID_AUDIT);
  });

  afterAll(async () => {
    await dropTestDatabase(dbName, pool, "audit");
    await closeAdminPool();
  });

  it("applies all audit migrations cleanly", async () => {
    const { rows } = await pool.query(
      "SELECT version FROM _migrations ORDER BY version",
    );
    expect(rows).toHaveLength(3);
  });

  it("audit_logs.auth_context rejects invalid values", async () => {
    await expect(
      pool.query(
        "INSERT INTO audit_logs (actor_id, auth_context, action, target_type) VALUES ('a', 'invalid', 'test', 'test')",
      ),
    ).rejects.toThrow();
  });

  describe("audit runtime role (aimer_audit) permissions", () => {
    let rolePool: Pool;

    beforeAll(async () => {
      await pool.query(`GRANT CONNECT ON DATABASE ${dbName} TO aimer_audit`);
      await pool.query("GRANT USAGE ON SCHEMA public TO aimer_audit");
      // The audit role grants are applied by migration 0001_audit_roles.sql
      // which grants to aimer_audit_owner and aimer_audit. Since we ran
      // migrations as superuser, re-grant explicitly.
      await pool.query("GRANT SELECT, INSERT ON audit_logs TO aimer_audit");
      await pool.query(
        "GRANT SELECT, INSERT ON suspicious_activity_alerts TO aimer_audit",
      );
      await pool.query(
        "GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO aimer_audit",
      );

      rolePool = createRolePool(dbName, "aimer_audit", "changeme", "audit");
    });

    afterAll(async () => {
      rolePool.on("error", () => {});
      await rolePool.end();
    });

    it("can INSERT and SELECT on audit_logs", async () => {
      await rolePool.query(
        "INSERT INTO audit_logs (actor_id, action, target_type) VALUES ('test', 'test', 'test')",
      );
      const { rows } = await rolePool.query("SELECT COUNT(*) FROM audit_logs");
      expect(Number(rows[0].count)).toBeGreaterThan(0);
    });

    it("cannot UPDATE or DELETE on audit_logs", async () => {
      await expect(
        rolePool.query("UPDATE audit_logs SET action = 'hack' WHERE id = 1"),
      ).rejects.toThrow();

      await expect(
        rolePool.query("DELETE FROM audit_logs WHERE id = 1"),
      ).rejects.toThrow();
    });
  });
});
