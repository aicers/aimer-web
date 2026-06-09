import { join } from "node:path";
import type { Pool, PoolClient } from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { HttpError } from "../../auth/errors";

// `lifecycle.ts` transitively imports `../audit` (a `server-only` module); the
// reconcile paths under test never reach an actual audit write here (no
// actorContext is passed), so stub the marker to load the module under Node.
vi.mock("server-only", () => ({}));

import {
  closeAdminPool,
  createTestDatabase,
  dropTestDatabase,
  hasPostgres,
} from "../../db/__tests__/db-test-helpers";
import { runMigrations } from "../../db/migrate";
import { createGroup } from "../groups";
import {
  assertGroupGenerationActive,
  listQualifyingManagers,
  reconcileGroup,
  reconcileGroups,
} from "../lifecycle";

const MIGRATIONS_DIR = join(process.cwd(), "migrations", "auth");
const LOCK_ID = 1510;

describe.skipIf(!hasPostgres)("group lifecycle enforcement (DB)", () => {
  let pool: Pool;
  let dbName: string;
  let managerRoleId: number;
  let userRoleId: number;
  let adminAcct: string;
  let seq = 0;

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

  async function reconcile(groupId: string) {
    return withClient(async (c) => {
      await c.query("BEGIN");
      try {
        const out = await reconcileGroup(c, groupId);
        await c.query("COMMIT");
        return out;
      } catch (err) {
        await c.query("ROLLBACK");
        throw err;
      }
    });
  }

  async function mkCustomer(
    status = "active",
    databaseStatus = "active",
  ): Promise<string> {
    seq += 1;
    const { rows } = await pool.query<{ id: string }>(
      `INSERT INTO customers (external_key, name, status, database_status)
       VALUES ($1, $1, $2, $3) RETURNING id`,
      [`lc-cust-${seq}`, status, databaseStatus],
    );
    return rows[0].id;
  }

  async function mkAccount(analystEligible = false): Promise<string> {
    seq += 1;
    const { rows } = await pool.query<{ id: string }>(
      `INSERT INTO accounts (oidc_issuer, oidc_subject, username, display_name, analyst_eligible)
       VALUES ('test-issuer', $1, $1, $1, $2) RETURNING id`,
      [`lc-acct-${seq}`, analystEligible],
    );
    return rows[0].id;
  }

  function addManager(acct: string, customer: string, createdAt?: string) {
    return pool.query(
      `INSERT INTO account_customer_memberships (account_id, customer_id, role_id, created_at)
       VALUES ($1, $2, $3, COALESCE($4::timestamptz, NOW()))`,
      [acct, customer, managerRoleId, createdAt ?? null],
    );
  }

  function addAnalyst(acct: string, customer: string, createdAt?: string) {
    return pool.query(
      `INSERT INTO analyst_customer_assignments (account_id, customer_id, assigned_by, created_at)
       VALUES ($1, $2, $3, COALESCE($4::timestamptz, NOW()))`,
      [acct, customer, adminAcct, createdAt ?? null],
    );
  }

  async function suspendAccount(acct: string) {
    await pool.query(`UPDATE accounts SET status = 'suspended' WHERE id = $1`, [
      acct,
    ]);
  }

  async function setCustomer(
    id: string,
    fields: { status?: string; databaseStatus?: string },
  ) {
    if (fields.status !== undefined) {
      await pool.query(`UPDATE customers SET status = $2 WHERE id = $1`, [
        id,
        fields.status,
      ]);
    }
    if (fields.databaseStatus !== undefined) {
      await pool.query(
        `UPDATE customers SET database_status = $2 WHERE id = $1`,
        [id, fields.databaseStatus],
      );
    }
  }

  async function makeGroup(
    creator: string,
    members: string[],
  ): Promise<string> {
    const created = await withClient((c) =>
      createGroup(c, {
        name: "Group",
        description: null,
        memberIds: members,
        tz: "UTC",
        creatorAccountId: creator,
        analysisDays: 1095,
      }),
    );
    return created.id;
  }

  async function ownerOf(groupId: string): Promise<string | null> {
    const { rows } = await pool.query<{ owner_id: string }>(
      `SELECT owner_id FROM customer_groups WHERE id = $1`,
      [groupId],
    );
    return rows[0]?.owner_id ?? null;
  }

  async function lifecycleOf(groupId: string): Promise<string | null> {
    const { rows } = await pool.query<{ lifecycle_status: string }>(
      `SELECT lifecycle_status FROM customer_groups WHERE id = $1`,
      [groupId],
    );
    return rows[0]?.lifecycle_status ?? null;
  }

  beforeAll(async () => {
    const result = await createTestDatabase("group_lifecycle", "auth");
    pool = result.pool;
    dbName = result.dbName;

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
      `SELECT id, name FROM roles
        WHERE name IN ('Manager', 'User') AND auth_context = 'general'`,
    );
    for (const r of roles.rows) {
      if (r.name === "Manager") managerRoleId = r.id;
      if (r.name === "User") userRoleId = r.id;
    }
    adminAcct = await mkAccount();
  });

  afterAll(async () => {
    await dropTestDatabase(dbName, pool, "auth");
    await closeAdminPool();
  });

  // -----------------------------------------------------------------------
  // listQualifyingManagers — deterministic ordering / qualification
  // -----------------------------------------------------------------------

  describe("listQualifyingManagers", () => {
    it("orders Manager before Analyst, and managers oldest-membership first", async () => {
      const c1 = await mkCustomer();
      const c2 = await mkCustomer();
      const mgrOld = await mkAccount();
      const mgrNew = await mkAccount();
      const analyst = await mkAccount(true);
      await addManager(mgrOld, c1, "2020-01-01T00:00:00Z");
      await addManager(mgrOld, c2, "2020-01-01T00:00:00Z");
      await addManager(mgrNew, c1, "2021-01-01T00:00:00Z");
      await addManager(mgrNew, c2, "2021-01-01T00:00:00Z");
      await addAnalyst(analyst, c1);
      await addAnalyst(analyst, c2);

      const ordered = await withClient((c) =>
        listQualifyingManagers(c, [c1, c2]),
      );
      expect(ordered.map((q) => q.accountId)).toEqual([
        mgrOld,
        mgrNew,
        analyst,
      ]);
      expect(ordered.map((q) => q.rank)).toEqual([
        "manager",
        "manager",
        "analyst",
      ]);
    });

    it("ranks a mixed Manager/Analyst account as analyst", async () => {
      const c1 = await mkCustomer();
      const c2 = await mkCustomer();
      const mixed = await mkAccount(true);
      await addManager(mixed, c1);
      await addAnalyst(mixed, c2); // analyst (not manager) on c2

      const ordered = await withClient((c) =>
        listQualifyingManagers(c, [c1, c2]),
      );
      expect(ordered).toHaveLength(1);
      expect(ordered[0].accountId).toBe(mixed);
      expect(ordered[0].rank).toBe("analyst");
    });

    it("breaks an analyst-only pool by assignment age then lowest UUID", async () => {
      const c1 = await mkCustomer();
      const c2 = await mkCustomer();
      const anaOld = await mkAccount(true);
      const anaNew = await mkAccount(true);
      await addAnalyst(anaOld, c1, "2020-01-01T00:00:00Z");
      await addAnalyst(anaOld, c2, "2020-01-01T00:00:00Z");
      await addAnalyst(anaNew, c1, "2021-01-01T00:00:00Z");
      await addAnalyst(anaNew, c2, "2021-01-01T00:00:00Z");

      const byAge = await withClient((c) =>
        listQualifyingManagers(c, [c1, c2]),
      );
      expect(byAge.map((q) => q.accountId)).toEqual([anaOld, anaNew]);
      expect(byAge.every((q) => q.rank === "analyst")).toBe(true);

      // Two analysts with identical age fall back to lowest account UUID.
      const tieA = await mkAccount(true);
      const tieB = await mkAccount(true);
      const c3 = await mkCustomer();
      const c4 = await mkCustomer();
      await addAnalyst(tieA, c3, "2019-01-01T00:00:00Z");
      await addAnalyst(tieA, c4, "2019-01-01T00:00:00Z");
      await addAnalyst(tieB, c3, "2019-01-01T00:00:00Z");
      await addAnalyst(tieB, c4, "2019-01-01T00:00:00Z");
      const byUuid = await withClient((c) =>
        listQualifyingManagers(c, [c3, c4]),
      );
      expect(byUuid.map((q) => q.accountId)).toEqual([tieA, tieB].sort());
    });

    it("excludes ineligible analysts, suspended accounts, and partial coverage", async () => {
      const c1 = await mkCustomer();
      const c2 = await mkCustomer();
      const ineligible = await mkAccount(false); // analyst assigned but not eligible
      const suspended = await mkAccount();
      const partial = await mkAccount(); // Manager on c1 only
      await addAnalyst(ineligible, c1);
      await addAnalyst(ineligible, c2);
      await addManager(suspended, c1);
      await addManager(suspended, c2);
      await suspendAccount(suspended);
      await addManager(partial, c1);

      const ordered = await withClient((c) =>
        listQualifyingManagers(c, [c1, c2]),
      );
      expect(ordered).toHaveLength(0);
    });

    it("returns nothing for an empty member set", async () => {
      const ordered = await withClient((c) => listQualifyingManagers(c, []));
      expect(ordered).toEqual([]);
    });
  });

  // -----------------------------------------------------------------------
  // reconcileGroup — owner transfer
  // -----------------------------------------------------------------------

  describe("owner transfer", () => {
    it("transfers ownership off an owner that lost Manager on a member", async () => {
      const c1 = await mkCustomer();
      const c2 = await mkCustomer();
      const owner = await mkAccount();
      const heir = await mkAccount();
      await addManager(owner, c1);
      await addManager(owner, c2);
      await addManager(heir, c1, "2022-01-01T00:00:00Z");
      await addManager(heir, c2, "2022-01-01T00:00:00Z");
      const gid = await makeGroup(owner, [c1, c2]);

      // Owner downgraded to User on c2 — no longer Manager on every member.
      await pool.query(
        `UPDATE account_customer_memberships SET role_id = $3
          WHERE account_id = $1 AND customer_id = $2`,
        [owner, c2, userRoleId],
      );

      const out = await reconcile(gid);
      expect(out.deleted).toBe(false);
      expect(out.ownerTransferredFrom).toBe(owner);
      expect(out.ownerTransferredTo).toBe(heir);
      expect(await ownerOf(gid)).toBe(heir);
    });

    it("transfers a suspended owner's group, preferring a Manager heir over an older Analyst", async () => {
      const c1 = await mkCustomer();
      const c2 = await mkCustomer();
      const owner = await mkAccount();
      const mgrHeir = await mkAccount();
      const anaHeir = await mkAccount(true);
      await addManager(owner, c1);
      await addManager(owner, c2);
      await addManager(mgrHeir, c1, "2023-01-01T00:00:00Z");
      await addManager(mgrHeir, c2, "2023-01-01T00:00:00Z");
      // Analyst heir is OLDER, but Manager rank still wins.
      await addAnalyst(anaHeir, c1, "2000-01-01T00:00:00Z");
      await addAnalyst(anaHeir, c2, "2000-01-01T00:00:00Z");
      const gid = await makeGroup(owner, [c1, c2]);

      await suspendAccount(owner);

      const out = await reconcile(gid);
      expect(out.deleted).toBe(false);
      expect(out.ownerTransferredTo).toBe(mgrHeir);
      expect(await ownerOf(gid)).toBe(mgrHeir);
    });

    it("transfers to an Analyst when only analysts remain", async () => {
      const c1 = await mkCustomer();
      const c2 = await mkCustomer();
      const owner = await mkAccount();
      const ana = await mkAccount(true);
      await addManager(owner, c1);
      await addManager(owner, c2);
      await addAnalyst(ana, c1);
      await addAnalyst(ana, c2);
      const gid = await makeGroup(owner, [c1, c2]);

      await suspendAccount(owner);

      const out = await reconcile(gid);
      expect(out.deleted).toBe(false);
      expect(out.ownerTransferredTo).toBe(ana);
      expect(await ownerOf(gid)).toBe(ana);
      expect(await lifecycleOf(gid)).toBe("active");
    });
  });

  // -----------------------------------------------------------------------
  // reconcileGroup — auto-delete
  // -----------------------------------------------------------------------

  describe("auto-delete", () => {
    it("deletes the group when the last qualifying manager is gone", async () => {
      const c1 = await mkCustomer();
      const c2 = await mkCustomer();
      const owner = await mkAccount();
      await addManager(owner, c1);
      await addManager(owner, c2);
      const gid = await makeGroup(owner, [c1, c2]);

      await suspendAccount(owner);

      const out = await reconcile(gid);
      expect(out.deleted).toBe(true);
      const { rows } = await pool.query(
        `SELECT 1 FROM customer_groups WHERE id = $1`,
        [gid],
      );
      expect(rows).toHaveLength(0);
    });

    it("tears down the dedicated database of an auto-deleted group (orchestration)", async () => {
      const c1 = await mkCustomer();
      const c2 = await mkCustomer();
      const owner = await mkAccount();
      await addManager(owner, c1);
      await addManager(owner, c2);
      const gid = await makeGroup(owner, [c1, c2]);
      await suspendAccount(owner);

      const torndown: string[] = [];
      const outcomes = await reconcileGroups(pool, [gid], {
        teardown: async (groupId) => {
          torndown.push(groupId);
        },
      });
      expect(outcomes[0].deleted).toBe(true);
      expect(torndown).toEqual([gid]);
    });
  });

  // -----------------------------------------------------------------------
  // reconcileGroup — suspend / resume
  // -----------------------------------------------------------------------

  describe("suspend / resume", () => {
    it("suspends on a suspended member and resumes when all are operational", async () => {
      const c1 = await mkCustomer();
      const c2 = await mkCustomer();
      const owner = await mkAccount();
      await addManager(owner, c1);
      await addManager(owner, c2);
      const gid = await makeGroup(owner, [c1, c2]);

      // Baseline: both members operational → active.
      expect((await reconcile(gid)).lifecycleChangedTo).toBeUndefined();
      expect(await lifecycleOf(gid)).toBe("active");

      // A suspended member pauses generation.
      await setCustomer(c1, { status: "suspended" });
      const suspended = await reconcile(gid);
      expect(suspended.lifecycleChangedTo).toBe("suspended");
      expect(suspended.deleted).toBe(false);
      expect(await lifecycleOf(gid)).toBe("suspended");

      // Still suspended while the OTHER member is mid-resume.
      await setCustomer(c1, { status: "active" });
      await setCustomer(c2, { databaseStatus: "failed" });
      await reconcile(gid);
      expect(await lifecycleOf(gid)).toBe("suspended");

      // All operational again → resume.
      await setCustomer(c2, { databaseStatus: "active" });
      const resumed = await reconcile(gid);
      expect(resumed.lifecycleChangedTo).toBe("active");
      expect(await lifecycleOf(gid)).toBe("active");
    });

    it("treats a disabled member as suspend-like (pause, not delete)", async () => {
      const c1 = await mkCustomer();
      const c2 = await mkCustomer();
      const owner = await mkAccount();
      await addManager(owner, c1);
      await addManager(owner, c2);
      const gid = await makeGroup(owner, [c1, c2]);

      await setCustomer(c1, { status: "disabled" });
      const out = await reconcile(gid);
      expect(out.deleted).toBe(false);
      expect(out.lifecycleChangedTo).toBe("suspended");
      // The group entity and its members are intact (not torn down).
      const { rows } = await pool.query(
        `SELECT 1 FROM customer_groups WHERE id = $1`,
        [gid],
      );
      expect(rows).toHaveLength(1);

      // Reversible: re-activating the member resumes generation.
      await setCustomer(c1, { status: "active" });
      const resumed = await reconcile(gid);
      expect(resumed.lifecycleChangedTo).toBe("active");
      expect(await lifecycleOf(gid)).toBe("active");
    });
  });

  // -----------------------------------------------------------------------
  // Generation guard
  // -----------------------------------------------------------------------

  describe("assertGroupGenerationActive", () => {
    it("resolves for an active group, rejects a suspended one, 404s a missing one", async () => {
      const c1 = await mkCustomer();
      const c2 = await mkCustomer();
      const owner = await mkAccount();
      await addManager(owner, c1);
      await addManager(owner, c2);
      const gid = await makeGroup(owner, [c1, c2]);

      await expect(
        withClient((c) => assertGroupGenerationActive(c, gid)),
      ).resolves.toBeUndefined();

      await setCustomer(c1, { status: "suspended" });
      await reconcile(gid);
      await expect(
        withClient((c) => assertGroupGenerationActive(c, gid)),
      ).rejects.toMatchObject({ statusCode: 409 });

      await expect(
        withClient((c) =>
          assertGroupGenerationActive(
            c,
            "00000000-0000-0000-0000-000000000000",
          ),
        ),
      ).rejects.toBeInstanceOf(HttpError);
    });
  });
});
