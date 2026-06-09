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
import {
  assertAllMemberManagement,
  hasAllMemberManagement,
  hasAllMemberReadPermission,
} from "../group-authorization";

const MIGRATIONS_DIR = join(process.cwd(), "migrations", "auth");
const LOCK_ID = 1506;

describe.skipIf(!hasPostgres)("group all-member predicates (DB)", () => {
  let pool: Pool;
  let dbName: string;

  let userRoleId: number;
  let managerRoleId: number;

  // Accounts
  let managerAcct: string;
  let analystAcct: string;
  let userAcct: string;
  let mixedAcct: string; // Manager on c1, User on c2
  let ineligibleAnalystAcct: string; // assigned but analyst_eligible=false
  let adminAcct: string;

  // Customers (members)
  let c1: string;
  let c2: string;

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
    const result = await createTestDatabase("group_authz", "auth");
    pool = result.pool;
    dbName = result.dbName;

    // `aimer_auth` is a cluster-global role; tolerate a concurrent test
    // file having created it (race between the IF NOT EXISTS and CREATE).
    await pool.query(`
      DO $$ BEGIN
        IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'aimer_auth') THEN
          CREATE ROLE aimer_auth LOGIN PASSWORD 'changeme';
        END IF;
      EXCEPTION WHEN duplicate_object OR unique_violation THEN
        NULL;
      END $$
    `);

    await runMigrations(pool, MIGRATIONS_DIR, LOCK_ID);

    const roles = await pool.query<{ id: number; name: string }>(
      `SELECT id, name FROM roles WHERE name IN ('User', 'Manager')`,
    );
    for (const r of roles.rows) {
      if (r.name === "User") userRoleId = r.id;
      if (r.name === "Manager") managerRoleId = r.id;
    }

    const mkCustomer = async (key: string) => {
      const { rows } = await pool.query<{ id: string }>(
        `INSERT INTO customers (external_key, name, status, database_status)
         VALUES ($1, $1, 'active', 'active') RETURNING id`,
        [key],
      );
      return rows[0].id;
    };
    c1 = await mkCustomer("ga-c1");
    c2 = await mkCustomer("ga-c2");

    const mkAccount = async (sub: string, analystEligible = false) => {
      const { rows } = await pool.query<{ id: string }>(
        `INSERT INTO accounts (oidc_issuer, oidc_subject, username, display_name, analyst_eligible)
         VALUES ('test-issuer', $1, $1, $1, $2) RETURNING id`,
        [sub, analystEligible],
      );
      return rows[0].id;
    };
    managerAcct = await mkAccount("ga-mgr");
    analystAcct = await mkAccount("ga-analyst", true);
    userAcct = await mkAccount("ga-user");
    mixedAcct = await mkAccount("ga-mixed");
    ineligibleAnalystAcct = await mkAccount("ga-ineligible", false);
    adminAcct = await mkAccount("ga-admin");

    const addMembership = (acct: string, customer: string, roleId: number) =>
      pool.query(
        `INSERT INTO account_customer_memberships (account_id, customer_id, role_id)
         VALUES ($1, $2, $3)`,
        [acct, customer, roleId],
      );

    // Manager on both members.
    await addMembership(managerAcct, c1, managerRoleId);
    await addMembership(managerAcct, c2, managerRoleId);
    // User on both members.
    await addMembership(userAcct, c1, userRoleId);
    await addMembership(userAcct, c2, userRoleId);
    // Mixed: Manager on c1, User on c2.
    await addMembership(mixedAcct, c1, managerRoleId);
    await addMembership(mixedAcct, c2, userRoleId);

    const addAssignment = (acct: string, customer: string) =>
      pool.query(
        `INSERT INTO analyst_customer_assignments (account_id, customer_id, assigned_by)
         VALUES ($1, $2, $3)`,
        [acct, customer, adminAcct],
      );
    // Eligible analyst assigned to both members.
    await addAssignment(analystAcct, c1);
    await addAssignment(analystAcct, c2);
    // Ineligible account with assignments on both members (must NOT qualify).
    await addAssignment(ineligibleAnalystAcct, c1);
    await addAssignment(ineligibleAnalystAcct, c2);
  });

  afterAll(async () => {
    await dropTestDatabase(dbName, pool, "auth");
    await closeAdminPool();
  });

  describe("hasAllMemberManagement", () => {
    it("grants a Manager on every member", async () => {
      const ok = await withClient((c) =>
        hasAllMemberManagement(c, managerAcct, [c1, c2]),
      );
      expect(ok).toBe(true);
    });

    it("grants an eligible Analyst on every member", async () => {
      const ok = await withClient((c) =>
        hasAllMemberManagement(c, analystAcct, [c1, c2]),
      );
      expect(ok).toBe(true);
    });

    it("denies a plain User", async () => {
      const ok = await withClient((c) =>
        hasAllMemberManagement(c, userAcct, [c1, c2]),
      );
      expect(ok).toBe(false);
    });

    it("denies when management holds on only some members (Manager c1, User c2)", async () => {
      const ok = await withClient((c) =>
        hasAllMemberManagement(c, mixedAcct, [c1, c2]),
      );
      expect(ok).toBe(false);
    });

    it("denies a stale analyst assignment on an ineligible account", async () => {
      const ok = await withClient((c) =>
        hasAllMemberManagement(c, ineligibleAnalystAcct, [c1, c2]),
      );
      expect(ok).toBe(false);
    });

    it("denies an empty member list (no vacuous grant)", async () => {
      const ok = await withClient((c) =>
        hasAllMemberManagement(c, managerAcct, []),
      );
      expect(ok).toBe(false);
    });

    it("denies when a member id does not exist", async () => {
      const missing = "00000000-0000-0000-0000-000000000000";
      const ok = await withClient((c) =>
        hasAllMemberManagement(c, managerAcct, [c1, missing]),
      );
      expect(ok).toBe(false);
    });
  });

  describe("assertAllMemberManagement", () => {
    it("throws HttpError 403 when the predicate fails", async () => {
      await expect(
        withClient((c) => assertAllMemberManagement(c, userAcct, [c1, c2])),
      ).rejects.toBeInstanceOf(HttpError);
      try {
        await withClient((c) =>
          assertAllMemberManagement(c, userAcct, [c1, c2]),
        );
      } catch (err) {
        expect((err as HttpError).statusCode).toBe(403);
      }
    });

    it("resolves when the predicate holds", async () => {
      await expect(
        withClient((c) => assertAllMemberManagement(c, managerAcct, [c1, c2])),
      ).resolves.toBeUndefined();
    });
  });

  describe("hasAllMemberReadPermission", () => {
    it("grants reports:read to a User on every member (read != manage)", async () => {
      const ok = await withClient((c) =>
        hasAllMemberReadPermission(c, userAcct, [c1, c2], "reports:read"),
      );
      expect(ok).toBe(true);
    });

    it("grants reports:read via an eligible analyst assignment", async () => {
      const ok = await withClient((c) =>
        hasAllMemberReadPermission(c, analystAcct, [c1, c2], "reports:read"),
      );
      expect(ok).toBe(true);
    });

    it("denies reports:read when the account has no access to a member", async () => {
      const stranger = await pool.query<{ id: string }>(
        `INSERT INTO accounts (oidc_issuer, oidc_subject, username, display_name)
         VALUES ('test-issuer', 'ga-stranger', 'ga-stranger', 'ga-stranger') RETURNING id`,
      );
      const ok = await withClient((c) =>
        hasAllMemberReadPermission(
          c,
          stranger.rows[0].id,
          [c1, c2],
          "reports:read",
        ),
      );
      expect(ok).toBe(false);
    });

    it("denies reports:read via a stale assignment on an ineligible account", async () => {
      const ok = await withClient((c) =>
        hasAllMemberReadPermission(
          c,
          ineligibleAnalystAcct,
          [c1, c2],
          "reports:read",
        ),
      );
      expect(ok).toBe(false);
    });
  });
});
