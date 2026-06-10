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
import { listGroupEligibleMembers } from "../../groups/eligible-members";
import { HttpError } from "../errors";
import {
  assertAllMemberManagement,
  hasAllMemberManagement,
  hasAllMemberReadPermission,
  listAccessibleGroups,
  listManageableGroups,
  resolveGroupReadOutcome,
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

  describe("resolveGroupReadOutcome (#525 existence-hiding)", () => {
    it("authorizes when the account holds the permission on every member", async () => {
      const outcome = await withClient((c) =>
        resolveGroupReadOutcome(c, userAcct, [c1, c2], "reports:read"),
      );
      expect(outcome).toBe("authorized");
    });

    it("forbids a member that lacks the permission on one member (403, not 404)", async () => {
      // `mixedAcct` is a Manager on c1 (has customer-settings:write) and a
      // plain User on c2 (does not) — a MEMBER of both, missing the permission
      // on one: the member-without-permission → 403 case, distinct from a
      // non-member.
      const outcome = await withClient((c) =>
        resolveGroupReadOutcome(
          c,
          mixedAcct,
          [c1, c2],
          "customer-settings:write",
        ),
      );
      expect(outcome).toBe("forbidden");
    });

    it("hides the group (404) from a non-member of any single member", async () => {
      const stranger = await pool.query<{ id: string }>(
        `INSERT INTO accounts (oidc_issuer, oidc_subject, username, display_name)
         VALUES ('test-issuer', 'gro-stranger', 'gro-stranger', 'gro-stranger') RETURNING id`,
      );
      const outcome = await withClient((c) =>
        resolveGroupReadOutcome(
          c,
          stranger.rows[0].id,
          [c1, c2],
          "reports:read",
        ),
      );
      expect(outcome).toBe("not_found");
    });

    it("hides the group (404) when the account is a member of only some members", async () => {
      // Member of c1 only (via the User membership added in setup is on both;
      // build a fresh single-member account to isolate the partial case).
      const partial = await pool.query<{ id: string }>(
        `INSERT INTO accounts (oidc_issuer, oidc_subject, username, display_name)
         VALUES ('test-issuer', 'gro-partial', 'gro-partial', 'gro-partial') RETURNING id`,
      );
      await pool.query(
        `INSERT INTO account_customer_memberships (account_id, customer_id, role_id)
         VALUES ($1, $2, $3)`,
        [partial.rows[0].id, c1, userRoleId],
      );
      const outcome = await withClient((c) =>
        resolveGroupReadOutcome(
          c,
          partial.rows[0].id,
          [c1, c2],
          "reports:read",
        ),
      );
      expect(outcome).toBe("not_found");
    });

    it("hides the group (404) for an empty member list (no vacuous grant)", async () => {
      const outcome = await withClient((c) =>
        resolveGroupReadOutcome(c, managerAcct, [], "reports:read"),
      );
      expect(outcome).toBe("not_found");
    });
  });

  describe("listAccessibleGroups (#513)", () => {
    // A third customer the User account has NO access to, so a group that
    // includes it must be hidden from that account.
    let c3: string;
    let groupVisible: string; // members {c1, c2}
    let groupHidden: string; // members {c1, c3}

    async function mkGroup(name: string, members: string[]): Promise<string> {
      const { rows } = await pool.query<{ id: string }>(
        `INSERT INTO subjects (id, kind) VALUES (gen_random_uuid(), 'group')
         RETURNING id`,
      );
      const id = rows[0].id;
      await pool.query(
        `INSERT INTO customer_groups (id, kind, name, description, created_by, owner_id, tz)
         VALUES ($1, 'group', $2, NULL, $3, $3, 'UTC')`,
        [id, name, adminAcct],
      );
      for (const m of members) {
        await pool.query(
          `INSERT INTO customer_group_members (group_id, customer_id) VALUES ($1, $2)`,
          [id, m],
        );
      }
      return id;
    }

    beforeAll(async () => {
      const { rows } = await pool.query<{ id: string }>(
        `INSERT INTO customers (external_key, name, status, database_status)
         VALUES ('ga-c3', 'ga-c3', 'active', 'active') RETURNING id`,
      );
      c3 = rows[0].id;
      groupVisible = await mkGroup("Visible Group", [c1, c2]);
      groupHidden = await mkGroup("Hidden Group", [c1, c3]);
    });

    it("returns only groups where reports:read is held on every member", async () => {
      const groups = await withClient((c) => listAccessibleGroups(c, userAcct));
      const ids = groups.map((g) => g.id);
      // The User holds reports:read on c1 and c2 (visible group) but has no
      // relationship with c3 (hidden group).
      expect(ids).toContain(groupVisible);
      expect(ids).not.toContain(groupHidden);

      const vis = groups.find((g) => g.id === groupVisible);
      expect(vis).toBeDefined();
      expect(vis?.name).toBe("Visible Group");
      expect(vis?.tz).toBe("UTC");
      expect([...(vis?.memberIds ?? [])].sort()).toEqual([c1, c2].sort());
    });

    it("returns no groups for an account with no member access", async () => {
      const stranger = await pool.query<{ id: string }>(
        `INSERT INTO accounts (oidc_issuer, oidc_subject, username, display_name)
         VALUES ('test-issuer', 'gal-stranger', 'gal-stranger', 'gal-stranger')
         RETURNING id`,
      );
      const groups = await withClient((c) =>
        listAccessibleGroups(c, stranger.rows[0].id),
      );
      expect(groups).toEqual([]);
    });

    // The management list is a STRICTER gate than the view list above: it
    // keeps groups manageable (Manager/Analyst) on every member, not merely
    // readable, and carries owner / provisioning state.
    describe("listManageableGroups (#512)", () => {
      it("returns groups manageable on every member, with summary fields", async () => {
        const groups = await withClient((c) =>
          listManageableGroups(c, managerAcct),
        );
        const byId = new Map(groups.map((g) => [g.id, g]));
        // Manager on c1 & c2 → the {c1,c2} group is manageable; the {c1,c3}
        // group is not (no grant on c3).
        expect(byId.has(groupVisible)).toBe(true);
        expect(byId.has(groupHidden)).toBe(false);
        const vis = byId.get(groupVisible);
        expect(vis?.memberCount).toBe(2);
        expect(vis?.ownerId).toBe(adminAcct);
        expect(vis?.createdBy).toBe(adminAcct);
        // mkGroup inserts no database_status → the DDL default applies.
        expect(vis?.databaseStatus).toBe("provisioning");
      });

      it("returns no groups for a plain User (read != manage)", async () => {
        const groups = await withClient((c) =>
          listManageableGroups(c, userAcct),
        );
        expect(groups).toEqual([]);
      });
    });

    describe("listGroupEligibleMembers (#512)", () => {
      it("lists operational customers a Manager manages, excluding inaccessible ones", async () => {
        const members = await withClient((c) =>
          listGroupEligibleMembers(c, managerAcct),
        );
        const ids = members.map((m) => m.id);
        expect(ids).toContain(c1);
        expect(ids).toContain(c2);
        // c3: the manager has no membership/assignment → excluded.
        expect(ids).not.toContain(c3);
      });

      it("lists customers via an eligible analyst assignment", async () => {
        const members = await withClient((c) =>
          listGroupEligibleMembers(c, analystAcct),
        );
        const ids = members.map((m) => m.id);
        expect(ids).toContain(c1);
        expect(ids).toContain(c2);
        for (const m of members) expect(m.isAnalyst).toBe(true);
      });

      it("excludes customers where the caller is only a User (not manageable)", async () => {
        const members = await withClient((c) =>
          listGroupEligibleMembers(c, userAcct),
        );
        expect(members).toEqual([]);
      });

      it("excludes a stale analyst assignment on an ineligible account", async () => {
        const members = await withClient((c) =>
          listGroupEligibleMembers(c, ineligibleAnalystAcct),
        );
        expect(members).toEqual([]);
      });
    });
  });
});
