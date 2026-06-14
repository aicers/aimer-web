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
const LOCK_ID_FEED = 1002;

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
    // The collapsed first-version schema (#535): one 0000_init.sql.
    expect(rows).toHaveLength(1);
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

    // Counts follow the seed section of migrations/auth/0000_init.sql:
    // every role carries the User base (7) except System Administrator,
    // whose 15 admin-context keys include the analyst designation pair
    // (#266). On top of the base:
    //   redaction-ranges + retention keys — read → User, Analyst,
    //   Manager, System Administrator (+2); write → Manager, System
    //   Administrator (+2)
    //   owned-domains keys — read → User, Analyst, Manager, System
    //   Administrator (+1); write → Manager, System Administrator (+1)
    //   per-customer default-model keys (#473) — read + write →
    //   Analyst, System Administrator only (+2 each)
    //   per-subject ti-sources keys (#598) — read + write → Analyst,
    //   System Administrator only (+2 each)
    //   ti-feed keys (#566) — read + write → System Administrator only (+2)
    //   Manager extras — customer-settings + customer-members (+4)
    //   Analyst extras — advanced-analysis keys (+5)
    expect(rows).toEqual([
      { name: "Analyst", auth_context: "general", perm_count: 19 },
      { name: "Manager", auth_context: "general", perm_count: 17 },
      {
        name: "System Administrator",
        auth_context: "admin",
        perm_count: 27,
      },
      { name: "User", auth_context: "general", perm_count: 10 },
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

  it("seeds owned-domains permissions on the right roles", async () => {
    const { rows } = await pool.query<{
      name: string;
      permission: string;
    }>(
      `SELECT r.name, rp.permission
       FROM roles r
       JOIN role_permissions rp ON rp.role_id = r.id
       WHERE rp.permission IN (
         'customer-owned-domains:read',
         'customer-owned-domains:write'
       )
       ORDER BY rp.permission, r.name`,
    );

    const grouped: Record<string, string[]> = {};
    for (const row of rows) {
      if (!grouped[row.permission]) grouped[row.permission] = [];
      grouped[row.permission].push(row.name);
    }
    for (const key of Object.keys(grouped)) grouped[key].sort();

    expect(grouped["customer-owned-domains:read"]).toEqual([
      "Analyst",
      "Manager",
      "System Administrator",
      "User",
    ]);
    expect(grouped["customer-owned-domains:write"]).toEqual([
      "Manager",
      "System Administrator",
    ]);
  });

  it("seeds per-customer default-model permissions on the right roles", async () => {
    const { rows } = await pool.query<{
      name: string;
      permission: string;
    }>(
      `SELECT r.name, rp.permission
       FROM roles r
       JOIN role_permissions rp ON rp.role_id = r.id
       WHERE rp.permission IN (
         'customer-default-model:read',
         'customer-default-model:write'
       )
       ORDER BY rp.permission, r.name`,
    );

    const grouped: Record<string, string[]> = {};
    for (const row of rows) {
      if (!grouped[row.permission]) grouped[row.permission] = [];
      grouped[row.permission].push(row.name);
    }
    for (const key of Object.keys(grouped)) grouped[key].sort();

    // Per the #473 matrix: per-customer default model is analyst-facing
    // — read and write seeded only to Analyst and System Administrator,
    // never Manager or User.
    expect(grouped["customer-default-model:read"]).toEqual([
      "Analyst",
      "System Administrator",
    ]);
    expect(grouped["customer-default-model:write"]).toEqual([
      "Analyst",
      "System Administrator",
    ]);
  });

  it("seeds per-subject ti-sources permissions on the right roles", async () => {
    const { rows } = await pool.query<{
      name: string;
      permission: string;
    }>(
      `SELECT r.name, rp.permission
       FROM roles r
       JOIN role_permissions rp ON rp.role_id = r.id
       WHERE rp.permission IN (
         'ti-sources:read',
         'ti-sources:write'
       )
       ORDER BY rp.permission, r.name`,
    );

    const grouped: Record<string, string[]> = {};
    for (const row of rows) {
      if (!grouped[row.permission]) grouped[row.permission] = [];
      grouped[row.permission].push(row.name);
    }
    for (const key of Object.keys(grouped)) grouped[key].sort();

    // Per the #598 matrix: per-subject TI source selection is analyst-facing
    // — read and write seeded only to Analyst and System Administrator, never
    // Manager or User. The admin-global default route reuses system-settings.
    expect(grouped["ti-sources:read"]).toEqual([
      "Analyst",
      "System Administrator",
    ]);
    expect(grouped["ti-sources:write"]).toEqual([
      "Analyst",
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

    it("accounts.locale rejects an unsupported locale (#387)", async () => {
      await expect(
        pool.query(
          "INSERT INTO accounts (oidc_issuer, oidc_subject, username, display_name, locale) VALUES ('i', 'loc_bad', 'u', 'd', 'fr')",
        ),
      ).rejects.toThrow();
    });

    it("accounts.locale accepts supported locales and NULL (#387)", async () => {
      await expect(
        pool.query(
          "INSERT INTO accounts (oidc_issuer, oidc_subject, username, display_name, locale) VALUES ('i', 'loc_en', 'u', 'd', 'en')",
        ),
      ).resolves.toBeDefined();
      await expect(
        pool.query(
          "INSERT INTO accounts (oidc_issuer, oidc_subject, username, display_name, locale) VALUES ('i', 'loc_ko', 'u', 'd', 'ko')",
        ),
      ).resolves.toBeDefined();
      await expect(
        pool.query(
          "INSERT INTO accounts (oidc_issuer, oidc_subject, username, display_name, locale) VALUES ('i', 'loc_null', 'u', 'd', NULL)",
        ),
      ).resolves.toBeDefined();
    });

    it("accounts.time_format_hour_cycle rejects an unknown value (#556)", async () => {
      await expect(
        pool.query(
          "INSERT INTO accounts (oidc_issuer, oidc_subject, username, display_name, time_format_hour_cycle) VALUES ('i', 'tf_hc_bad', 'u', 'd', 'h24')",
        ),
      ).rejects.toThrow();
    });

    it("accounts.time_format_* accept their values and NULL (#556)", async () => {
      // All four columns are nullable with no SQL default; hour_cycle is the
      // only CHECK-constrained one ('h12'/'h23').
      await expect(
        pool.query(
          `INSERT INTO accounts (oidc_issuer, oidc_subject, username, display_name,
             time_format_locale, time_format_hour_cycle, time_format_seconds, time_format_tz_label)
           VALUES ('i', 'tf_set', 'u', 'd', 'en-GB', 'h23', false, true)`,
        ),
      ).resolves.toBeDefined();
      await expect(
        pool.query(
          `INSERT INTO accounts (oidc_issuer, oidc_subject, username, display_name,
             time_format_locale, time_format_hour_cycle, time_format_seconds, time_format_tz_label)
           VALUES ('i', 'tf_app', 'u', 'd', 'app', 'h12', true, false)`,
        ),
      ).resolves.toBeDefined();
      await expect(
        pool.query(
          `INSERT INTO accounts (oidc_issuer, oidc_subject, username, display_name,
             time_format_locale, time_format_hour_cycle, time_format_seconds, time_format_tz_label)
           VALUES ('i', 'tf_null', 'u', 'd', NULL, NULL, NULL, NULL)`,
        ),
      ).resolves.toBeDefined();
    });

    it("accounts.time_format_* default to NULL when unspecified (#556)", async () => {
      const { rows } = await pool.query(
        `INSERT INTO accounts (oidc_issuer, oidc_subject, username, display_name)
         VALUES ('i', 'tf_default', 'u', 'd')
         RETURNING time_format_locale, time_format_hour_cycle,
                   time_format_seconds, time_format_tz_label`,
      );
      expect(rows[0]).toEqual({
        time_format_locale: null,
        time_format_hour_cycle: null,
        time_format_seconds: null,
        time_format_tz_label: null,
      });
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
          "INSERT INTO analyst_invitations (email, customer_ids, invited_by, token_hash, status) VALUES ('a@b.c', '{}', gen_random_uuid(), 'h2', 'invalid')",
        ),
      ).rejects.toThrow();
    });

    it("analyst_invitations.status accepts 'revoked' (#266 parity)", async () => {
      const { rows: aRows } = await pool.query<{ id: string }>(
        "INSERT INTO accounts (oidc_issuer, oidc_subject, username, display_name) VALUES ('iss-ai-rev', 'sub-ai-rev', 'u', 'd') RETURNING id",
      );
      await expect(
        pool.query(
          "INSERT INTO analyst_invitations (email, customer_ids, invited_by, token_hash, status) VALUES ('rev@b.c', '{}', $1, 'h-rev', 'revoked')",
          [aRows[0].id],
        ),
      ).resolves.toBeDefined();
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

  // -- analyst_invitations parity with invitations (#266) --

  describe("analyst_invitations schema parity (#266)", () => {
    async function newAccountId(subject: string): Promise<string> {
      const { rows } = await pool.query<{ id: string }>(
        "INSERT INTO accounts (oidc_issuer, oidc_subject, username, display_name) VALUES ('iss-ai', $1, 'u', 'd') RETURNING id",
        [subject],
      );
      return rows[0].id;
    }

    it("customer_ids is NOT NULL", async () => {
      const invitedBy = await newAccountId("ai-notnull");
      await expect(
        pool.query(
          "INSERT INTO analyst_invitations (email, customer_ids, invited_by, token_hash) VALUES ('nn@b.c', NULL, $1, 'h-nn')",
          [invitedBy],
        ),
      ).rejects.toThrow();
    });

    it("accepts an empty customer_ids array for an unassigned analyst", async () => {
      const invitedBy = await newAccountId("ai-empty");
      await expect(
        pool.query(
          "INSERT INTO analyst_invitations (email, customer_ids, invited_by, token_hash) VALUES ('empty@b.c', '{}', $1, 'h-empty')",
          [invitedBy],
        ),
      ).resolves.toBeDefined();
    });

    it("allows one pending invitation per email (partial unique on lower(email))", async () => {
      const invitedBy = await newAccountId("ai-uniq");
      await pool.query(
        "INSERT INTO analyst_invitations (email, customer_ids, invited_by, token_hash, status) VALUES ('Dup@Test.com', '{}', $1, 'h-uniq-1', 'pending')",
        [invitedBy],
      );
      // Same email (case-insensitive), different token → rejected while pending
      await expect(
        pool.query(
          "INSERT INTO analyst_invitations (email, customer_ids, invited_by, token_hash, status) VALUES ('dup@test.com', '{}', $1, 'h-uniq-2', 'pending')",
          [invitedBy],
        ),
      ).rejects.toThrow();
    });

    it("permits a new pending invitation once the prior one is no longer pending", async () => {
      const invitedBy = await newAccountId("ai-reissue");
      await pool.query(
        "INSERT INTO analyst_invitations (email, customer_ids, invited_by, token_hash, status) VALUES ('reissue@test.com', '{}', $1, 'h-re-1', 'revoked')",
        [invitedBy],
      );
      await expect(
        pool.query(
          "INSERT INTO analyst_invitations (email, customer_ids, invited_by, token_hash, status) VALUES ('reissue@test.com', '{}', $1, 'h-re-2', 'pending')",
          [invitedBy],
        ),
      ).resolves.toBeDefined();
    });

    it("has the pending partial indexes (token_hash, expires_at, lower(email))", async () => {
      const { rows } = await pool.query<{ indexname: string }>(
        `SELECT indexname FROM pg_indexes
         WHERE tablename = 'analyst_invitations'
           AND indexname IN (
             'idx_analyst_invitations_pending_unique',
             'idx_analyst_invitations_token_hash',
             'idx_analyst_invitations_expires'
           )
         ORDER BY indexname`,
      );
      expect(rows.map((r) => r.indexname)).toEqual([
        "idx_analyst_invitations_expires",
        "idx_analyst_invitations_pending_unique",
        "idx_analyst_invitations_token_hash",
      ]);
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

  // -- RFC 0002 Phase 0 (#294) analysis tables --

  describe("RFC 0002 Phase 0 (#294) analysis tables", () => {
    it("customers.timezone column has the expected default and NOT NULL shape", async () => {
      const { rows } = await pool.query<{
        column_default: string | null;
        is_nullable: string;
        data_type: string;
      }>(
        `SELECT column_default, is_nullable, data_type
           FROM information_schema.columns
          WHERE table_schema = 'public'
            AND table_name = 'customers'
            AND column_name = 'timezone'`,
      );
      expect(rows[0]?.data_type).toBe("text");
      expect(rows[0]?.is_nullable).toBe("NO");
      expect(rows[0]?.column_default).toContain("'Asia/Seoul'");
    });

    it("creates all four analysis state/job tables", async () => {
      const { rows } = await pool.query(`
        SELECT table_name FROM information_schema.tables
         WHERE table_schema = 'public'
           AND table_name IN (
             'story_analysis_state',
             'story_analysis_job',
             'periodic_report_state',
             'periodic_report_job'
           )
         ORDER BY table_name`);
      expect(rows.map((r) => r.table_name)).toEqual([
        "periodic_report_job",
        "periodic_report_state",
        "story_analysis_job",
        "story_analysis_state",
      ]);
    });

    it("story_analysis_state has the locked status enum (with archived)", async () => {
      // status must be a CHECK enum including 'archived' per decision 1.
      const { rows } = await pool.query<{ pg_get_constraintdef: string }>(
        `SELECT pg_get_constraintdef(c.oid) FROM pg_constraint c
           JOIN pg_class t ON t.oid = c.conrelid
          WHERE t.relname = 'story_analysis_state'
            AND c.contype = 'c'`,
      );
      const checks = rows.map((r) => r.pg_get_constraintdef).join(" | ");
      for (const status of ["pending", "ready", "dirty", "archived"]) {
        expect(checks).toContain(status);
      }
    });

    it("story_analysis_state has the WS3 denormalized priority columns (nullable)", async () => {
      // #392 — the canonical variant's priority/scores are denormalized
      // here so the Threat Stories list can order priority-first and
      // keyset-paginate in a single auth-DB query. They are nullable:
      // pending rows have no result yet.
      const { rows } = await pool.query<{
        column_name: string;
        is_nullable: string;
      }>(
        `SELECT column_name, is_nullable
           FROM information_schema.columns
          WHERE table_name = 'story_analysis_state'
            AND column_name IN
                ('priority_tier', 'severity_score', 'likelihood_score')
          ORDER BY column_name`,
      );
      expect(rows.map((r) => r.column_name)).toEqual([
        "likelihood_score",
        "priority_tier",
        "severity_score",
      ]);
      for (const r of rows) {
        expect(r.is_nullable).toBe("YES");
      }
    });

    it("periodic_report_state has the locked period + status enums plus event_count default 0", async () => {
      const { rows: cons } = await pool.query<{ pg_get_constraintdef: string }>(
        `SELECT pg_get_constraintdef(c.oid) FROM pg_constraint c
           JOIN pg_class t ON t.oid = c.conrelid
          WHERE t.relname = 'periodic_report_state'
            AND c.contype = 'c'`,
      );
      const checks = cons.map((r) => r.pg_get_constraintdef).join(" | ");
      for (const period of ["LIVE", "DAILY", "WEEKLY", "MONTHLY"]) {
        expect(checks).toContain(period);
      }
      for (const status of ["pending", "ready", "dirty", "archived"]) {
        expect(checks).toContain(status);
      }

      // event_count must default to 0 (the delete-only envelope
      // detection path relies on it).
      const { rows: ev } = await pool.query<{
        column_default: string | null;
        is_nullable: string;
        data_type: string;
      }>(
        `SELECT column_default, is_nullable, data_type
           FROM information_schema.columns
          WHERE table_schema = 'public'
            AND table_name = 'periodic_report_state'
            AND column_name = 'event_count'`,
      );
      expect(ev[0]?.data_type).toBe("bigint");
      expect(ev[0]?.is_nullable).toBe("NO");
      expect(ev[0]?.column_default).toContain("0");

      // last_story_received_at + story_count: round-12 review item 1
      // adds the per-bucket story-side dirty-trigger pair so a story
      // envelope hook failure can be recovered by reconcile without
      // any baseline change to observe.
      const { rows: sr } = await pool.query<{
        is_nullable: string;
        data_type: string;
      }>(
        `SELECT is_nullable, data_type
           FROM information_schema.columns
          WHERE table_schema = 'public'
            AND table_name = 'periodic_report_state'
            AND column_name = 'last_story_received_at'`,
      );
      expect(sr[0]?.data_type).toBe("timestamp with time zone");
      expect(sr[0]?.is_nullable).toBe("YES");
      const { rows: sc } = await pool.query<{
        column_default: string | null;
        is_nullable: string;
        data_type: string;
      }>(
        `SELECT column_default, is_nullable, data_type
           FROM information_schema.columns
          WHERE table_schema = 'public'
            AND table_name = 'periodic_report_state'
            AND column_name = 'story_count'`,
      );
      expect(sc[0]?.data_type).toBe("bigint");
      expect(sc[0]?.is_nullable).toBe("NO");
      expect(sc[0]?.column_default).toContain("0");
    });

    it("story_analysis_job + periodic_report_job have dry_run BOOLEAN NOT NULL DEFAULT FALSE (decision 3)", async () => {
      // Phase 1 (#296) / Phase 2 (#297) deletes leftover dry_run=TRUE
      // rows in their own migrations before enabling real LLM calls.
      // Default must be FALSE so a Phase 1 INSERT that omits the
      // column does not accidentally inherit the Phase 0 marker.
      for (const table of ["story_analysis_job", "periodic_report_job"]) {
        const { rows } = await pool.query<{
          column_default: string | null;
          is_nullable: string;
          data_type: string;
        }>(
          `SELECT column_default, is_nullable, data_type
             FROM information_schema.columns
            WHERE table_schema = 'public'
              AND table_name = $1
              AND column_name = 'dry_run'`,
          [table],
        );
        expect(rows[0]?.data_type).toBe("boolean");
        expect(rows[0]?.is_nullable).toBe("NO");
        expect(rows[0]?.column_default).toBe("false");
      }
    });

    it("story_analysis_job has translation audit + next_due_at columns (#580)", async () => {
      // Parity with periodic_report_job: the translate-path audit trail
      // (translation_model_name / translation_model /
      // translation_prompt_version) plus the per-variant cadence /
      // canonical-not-ready backoff field (next_due_at). All nullable —
      // NULL for the native English job.
      const { rows } = await pool.query<{
        column_name: string;
        data_type: string;
        is_nullable: string;
      }>(
        `SELECT column_name, data_type, is_nullable
           FROM information_schema.columns
          WHERE table_schema = 'public'
            AND table_name = 'story_analysis_job'
            AND column_name IN (
              'translation_model_name', 'translation_model',
              'translation_prompt_version', 'next_due_at'
            )`,
      );
      const byName = new Map(rows.map((c) => [c.column_name, c]));
      for (const col of [
        "translation_model_name",
        "translation_model",
        "translation_prompt_version",
      ]) {
        expect(byName.get(col)?.data_type).toBe("text");
        expect(byName.get(col)?.is_nullable).toBe("YES");
      }
      expect(byName.get("next_due_at")?.data_type).toBe(
        "timestamp with time zone",
      );
      expect(byName.get("next_due_at")?.is_nullable).toBe("YES");
    });

    it("event_analysis_job has the budget-accounting DDL contract (#493)", async () => {
      // The auto-baseline path's job lifecycle table. Lock in the
      // columns the per-customer daily cap depends on for correctness.
      const { rows: checks } = await pool.query<{
        pg_get_constraintdef: string;
      }>(
        `SELECT pg_get_constraintdef(c.oid) FROM pg_constraint c
           JOIN pg_class t ON t.oid = c.conrelid
          WHERE t.relname = 'event_analysis_job'
            AND c.contype = 'c'`,
      );
      const checkText = checks.map((r) => r.pg_get_constraintdef).join(" | ");
      // status enum includes the terminal tier-B overflow marker.
      for (const status of [
        "queued",
        "processing",
        "done",
        "failed",
        "budget_skipped",
      ]) {
        expect(checkText).toContain(status);
      }
      // selection_tier enum.
      for (const tier of ["tier_a", "tier_b"]) {
        expect(checkText).toContain(tier);
      }

      const { rows: cols } = await pool.query<{
        column_name: string;
        is_nullable: string;
        data_type: string;
      }>(
        `SELECT column_name, is_nullable, data_type
           FROM information_schema.columns
          WHERE table_schema = 'public'
            AND table_name = 'event_analysis_job'
            AND column_name IN ('selection_tier', 'budget_day', 'status')
          ORDER BY column_name`,
      );
      const byName = new Map(cols.map((c) => [c.column_name, c]));
      // selection_tier is NULLABLE — NULL = held (awaiting classification),
      // which a held row must be so it never inflates the tier-B count.
      expect(byName.get("selection_tier")?.is_nullable).toBe("YES");
      // budget_day is a NOT NULL date — the customer-tz day the row reserves.
      expect(byName.get("budget_day")?.is_nullable).toBe("NO");
      expect(byName.get("budget_day")?.data_type).toBe("date");
      expect(byName.get("status")?.is_nullable).toBe("NO");

      // The reservation COUNT(*) is backed by a partial index on exactly the
      // tier-B, non-budget_skipped predicate the seed-time reservation reads.
      const { rows: idx } = await pool.query<{ indexdef: string }>(
        `SELECT indexdef FROM pg_indexes
          WHERE tablename = 'event_analysis_job'
            AND indexname = 'event_analysis_job_budget_idx'`,
      );
      expect(idx[0]?.indexdef).toContain("tier_b");
      expect(idx[0]?.indexdef).toContain("budget_skipped");

      // Unlike `story_analysis_job` (which cascades through its state
      // parent), this table has no per-event state table to cascade
      // through, so `customer_id` references `customers(id)` DIRECTLY with
      // ON DELETE CASCADE. Without it, a deleted customer leaves orphaned
      // job rows the worker keeps picking and failing on.
      const { rows: cRows } = await pool.query(
        "INSERT INTO customers (external_key, name) VALUES ('event-job-cascade', 'CC') RETURNING id",
      );
      const cid = cRows[0].id;
      await pool.query(
        `INSERT INTO event_analysis_job
           (customer_id, aice_id, event_key, lang, model_name, model,
            status, budget_day, baseline_version, event_time, received_at)
         VALUES ($1, 'aice-1', 1, 'ENGLISH', 'openai', 'gpt-4o',
                 'queued', DATE '1970-01-01', 'bv-1', NOW(), NOW())`,
        [cid],
      );
      await pool.query("DELETE FROM customers WHERE id = $1", [cid]);
      const { rows: left } = await pool.query<{ c: number }>(
        `SELECT COUNT(*)::int AS c FROM event_analysis_job
          WHERE customer_id = $1`,
        [cid],
      );
      expect(left[0].c).toBe(0);
    });

    it("customer_baseline_analysis_cap mirrors customer_default_model with a non-negative cap (#493)", async () => {
      const { rows } = await pool.query<{
        column_name: string;
        is_nullable: string;
      }>(
        `SELECT column_name, is_nullable
           FROM information_schema.columns
          WHERE table_schema = 'public'
            AND table_name = 'customer_baseline_analysis_cap'
          ORDER BY column_name`,
      );
      expect(rows.map((r) => r.column_name)).toEqual([
        "customer_id",
        "daily_cap",
        "updated_at",
        "updated_by",
      ]);

      const { rows: cRows } = await pool.query(
        "INSERT INTO customers (external_key, name) VALUES ('baseline-cap-ddl', 'CC') RETURNING id",
      );
      const cid = cRows[0].id;
      // daily_cap CHECK rejects a negative cap.
      await expect(
        pool.query(
          `INSERT INTO customer_baseline_analysis_cap
             (customer_id, daily_cap, updated_by) VALUES ($1, -1, $1)`,
          [cid],
        ),
      ).rejects.toThrow();
      // A cap of 0 (tier B disabled) is a valid, distinct value.
      await pool.query(
        `INSERT INTO customer_baseline_analysis_cap
           (customer_id, daily_cap, updated_by) VALUES ($1, 0, $1)`,
        [cid],
      );
      // The row CASCADEs with its customer.
      await pool.query("DELETE FROM customers WHERE id = $1", [cid]);
      const { rows: left } = await pool.query<{ c: number }>(
        `SELECT COUNT(*)::int AS c FROM customer_baseline_analysis_cap
          WHERE customer_id = $1`,
        [cid],
      );
      expect(left[0].c).toBe(0);
    });

    it("analysis tables CASCADE from the subject and the job tables CASCADE from their state tables", async () => {
      // FK shape verification — deleting the identity root (the
      // `subjects` row) must cascade through story state (via
      // `customers`, still customer_id-keyed) AND through the
      // subject-keyed periodic state, and through state → job.
      // Otherwise a deleted subject would leave orphaned analysis rows.
      // (RFC 0004 / #503: periodic_report_* re-keyed onto subject_id, so
      // they cascade from `subjects`; `delete-customer.ts` deletes the
      // subject row for exactly this reason.)
      const { rows: cRows } = await pool.query(
        "INSERT INTO customers (external_key, name) VALUES ('rfc0002-cascade', 'CC') RETURNING id",
      );
      const cid = cRows[0].id;

      await pool.query(
        `INSERT INTO story_analysis_state (customer_id, story_id, status)
         VALUES ($1, 5001, 'pending')`,
        [cid],
      );
      await pool.query(
        `INSERT INTO story_analysis_job
           (customer_id, story_id, lang, model_name, model, status)
         VALUES ($1, 5001, 'ENGLISH', 'openai', 'gpt-4o', 'queued')`,
        [cid],
      );
      await pool.query(
        `INSERT INTO periodic_report_state
           (subject_id, period, bucket_date, tz, status)
         VALUES ($1, 'LIVE', DATE '1970-01-01', 'Asia/Seoul', 'pending')`,
        [cid],
      );
      await pool.query(
        `INSERT INTO periodic_report_job
           (subject_id, period, bucket_date, tz,
            lang, model_name, model, status)
         VALUES ($1, 'LIVE', DATE '1970-01-01', 'Asia/Seoul',
                 'ENGLISH', 'openai', 'gpt-4o', 'queued')`,
        [cid],
      );

      // Sanity: job FK to state — deleting the state row removes the
      // job row even when the customer remains.
      await pool.query(
        `DELETE FROM story_analysis_state
          WHERE customer_id = $1 AND story_id = 5001`,
        [cid],
      );
      const { rows: jOrphan } = await pool.query<{ c: number }>(
        `SELECT COUNT(*)::int AS c FROM story_analysis_job
          WHERE customer_id = $1 AND story_id = 5001`,
        [cid],
      );
      expect(jOrphan[0].c).toBe(0);

      // Re-seed and then delete the subject; everything cascades
      // (subject → customers → story_analysis_*, and subject →
      // periodic_report_*).
      await pool.query(
        `INSERT INTO story_analysis_state (customer_id, story_id, status)
         VALUES ($1, 5002, 'pending')`,
        [cid],
      );
      await pool.query(
        `INSERT INTO story_analysis_job
           (customer_id, story_id, lang, model_name, model, status)
         VALUES ($1, 5002, 'ENGLISH', 'openai', 'gpt-4o', 'queued')`,
        [cid],
      );

      await pool.query("DELETE FROM subjects WHERE id = $1", [cid]);

      const { rows: leftover } = await pool.query<{ c: number }>(
        `SELECT
           (SELECT COUNT(*)::int FROM story_analysis_state WHERE customer_id = $1)
         + (SELECT COUNT(*)::int FROM story_analysis_job   WHERE customer_id = $1)
         + (SELECT COUNT(*)::int FROM periodic_report_state WHERE subject_id = $1)
         + (SELECT COUNT(*)::int FROM periodic_report_job   WHERE subject_id = $1)
         AS c`,
        [cid],
      );
      expect(leftover[0].c).toBe(0);
    });

    it("customer insert materializes a kind='customer' subject and rejects a non-customer subject (insert or update)", async () => {
      // RFC 0004 / #503: the `customers_ensure_subject` trigger backs
      // every customer with a `kind='customer'` subject sharing its UUID.
      // A plain insert must auto-create that subject row.
      const { rows: cRows } = await pool.query(
        "INSERT INTO customers (external_key, name) VALUES ('subj-trg', 'SC') RETURNING id",
      );
      const cid = cRows[0].id;
      const { rows: sRows } = await pool.query<{ kind: string }>(
        "SELECT kind FROM subjects WHERE id = $1",
        [cid],
      );
      expect(sRows).toHaveLength(1);
      expect(sRows[0].kind).toBe("customer");

      // The invariant must hold even when the subject id already exists
      // as a different kind: inserting a customer onto a pre-existing
      // `kind='group'` subject must be rejected, not silently accepted.
      const { rows: gRows } = await pool.query<{ id: string }>(
        "INSERT INTO subjects (kind) VALUES ('group') RETURNING id",
      );
      const gid = gRows[0].id;
      await expect(
        pool.query(
          "INSERT INTO customers (id, external_key, name) VALUES ($1, 'subj-grp', 'GC')",
          [gid],
        ),
      ).rejects.toThrow(/non-customer subject/);

      // The invariant must also hold after creation: a subject backing a
      // customer cannot later be flipped to a non-customer kind, which
      // would orphan the existing customer onto a `kind='group'` subject.
      await expect(
        pool.query("UPDATE subjects SET kind = 'group' WHERE id = $1", [cid]),
      ).rejects.toThrow(/cannot change kind/);
      const { rows: stillCustomer } = await pool.query<{ kind: string }>(
        "SELECT kind FROM subjects WHERE id = $1",
        [cid],
      );
      expect(stillCustomer[0].kind).toBe("customer");
    });

    it("customer-timezone-change trigger archives mismatched periodic_report_state rows", async () => {
      // The tz-change archive trigger is part of the schema gate too —
      // verify it fires on a tz update.
      const { rows: cRows } = await pool.query(
        "INSERT INTO customers (external_key, name, timezone) VALUES ('rfc0002-trg', 'TZ', 'Asia/Seoul') RETURNING id",
      );
      const cid = cRows[0].id;
      await pool.query(
        `INSERT INTO periodic_report_state
           (subject_id, period, bucket_date, tz, status)
         VALUES ($1, 'LIVE', DATE '1970-01-01', 'Asia/Seoul', 'ready')`,
        [cid],
      );

      await pool.query("UPDATE customers SET timezone = 'UTC' WHERE id = $1", [
        cid,
      ]);

      const { rows } = await pool.query<{ status: string }>(
        `SELECT status FROM periodic_report_state
          WHERE subject_id = $1 AND tz = 'Asia/Seoul'`,
        [cid],
      );
      expect(rows[0]?.status).toBe("archived");

      await pool.query("DELETE FROM customers WHERE id = $1", [cid]);
    });

    // -----------------------------------------------------------------
    // Customer groups (#506)
    // -----------------------------------------------------------------

    async function mkGroupAccount(): Promise<string> {
      const sub = `grp-acct-${Math.random().toString(36).slice(2)}`;
      const { rows } = await pool.query<{ id: string }>(
        `INSERT INTO accounts (oidc_issuer, oidc_subject, username, display_name)
         VALUES ('test-issuer', $1, $1, $1) RETURNING id`,
        [sub],
      );
      return rows[0].id;
    }

    async function mkActiveCustomer(key: string): Promise<string> {
      const { rows } = await pool.query<{ id: string }>(
        `INSERT INTO customers (external_key, name, status, database_status)
         VALUES ($1, $1, 'active', 'active') RETURNING id`,
        [key],
      );
      return rows[0].id;
    }

    it("subjects has a UNIQUE (id, kind) constraint (composite-FK target)", async () => {
      const { rows } = await pool.query<{ conname: string }>(
        `SELECT con.conname
           FROM pg_constraint con
           JOIN pg_class rel ON rel.oid = con.conrelid
          WHERE rel.relname = 'subjects'
            AND con.contype = 'u'
            AND con.conname = 'subjects_id_kind_key'`,
      );
      expect(rows).toHaveLength(1);
    });

    it("customer_groups composite FK rejects attaching to a non-group subject", async () => {
      const acct = await mkGroupAccount();
      // A customer-kind subject (via a customer insert).
      const cid = await mkActiveCustomer(`cg-fk-${Date.now()}`);
      // Attaching a group subtype row onto that customer subject must fail:
      // subjects(cid) is kind='customer', so (cid, 'group') is not present.
      await expect(
        pool.query(
          `INSERT INTO customer_groups (id, name, created_by, owner_id, tz)
           VALUES ($1, 'G', $2, $2, 'UTC')`,
          [cid, acct],
        ),
      ).rejects.toThrow();
    });

    it("customer_group_members is immutable to UPDATE but allows DELETE", async () => {
      const acct = await mkGroupAccount();
      const c1 = await mkActiveCustomer(`cgm-a-${Date.now()}`);
      const c2 = await mkActiveCustomer(`cgm-b-${Date.now()}`);
      const { rows: g } = await pool.query<{ id: string }>(
        `INSERT INTO subjects (kind) VALUES ('group') RETURNING id`,
      );
      const gid = g[0].id;
      await pool.query(
        `INSERT INTO customer_groups (id, name, created_by, owner_id, tz)
         VALUES ($1, 'G', $2, $2, 'UTC')`,
        [gid, acct],
      );
      await pool.query(
        `INSERT INTO customer_group_members (group_id, customer_id)
         VALUES ($1, $2), ($1, $3)`,
        [gid, c1, c2],
      );

      // UPDATE is blocked by the immutability trigger.
      await expect(
        pool.query(
          `UPDATE customer_group_members SET customer_id = $3
            WHERE group_id = $1 AND customer_id = $2`,
          [gid, c1, c2],
        ),
      ).rejects.toThrow(/immutable/);

      // DELETE remains allowed (the cascade depends on it).
      const del = await pool.query(
        `DELETE FROM customer_group_members WHERE group_id = $1 AND customer_id = $2`,
        [gid, c1],
      );
      expect(del.rowCount).toBe(1);

      await pool.query("DELETE FROM subjects WHERE id = $1", [gid]);
    });

    it("customer_groups.created_by is immutable but owner_id is mutable", async () => {
      const acct = await mkGroupAccount();
      const acct2 = await mkGroupAccount();
      const { rows: g } = await pool.query<{ id: string }>(
        `INSERT INTO subjects (kind) VALUES ('group') RETURNING id`,
      );
      const gid = g[0].id;
      await pool.query(
        `INSERT INTO customer_groups (id, name, created_by, owner_id, tz)
         VALUES ($1, 'G', $2, $2, 'UTC')`,
        [gid, acct],
      );

      // created_by cannot change.
      await expect(
        pool.query(`UPDATE customer_groups SET created_by = $2 WHERE id = $1`, [
          gid,
          acct2,
        ]),
      ).rejects.toThrow(/immutable/);

      // owner_id is updatable (transfer lands in #510).
      await pool.query(
        `UPDATE customer_groups SET owner_id = $2 WHERE id = $1`,
        [gid, acct2],
      );
      const { rows } = await pool.query<{ owner_id: string }>(
        `SELECT owner_id FROM customer_groups WHERE id = $1`,
        [gid],
      );
      expect(rows[0].owner_id).toBe(acct2);

      await pool.query("DELETE FROM subjects WHERE id = $1", [gid]);
    });

    it("deleting the group subject cascades group, members, and retention policy", async () => {
      const acct = await mkGroupAccount();
      const c1 = await mkActiveCustomer(`cgc-a-${Date.now()}`);
      const c2 = await mkActiveCustomer(`cgc-b-${Date.now()}`);
      const { rows: g } = await pool.query<{ id: string }>(
        `INSERT INTO subjects (kind) VALUES ('group') RETURNING id`,
      );
      const gid = g[0].id;
      await pool.query(
        `INSERT INTO customer_groups (id, name, created_by, owner_id, tz)
         VALUES ($1, 'G', $2, $2, 'UTC')`,
        [gid, acct],
      );
      await pool.query(
        `INSERT INTO customer_group_members (group_id, customer_id)
         VALUES ($1, $2), ($1, $3)`,
        [gid, c1, c2],
      );
      await pool.query(
        `INSERT INTO group_retention_policy (subject_id, analysis_days, updated_by)
         VALUES ($1, 1095, $2)`,
        [gid, acct],
      );

      await pool.query("DELETE FROM subjects WHERE id = $1", [gid]);

      const { rows: leftover } = await pool.query<{ c: number }>(
        `SELECT
           (SELECT COUNT(*)::int FROM customer_groups WHERE id = $1)
         + (SELECT COUNT(*)::int FROM customer_group_members WHERE group_id = $1)
         + (SELECT COUNT(*)::int FROM group_retention_policy WHERE subject_id = $1)
         AS c`,
        [gid],
      );
      expect(leftover[0].c).toBe(0);
    });

    it("has pending-friendly partial indexes on the analysis state tables (round-15 review item 1)", async () => {
      // The `WHERE status = 'pending'` partial indexes back the
      // worker's per-tick readiness scans. Without these the pending
      // scans have no usable index and would devolve into full table
      // scans as state volume grew.
      const { rows } = await pool.query<{
        indexname: string;
        indexdef: string;
      }>(
        `SELECT indexname, indexdef FROM pg_indexes
          WHERE schemaname = 'public'
            AND indexname IN (
              'story_analysis_state_pending_idx',
              'periodic_report_state_pending_idx'
            )
          ORDER BY indexname`,
      );
      expect(rows.map((r) => r.indexname)).toEqual([
        "periodic_report_state_pending_idx",
        "story_analysis_state_pending_idx",
      ]);
      // Both indexes must be partial on status='pending' so the worker
      // scans only pending rows even when ready/dirty/archived dominate.
      for (const row of rows) {
        expect(row.indexdef).toContain("WHERE (status = 'pending'");
      }
      const periodic = rows.find(
        (r) => r.indexname === "periodic_report_state_pending_idx",
      );
      expect(periodic?.indexdef).toContain(
        "(subject_id, period, bucket_date, tz)",
      );
      const story = rows.find(
        (r) => r.indexname === "story_analysis_state_pending_idx",
      );
      expect(story?.indexdef).toContain("(customer_id, story_id)");
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
      // The migration's own GRANT statements already ran on this test
      // DB as superuser and are effective because the tables were
      // created by the superuser.

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
      // Verify SELECT on every CRUD-granted application table plus the
      // RFC 0002 (#294) analysis state/job tables.
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
        // RFC 0002 Phase 0 (#294) — issue gate: runtime role must be
        // able to SELECT/INSERT/UPDATE/DELETE the new analysis tables.
        "story_analysis_state",
        "story_analysis_job",
        "periodic_report_state",
        "periodic_report_job",
        // Per-customer default analysis model (#473).
        "customer_default_model",
        // Per-subject TI source selection (RFC 0003 F2, #598).
        "subject_ti_sources",
      ];
      for (const table of crudTables) {
        const { rows } = await rolePool.query(`SELECT COUNT(*) FROM ${table}`);
        expect(Number(rows[0].count)).toBeGreaterThanOrEqual(0);
      }
    });

    it("can INSERT into the analysis state/job tables (#294 grants)", async () => {
      // Round-10 review item 3: explicit INSERT exercise per table so
      // a missing GRANT regression on any of the four new analysis
      // tables fails the schema gate rather than only showing up in
      // worker integration tests.
      const { rows: cRows } = await rolePool.query(
        "INSERT INTO customers (external_key, name) VALUES ('rfc0002-grant', 'GC') RETURNING id",
      );
      const cid = cRows[0].id;

      await rolePool.query(
        `INSERT INTO story_analysis_state
           (customer_id, story_id, status)
         VALUES ($1, 1, 'pending')`,
        [cid],
      );
      await rolePool.query(
        `INSERT INTO story_analysis_job
           (customer_id, story_id, lang, model_name, model, status)
         VALUES ($1, 1, 'ENGLISH', 'openai', 'gpt-4o', 'queued')`,
        [cid],
      );
      await rolePool.query(
        `INSERT INTO periodic_report_state
           (subject_id, period, bucket_date, tz, status)
         VALUES ($1, 'LIVE', DATE '1970-01-01', 'Asia/Seoul', 'pending')`,
        [cid],
      );
      await rolePool.query(
        `INSERT INTO periodic_report_job
           (subject_id, period, bucket_date, tz,
            lang, model_name, model, status)
         VALUES ($1, 'LIVE', DATE '1970-01-01', 'Asia/Seoul',
                 'ENGLISH', 'openai', 'gpt-4o', 'queued')`,
        [cid],
      );

      await rolePool.query("DELETE FROM customers WHERE id = $1", [cid]);
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
    // The collapsed first-version schema (#535): one 0000_init.sql.
    expect(rows).toHaveLength(1);
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
      // The migration grants to aimer_audit_owner and aimer_audit.
      // Since we ran migrations as superuser, re-grant explicitly.
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

describe.skipIf(!hasPostgres)("Schema verification (feed_db)", () => {
  let dbName: string;
  let pool: Pool;

  beforeAll(async () => {
    const db = await createTestDatabase("schema_feed", "feed");
    dbName = db.dbName;
    pool = db.pool;

    // Apply all feed migrations
    await runMigrations(pool, join(MIGRATIONS_ROOT, "feed"), LOCK_ID_FEED);
  });

  afterAll(async () => {
    await dropTestDatabase(dbName, pool, "feed");
    await closeAdminPool();
  });

  it("applies all feed migrations cleanly", async () => {
    const { rows } = await pool.query(
      "SELECT version FROM _migrations ORDER BY version",
    );
    // The collapsed first-version schema (#564): one 0000_init.sql.
    expect(rows).toHaveLength(1);
  });

  it("ioc_feed_snapshot requires exactly one of match_value / cidr", async () => {
    // The CHECK ((match_value IS NULL) <> (cidr IS NULL)) rejects rows that
    // set neither or both.
    await expect(
      pool.query(
        "INSERT INTO ioc_feed_snapshot (source_policy_id, entity_type, hit_type) VALUES ('s', 'IP', 'deterministic_ioc')",
      ),
    ).rejects.toThrow();
    await expect(
      pool.query(
        "INSERT INTO ioc_feed_snapshot (source_policy_id, entity_type, hit_type, match_value, cidr) VALUES ('s', 'IP', 'deterministic_ioc', '1.2.3.4', '1.2.3.0/24')",
      ),
    ).rejects.toThrow();
  });

  describe("feed runtime role (aimer_feed) permissions", () => {
    let rolePool: Pool;

    beforeAll(async () => {
      await pool.query(`GRANT CONNECT ON DATABASE ${dbName} TO aimer_feed`);
      await pool.query("GRANT USAGE ON SCHEMA public TO aimer_feed");
      // The migration grants to aimer_feed_owner and aimer_feed. Since we ran
      // migrations as superuser, re-grant explicitly.
      await pool.query(
        "GRANT SELECT, INSERT, DELETE ON ioc_feed_snapshot TO aimer_feed",
      );
      // Self-fetch (#568): fetch-state + secret tables get SELECT/INSERT/UPDATE
      // (runtime upserts via ON CONFLICT DO UPDATE).
      await pool.query(
        "GRANT SELECT, INSERT, UPDATE ON feed_fetch_state TO aimer_feed",
      );
      await pool.query(
        "GRANT SELECT, INSERT, UPDATE ON feed_source_secret TO aimer_feed",
      );

      rolePool = createRolePool(dbName, "aimer_feed", "changeme", "feed");
    });

    afterAll(async () => {
      rolePool.on("error", () => {});
      await rolePool.end();
    });

    it("can INSERT, SELECT, and DELETE on ioc_feed_snapshot", async () => {
      // The import/refresh path replaces a source's rows (DELETE + INSERT).
      await rolePool.query(
        "INSERT INTO ioc_feed_snapshot (source_policy_id, entity_type, hit_type, match_value) VALUES ('s', 'IP', 'deterministic_ioc', '1.2.3.4')",
      );
      const { rows } = await rolePool.query(
        "SELECT COUNT(*) FROM ioc_feed_snapshot",
      );
      expect(Number(rows[0].count)).toBeGreaterThan(0);
      await rolePool.query("DELETE FROM ioc_feed_snapshot");
    });

    it("cannot UPDATE on ioc_feed_snapshot", async () => {
      // Snapshots are immutable between wholesale replacements — no UPDATE.
      await expect(
        rolePool.query(
          "UPDATE ioc_feed_snapshot SET classification = 'x' WHERE id = 1",
        ),
      ).rejects.toThrow();
    });

    it("can SELECT, INSERT, and UPDATE feed_fetch_state (#568)", async () => {
      // The fetch engine upserts fetch bookkeeping (ON CONFLICT DO UPDATE).
      await rolePool.query(
        "INSERT INTO feed_fetch_state (source_policy_id, last_status) VALUES ('s', 'ok')",
      );
      await rolePool.query(
        "UPDATE feed_fetch_state SET last_status = 'not-modified' WHERE source_policy_id = 's'",
      );
      const { rows } = await rolePool.query(
        "SELECT last_status FROM feed_fetch_state WHERE source_policy_id = 's'",
      );
      expect(rows[0].last_status).toBe("not-modified");
    });

    it("can SELECT, INSERT, and UPDATE feed_source_secret (#568)", async () => {
      // The auth-key route upserts the Transit-wrapped secret.
      await rolePool.query(
        "INSERT INTO feed_source_secret (key_name, wrapped_dek, ciphertext) VALUES ('urlhaus', 'w1', '\\x00')",
      );
      await rolePool.query(
        "UPDATE feed_source_secret SET wrapped_dek = 'w2' WHERE key_name = 'urlhaus'",
      );
      const { rows } = await rolePool.query(
        "SELECT wrapped_dek FROM feed_source_secret WHERE key_name = 'urlhaus'",
      );
      expect(rows[0].wrapped_dek).toBe("w2");
    });
  });
});
