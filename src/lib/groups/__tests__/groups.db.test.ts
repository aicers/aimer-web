import { join } from "node:path";
import type { Pool, PoolClient } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DEFAULT_ANALYSIS_RETENTION_DAYS } from "../../auth/retention-defaults";
import {
  closeAdminPool,
  createTestDatabase,
  dropTestDatabase,
  hasPostgres,
} from "../../db/__tests__/db-test-helpers";
import { runMigrations } from "../../db/migrate";
import {
  createGroup,
  deleteGroup,
  fetchMemberStates,
  getGroupRetention,
  getGroupWithMembers,
  updateGroupRetention,
  updateGroupTimezone,
} from "../groups";

const MIGRATIONS_DIR = join(process.cwd(), "migrations", "auth");
const LOCK_ID = 1507;

describe.skipIf(!hasPostgres)("customer-group persistence (DB)", () => {
  let pool: Pool;
  let dbName: string;
  let creator: string;
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

  async function makeGroup(tz: string): Promise<string> {
    const created = await withClient((c) =>
      createGroup(c, {
        name: "Test Group",
        description: "desc",
        memberIds: [c1, c2],
        tz,
        creatorAccountId: creator,
        analysisDays: DEFAULT_ANALYSIS_RETENTION_DAYS,
      }),
    );
    return created.id;
  }

  beforeAll(async () => {
    const result = await createTestDatabase("groups_crud", "auth");
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

    const acct = await pool.query<{ id: string }>(
      `INSERT INTO accounts (oidc_issuer, oidc_subject, username, display_name)
       VALUES ('test-issuer', 'gc-creator', 'gc-creator', 'gc-creator') RETURNING id`,
    );
    creator = acct.rows[0].id;

    const mkCustomer = async (key: string, tz = "Asia/Seoul") => {
      const { rows } = await pool.query<{ id: string }>(
        `INSERT INTO customers (external_key, name, status, database_status, timezone)
         VALUES ($1, $1, 'active', 'active', $2) RETURNING id`,
        [key, tz],
      );
      return rows[0].id;
    };
    c1 = await mkCustomer("gc-c1", "Asia/Seoul");
    c2 = await mkCustomer("gc-c2", "UTC");
  });

  afterAll(async () => {
    await dropTestDatabase(dbName, pool, "auth");
    await closeAdminPool();
  });

  it("creates a group with a kind='group' subject, members, and policy", async () => {
    const created = await withClient((c) =>
      createGroup(c, {
        name: "G",
        description: null,
        memberIds: [c1, c2],
        tz: "UTC",
        creatorAccountId: creator,
        analysisDays: DEFAULT_ANALYSIS_RETENTION_DAYS,
      }),
    );
    expect(created.ownerId).toBe(creator);
    expect(created.createdBy).toBe(creator);
    expect(created.memberIds.sort()).toEqual([c1, c2].sort());

    const { rows: subj } = await pool.query<{ kind: string }>(
      `SELECT kind FROM subjects WHERE id = $1`,
      [created.id],
    );
    expect(subj[0].kind).toBe("group");

    const { rows: members } = await pool.query<{ customer_id: string }>(
      `SELECT customer_id FROM customer_group_members WHERE group_id = $1`,
      [created.id],
    );
    expect(members).toHaveLength(2);

    const policy = await withClient((c) => getGroupRetention(c, created.id));
    expect(policy?.analysisDays).toBe(DEFAULT_ANALYSIS_RETENTION_DAYS);

    await pool.query("DELETE FROM subjects WHERE id = $1", [created.id]);
  });

  it("fetchMemberStates returns status/database_status/timezone", async () => {
    const states = await withClient((c) => fetchMemberStates(c, [c1, c2]));
    const byId = new Map(states.map((s) => [s.id, s]));
    expect(byId.get(c1)?.status).toBe("active");
    expect(byId.get(c1)?.databaseStatus).toBe("active");
    expect(byId.get(c1)?.timezone).toBe("Asia/Seoul");
    expect(byId.get(c2)?.timezone).toBe("UTC");
  });

  it("getGroupWithMembers returns the group + members, null when missing", async () => {
    const gid = await makeGroup("UTC");
    const loaded = await withClient((c) => getGroupWithMembers(c, gid));
    expect(loaded?.group.id).toBe(gid);
    expect(loaded?.memberIds.sort()).toEqual([c1, c2].sort());

    const missing = await withClient((c) =>
      getGroupWithMembers(c, "00000000-0000-0000-0000-000000000000"),
    );
    expect(missing).toBeNull();

    await pool.query("DELETE FROM subjects WHERE id = $1", [gid]);
  });

  it("deleteGroup cascades and returns false for a non-group id", async () => {
    const gid = await makeGroup("UTC");
    const ok = await withClient((c) => deleteGroup(c, gid));
    expect(ok).toBe(true);

    const { rows } = await pool.query<{ c: number }>(
      `SELECT (SELECT COUNT(*)::int FROM customer_groups WHERE id = $1)
            + (SELECT COUNT(*)::int FROM customer_group_members WHERE group_id = $1)
            + (SELECT COUNT(*)::int FROM group_retention_policy WHERE subject_id = $1)
            + (SELECT COUNT(*)::int FROM subjects WHERE id = $1) AS c`,
      [gid],
    );
    expect(rows[0].c).toBe(0);

    // A customer subject id is not a group → deleteGroup is a no-op.
    const notGroup = await withClient((c) => deleteGroup(c, c1));
    expect(notGroup).toBe(false);
  });

  it("updateGroupRetention changes the value and reports no-ops", async () => {
    const gid = await makeGroup("UTC");

    const changed = await withClient((c) =>
      updateGroupRetention(c, gid, 90, creator),
    );
    expect(changed).toEqual({
      before: DEFAULT_ANALYSIS_RETENTION_DAYS,
      after: 90,
      changed: true,
    });

    const noop = await withClient((c) =>
      updateGroupRetention(c, gid, 90, creator),
    );
    expect(noop?.changed).toBe(false);

    const cleared = await withClient((c) =>
      updateGroupRetention(c, gid, null, creator),
    );
    expect(cleared).toEqual({ before: 90, after: null, changed: true });

    await pool.query("DELETE FROM subjects WHERE id = $1", [gid]);
  });

  it("updateGroupTimezone re-sets tz but leaves past buckets' tz key intact", async () => {
    const gid = await makeGroup("Asia/Seoul");

    // A past bucket recorded under the original tz.
    await pool.query(
      `INSERT INTO periodic_report_state
         (subject_id, period, bucket_date, tz, status)
       VALUES ($1, 'LIVE', DATE '1970-01-01', 'Asia/Seoul', 'ready')`,
      [gid],
    );

    const result = await withClient((c) => updateGroupTimezone(c, gid, "UTC"));
    expect(result).toEqual({
      before: "Asia/Seoul",
      after: "UTC",
      changed: true,
    });

    // The group's stored tz is now UTC...
    const { rows: grp } = await pool.query<{ tz: string }>(
      `SELECT tz FROM customer_groups WHERE id = $1`,
      [gid],
    );
    expect(grp[0].tz).toBe("UTC");

    // ...but the past bucket keeps its original tz in its key (future
    // buckets only).
    const { rows: past } = await pool.query<{ tz: string; status: string }>(
      `SELECT tz, status FROM periodic_report_state WHERE subject_id = $1`,
      [gid],
    );
    expect(past).toHaveLength(1);
    expect(past[0].tz).toBe("Asia/Seoul");
    expect(past[0].status).toBe("ready");

    await pool.query("DELETE FROM subjects WHERE id = $1", [gid]);
  });
});
