// RFC 0004 (#509) — group-report retention reaper DB integration.
//
// Covers the issue gates:
//   - real group-DB row deletion of historical (DAILY/WEEKLY/MONTHLY)
//     reports by `bucket_date`, with the LIVE rolling bucket preserved
//   - only `database_status = 'active'` groups are processed; a
//     provisioning group is never connected
//   - a member missing its `customer_retention_policy` row is audited
//     (`group_skipped`) and that group's reports are left intact, with
//     no group-DB connection attempted

import { randomUUID } from "node:crypto";
import { join } from "node:path";
import type { Pool, PoolClient } from "pg";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

vi.mock("server-only", () => ({}));

import {
  closeAdminPool,
  createTestDatabase,
  dropTestDatabase,
  hasPostgres,
} from "../../db/__tests__/db-test-helpers";
import { runMigrations } from "../../db/migrate";

const AUDIT_DATABASE_URL_BEFORE = process.env.AUDIT_DATABASE_URL;

const describeDb = hasPostgres ? describe : describe.skip;

describeDb("group-report retention reaper integration", () => {
  let authPool: Pool;
  let auditPool: Pool;
  let groupPool: Pool;
  let authDbName: string;
  let auditDbName: string;
  let groupDbName: string;
  let reapGroupReports: typeof import("../sweeper").reapGroupReports;
  let creatorAccountId: string;

  // Records every groupId the reaper asks to connect, so a test can
  // assert active-only processing and "no connection on skip".
  const groupConnects: string[] = [];

  async function connectGroup(groupId: string): Promise<{
    query: PoolClient["query"];
    end: () => Promise<void>;
  }> {
    groupConnects.push(groupId);
    const client = await groupPool.connect();
    return {
      query: client.query.bind(client) as PoolClient["query"],
      end: async () => {
        client.release();
      },
    };
  }

  beforeAll(async () => {
    const auth = await createTestDatabase("groupreap_auth", "auth");
    authDbName = auth.dbName;
    authPool = auth.pool;
    await runMigrations(
      authPool,
      join(process.cwd(), "migrations", "auth"),
      92100,
    );

    const audit = await createTestDatabase("groupreap_audit", "audit");
    auditDbName = audit.dbName;
    auditPool = audit.pool;
    auditPool.on("error", () => {});
    await runMigrations(
      auditPool,
      join(process.cwd(), "migrations", "audit"),
      92101,
    );
    process.env.AUDIT_DATABASE_URL = audit.url;

    // The group data DB carries the results-only schema; the reaper
    // deletes `periodic_report_result` rows here.
    const group = await createTestDatabase("groupreap_group", "auth");
    groupDbName = group.dbName;
    groupPool = group.pool;
    await runMigrations(
      groupPool,
      join(process.cwd(), "migrations", "group"),
      92102,
    );

    const mod = await import("../sweeper");
    reapGroupReports = mod.reapGroupReports;

    const { getAuditPool } = await import("../../db/client");
    getAuditPool().on("error", () => {});

    const acct = await authPool.query<{ id: string }>(
      `INSERT INTO accounts (oidc_issuer, oidc_subject, username, display_name, email)
         VALUES ('test-issuer', 'grp-reap', 'reap-creator', 'Creator', 'reap@example.com')
         RETURNING id`,
    );
    creatorAccountId = acct.rows[0].id;
  });

  afterAll(async () => {
    await dropTestDatabase(authDbName, authPool, "auth");
    await dropTestDatabase(auditDbName, auditPool, "audit");
    await dropTestDatabase(groupDbName, groupPool, "auth");
    await closeAdminPool();
    if (AUDIT_DATABASE_URL_BEFORE === undefined) {
      delete process.env.AUDIT_DATABASE_URL;
    } else {
      process.env.AUDIT_DATABASE_URL = AUDIT_DATABASE_URL_BEFORE;
    }
  });

  beforeEach(async () => {
    groupConnects.length = 0;
    await groupPool.query("TRUNCATE TABLE periodic_report_result");
    await authPool.query("TRUNCATE TABLE periodic_report_state CASCADE");
    await authPool.query(
      `TRUNCATE TABLE group_retention_policy, customer_group_members,
                      customer_retention_policy, customer_groups, customers,
                      subjects CASCADE`,
    );
    await auditPool.query("TRUNCATE TABLE audit_logs");
    // Re-seed the creator account TRUNCATE removed (subjects CASCADE does
    // not touch accounts, but keep the insert resilient).
    const acct = await authPool.query<{ id: string }>(
      `INSERT INTO accounts (oidc_issuer, oidc_subject, username, display_name, email)
         VALUES ('test-issuer', $1, $1, 'Creator', $2)
         ON CONFLICT DO NOTHING
         RETURNING id`,
      [`reap-${randomUUID()}`, `${randomUUID()}@example.com`],
    );
    if (acct.rows[0]) creatorAccountId = acct.rows[0].id;
  });

  const NOW = new Date("2026-05-20T12:00:00Z");

  function bucketDaysAgo(d: number): string {
    return new Date(NOW.getTime() - d * 86_400_000).toISOString().slice(0, 10);
  }

  async function createGroup(
    name: string,
    opts: { status?: string; groupPolicyDays?: number | null } = {},
  ): Promise<string> {
    const subj = await authPool.query<{ id: string }>(
      `INSERT INTO subjects (kind) VALUES ('group') RETURNING id`,
    );
    const groupId = subj.rows[0].id;
    await authPool.query(
      `INSERT INTO customer_groups
         (id, kind, name, created_by, owner_id, tz, database_status)
       VALUES ($1, 'group', $2, $3, $3, 'UTC', $4)`,
      [groupId, name, creatorAccountId, opts.status ?? "active"],
    );
    if (opts.groupPolicyDays !== undefined) {
      await authPool.query(
        `INSERT INTO group_retention_policy (subject_id, analysis_days, updated_by)
         VALUES ($1, $2, '00000000-0000-0000-0000-000000000000'::uuid)`,
        [groupId, opts.groupPolicyDays],
      );
    }
    return groupId;
  }

  async function addMember(
    groupId: string,
    opts: {
      ingestionDays?: number;
      analysisDays?: number | null;
      withPolicy?: boolean;
    } = {},
  ): Promise<string> {
    const customerId = randomUUID();
    await authPool.query(
      `INSERT INTO customers (id, external_key, name, database_status)
       VALUES ($1, $2, 'member', 'active')`,
      [customerId, `mem-${customerId}`],
    );
    await authPool.query(
      `INSERT INTO customer_group_members (group_id, customer_id) VALUES ($1, $2)`,
      [groupId, customerId],
    );
    if (opts.withPolicy ?? true) {
      await authPool.query(
        `INSERT INTO customer_retention_policy
           (customer_id, ingestion_days, analysis_days, updated_by)
         VALUES ($1, $2, $3, '00000000-0000-0000-0000-000000000000'::uuid)`,
        [customerId, opts.ingestionDays ?? 365, opts.analysisDays ?? 1095],
      );
    }
    return customerId;
  }

  async function seedReport(
    groupId: string,
    period: string,
    bucketDate: string,
  ): Promise<void> {
    await groupPool.query(
      `INSERT INTO periodic_report_result
         (subject_id, period, bucket_date, tz, lang, model_name, model,
          model_actual_version, prompt_version, generation,
          aggregate_severity_score, aggregate_likelihood_score,
          aggregate_ttp_tags, priority_tier, sections_jsonb,
          input_event_refs, input_story_refs, input_hash,
          redaction_policy_version)
       VALUES ($1, $2, $3::date, 'UTC', 'ENGLISH', 'openai', 'gpt-4o',
               'mv', 'pv', 1,
               0, 0,
               '[]'::jsonb, 'LOW', '{}'::jsonb,
               '[]'::jsonb, '[]'::jsonb, 'h',
               'baseline-only')`,
      [groupId, period, bucketDate],
    );
  }

  async function remainingReports(
    groupId: string,
  ): Promise<{ period: string; bucket_date: string }[]> {
    const { rows } = await groupPool.query<{
      period: string;
      bucket_date: string;
    }>(
      `SELECT period, bucket_date::text AS bucket_date
         FROM periodic_report_result
        WHERE subject_id = $1
        ORDER BY period, bucket_date`,
      [groupId],
    );
    return rows;
  }

  // `periodic_report_state` lives in the AUTH DB (keyed by `subject_id`
  // post-rekey, == the group id for a group). The reaper archives the
  // over-bound historical rows here so no worker pickup/claim, eager
  // seeder, or regenerate request can re-create the dropped report.
  async function seedState(
    groupId: string,
    period: string,
    bucketDate: string,
    status: string,
  ): Promise<void> {
    await authPool.query(
      `INSERT INTO periodic_report_state
         (subject_id, period, bucket_date, tz, status)
       VALUES ($1, $2, $3::date, 'UTC', $4)`,
      [groupId, period, bucketDate, status],
    );
  }

  async function groupStates(
    groupId: string,
  ): Promise<{ period: string; bucket_date: string; status: string }[]> {
    const { rows } = await authPool.query<{
      period: string;
      bucket_date: string;
      status: string;
    }>(
      `SELECT period, bucket_date::text AS bucket_date, status
         FROM periodic_report_state
        WHERE subject_id = $1
        ORDER BY period, bucket_date`,
      [groupId],
    );
    return rows;
  }

  it("reaps over-bound historical rows by bucket_date and preserves LIVE", async () => {
    // group policy 200; member H_c = max(365, 1095) = 1095 ⇒ bound = 200d.
    const groupId = await createGroup("Bounded", { groupPolicyDays: 200 });
    await addMember(groupId, { ingestionDays: 365, analysisDays: 1095 });

    await seedReport(groupId, "DAILY", bucketDaysAgo(300)); // over bound → reaped
    await seedReport(groupId, "DAILY", bucketDaysAgo(100)); // within bound → kept
    await seedReport(groupId, "WEEKLY", bucketDaysAgo(365)); // over → reaped
    await seedReport(groupId, "MONTHLY", bucketDaysAgo(300)); // over → reaped
    await seedReport(groupId, "LIVE", "1970-01-01"); // excluded → kept

    await reapGroupReports(
      {
        authPool,
        connectCustomer: async () => {
          throw new Error("unused");
        },
        connectGroup,
      },
      NOW,
    );

    expect(await remainingReports(groupId)).toEqual([
      { period: "DAILY", bucket_date: bucketDaysAgo(100) },
      { period: "LIVE", bucket_date: "1970-01-01" },
    ]);

    const { rows: auditRows } = await auditPool.query<{
      action: string;
      details: { deleted_periodic_report_result?: number; bound_days?: number };
    }>(
      `SELECT action, details FROM audit_logs WHERE target_id = $1 ORDER BY id`,
      [groupId],
    );
    const reaped = auditRows.find(
      (r) => r.action === "retention_sweep.group_reaped",
    );
    expect(reaped?.details.deleted_periodic_report_result).toBe(3);
    expect(reaped?.details.bound_days).toBe(200);
  });

  it("processes only active groups, never connecting a provisioning group", async () => {
    const activeId = await createGroup("Active", { groupPolicyDays: 100 });
    await addMember(activeId, { ingestionDays: 30, analysisDays: 90 });
    await seedReport(activeId, "DAILY", bucketDaysAgo(300));

    const provId = await createGroup("Provisioning", {
      status: "provisioning",
      groupPolicyDays: 100,
    });
    await addMember(provId, { ingestionDays: 30, analysisDays: 90 });

    await reapGroupReports(
      {
        authPool,
        connectCustomer: async () => {
          throw new Error("unused");
        },
        connectGroup,
      },
      NOW,
    );

    // Only the active group is enumerated and connected; the
    // provisioning group is skipped without any data-DB connection
    // attempt (its data DB may be absent or unreachable). The active
    // group's over-bound report is deleted. (In production each group has
    // its own data DB; this test shares one pool, so the per-group reap
    // DELETE is intentionally not subject-id filtered.)
    expect(groupConnects).toEqual([activeId]);
    expect((await remainingReports(activeId)).length).toBe(0);
  });

  it("skips and audits a group with a member missing its retention policy; no group-DB connection", async () => {
    const groupId = await createGroup("MissingPolicy", {
      groupPolicyDays: 100,
    });
    await addMember(groupId, { ingestionDays: 30, analysisDays: 90 });
    const badMember = await addMember(groupId, { withPolicy: false });
    await seedReport(groupId, "DAILY", bucketDaysAgo(300));

    await reapGroupReports(
      {
        authPool,
        connectCustomer: async () => {
          throw new Error("unused");
        },
        connectGroup,
      },
      NOW,
    );

    // No connection attempted; the over-bound report survives because the
    // bound could not be computed on complete info.
    expect(groupConnects).toEqual([]);
    expect((await remainingReports(groupId)).length).toBe(1);

    const { rows: auditRows } = await auditPool.query<{
      action: string;
      details: { error_message?: string; member_id?: string };
    }>(
      `SELECT action, details FROM audit_logs WHERE target_id = $1 ORDER BY id`,
      [groupId],
    );
    const skipped = auditRows.find(
      (r) => r.action === "retention_sweep.group_skipped",
    );
    expect(skipped?.details.error_message).toBe("missing_retention_policy");
    expect(skipped?.details.member_id).toBe(badMember);
  });

  it("archives over-bound historical states (gating regeneration) while sparing within-bound and LIVE states", async () => {
    // group policy 200; member H_c = max(365, 1095) = 1095 ⇒ bound = 200d.
    const groupId = await createGroup("ArchiveStates", {
      groupPolicyDays: 200,
    });
    await addMember(groupId, { ingestionDays: 365, analysisDays: 1095 });

    await seedState(groupId, "DAILY", bucketDaysAgo(300), "ready"); // over → archived
    await seedState(groupId, "WEEKLY", bucketDaysAgo(365), "dirty"); // over → archived
    await seedState(groupId, "DAILY", bucketDaysAgo(100), "ready"); // within → kept
    await seedState(groupId, "LIVE", "1970-01-01", "ready"); // LIVE → kept
    // A matching over-bound result row so the reap also runs the delete.
    await seedReport(groupId, "DAILY", bucketDaysAgo(300));

    await reapGroupReports(
      {
        authPool,
        connectCustomer: async () => {
          throw new Error("unused");
        },
        connectGroup,
      },
      NOW,
    );

    // Over-bound historical states are flipped to the terminal `archived`
    // status (so no path regenerates them); the within-bound DAILY and the
    // LIVE rolling bucket are untouched.
    expect(await groupStates(groupId)).toEqual([
      { period: "DAILY", bucket_date: bucketDaysAgo(300), status: "archived" },
      { period: "DAILY", bucket_date: bucketDaysAgo(100), status: "ready" },
      { period: "LIVE", bucket_date: "1970-01-01", status: "ready" },
      { period: "WEEKLY", bucket_date: bucketDaysAgo(365), status: "archived" },
    ]);

    const { rows: auditRows } = await auditPool.query<{
      action: string;
      details: {
        archived_periodic_report_state?: number;
        deleted_periodic_report_result?: number;
      };
    }>(
      `SELECT action, details FROM audit_logs WHERE target_id = $1 ORDER BY id`,
      [groupId],
    );
    const reaped = auditRows.find(
      (r) => r.action === "retention_sweep.group_reaped",
    );
    expect(reaped?.details.archived_periodic_report_state).toBe(2);
    expect(reaped?.details.deleted_periodic_report_result).toBe(1);
  });

  it("skips and audits a group missing its group_retention_policy row; no group-DB connection", async () => {
    // `createGroup` without `groupPolicyDays` inserts no policy row — the
    // foundation-bug condition (#506 always seeds one), distinct from a
    // present row with `analysis_days = NULL` (operator no-expiry).
    const groupId = await createGroup("NoGroupPolicy");
    await addMember(groupId, { ingestionDays: 30, analysisDays: 90 });
    await seedReport(groupId, "DAILY", bucketDaysAgo(300));

    await reapGroupReports(
      {
        authPool,
        connectCustomer: async () => {
          throw new Error("unused");
        },
        connectGroup,
      },
      NOW,
    );

    // No bound could be computed on complete info ⇒ no connection, no reap.
    expect(groupConnects).toEqual([]);
    expect((await remainingReports(groupId)).length).toBe(1);

    const { rows: auditRows } = await auditPool.query<{
      action: string;
      details: { error_message?: string };
    }>(
      `SELECT action, details FROM audit_logs WHERE target_id = $1 ORDER BY id`,
      [groupId],
    );
    const skipped = auditRows.find(
      (r) => r.action === "retention_sweep.group_skipped",
    );
    expect(skipped?.details.error_message).toBe(
      "missing_group_retention_policy",
    );
  });
});
