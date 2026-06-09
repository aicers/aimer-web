// RFC 0004 B3 step 2 (#524 scope 5) — group readiness tick + recompute DB tests.
//
// Covers the issue gates:
//   - group `periodic_report_state` buckets are seeded in the group tz from
//     group creation onward, and NO pre-creation bucket is ever created
//   - member data changes after generation dirty the group's existing buckets
//     (recompute, not seed-only)

import { join } from "node:path";
import type { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  closeAdminPool,
  createTestDatabase,
  dropTestDatabase,
  hasPostgres,
} from "@/lib/db/__tests__/db-test-helpers";
import { runMigrations } from "@/lib/db/migrate";

vi.mock("server-only", () => ({}));

const { tickGroupReadiness } = await import("../group-readiness");

const AUTH_MIGRATIONS_DIR = join(process.cwd(), "migrations", "auth");
const CUSTOMER_MIGRATIONS_DIR = join(process.cwd(), "migrations", "customer");

const TZ = "Asia/Seoul";
const M1 = "00000000-0000-0000-0000-0000000000c1";
const ACCOUNT = "00000000-0000-0000-0000-0000000000c9";
const GROUP_CREATED = "2026-05-26T00:00:00Z";

async function seedBaselineEvent(
  pool: Pool,
  eventKey: string,
  eventTime: string,
): Promise<void> {
  await pool.query(
    `INSERT INTO baseline_event
       (baseline_version, event_key, event_time, kind, category, raw_score,
        raw_event, score_window_context, window_signals,
        scoring_weights_snapshot, source_aice_id, received_at)
     VALUES ('vA', $1::numeric, $2::timestamptz, 'k', 'recon', 0.5,
             '{}'::jsonb, '{}'::jsonb, '{}'::jsonb, '{}'::jsonb, 'aice-1', $2::timestamptz)`,
    [eventKey, eventTime],
  );
}

describe.skipIf(!hasPostgres)("group readiness tick (#524)", () => {
  let authDbName: string;
  let authPool: Pool;
  let m1DbName: string;
  let m1Pool: Pool;
  let groupId: string;

  const deps = () => ({
    authPool,
    connectMember: () =>
      ({
        query: m1Pool.query.bind(m1Pool),
        end: async () => {},
        // biome-ignore lint/suspicious/noExplicitAny: connection shim
      }) as any,
  });

  beforeAll(async () => {
    const auth = await createTestDatabase("group_ready_auth");
    authDbName = auth.dbName;
    authPool = auth.pool;
    await runMigrations(authPool, AUTH_MIGRATIONS_DIR, 5411);

    const m1 = await createTestDatabase("group_ready_m1");
    m1DbName = m1.dbName;
    m1Pool = m1.pool;
    await runMigrations(m1Pool, CUSTOMER_MIGRATIONS_DIR, 5412);

    await authPool.query(
      `INSERT INTO accounts (id, oidc_issuer, oidc_subject, username, display_name)
       VALUES ($1, 'iss', 'sub', 'u', 'U')`,
      [ACCOUNT],
    );
    await authPool.query(
      `INSERT INTO customers (id, external_key, name, database_status, timezone)
       VALUES ($1, 'm1', 'M1', 'active', $2)`,
      [M1, TZ],
    );
    const subj = await authPool.query<{ id: string }>(
      `INSERT INTO subjects (kind) VALUES ('group') RETURNING id`,
    );
    groupId = subj.rows[0].id;
    await authPool.query(
      `INSERT INTO customer_groups
         (id, kind, name, created_by, owner_id, tz, database_status, created_at)
       VALUES ($1, 'group', 'G', $2, $2, $3, 'active', $4::timestamptz)`,
      [groupId, ACCOUNT, TZ, GROUP_CREATED],
    );
    await authPool.query(
      `INSERT INTO customer_group_members (group_id, customer_id) VALUES ($1, $2)`,
      [groupId, M1],
    );
  }, 60_000);

  afterAll(async () => {
    await dropTestDatabase(authDbName, authPool);
    await dropTestDatabase(m1DbName, m1Pool);
    await closeAdminPool();
  }, 30_000);

  it("seeds from group creation onward and never seeds a pre-creation bucket", async () => {
    await authPool.query(
      `DELETE FROM periodic_report_state WHERE subject_id = $1`,
      [groupId],
    );
    await m1Pool.query("DELETE FROM baseline_event");
    // One member event BEFORE group creation, one AFTER.
    await seedBaselineEvent(m1Pool, "1", "2026-05-20T03:00:00Z"); // pre-creation
    await seedBaselineEvent(m1Pool, "2", "2026-05-27T03:00:00Z"); // post-creation

    await tickGroupReadiness(deps(), "2026-05-28T00:00:00Z");

    const { rows } = await authPool.query<{ bucket_date: string }>(
      `SELECT bucket_date::text AS bucket_date
         FROM periodic_report_state
        WHERE subject_id = $1 AND period = 'DAILY'
        ORDER BY bucket_date`,
      [groupId],
    );
    const dates = rows.map((r) => r.bucket_date);
    // Post-creation DAILY bucket is seeded; the pre-creation one is not.
    expect(dates).toContain("2026-05-27");
    expect(dates).not.toContain("2026-05-20");
  });

  it("dirties an already-generated bucket when member data changes (recompute)", async () => {
    await authPool.query(
      `DELETE FROM periodic_report_state WHERE subject_id = $1`,
      [groupId],
    );
    await authPool.query(
      `DELETE FROM periodic_report_job WHERE subject_id = $1`,
      [groupId],
    );
    await m1Pool.query("DELETE FROM baseline_event");
    await seedBaselineEvent(m1Pool, "1", "2026-05-27T03:00:00Z");

    // First tick seeds the DAILY bucket (pending) with event_count = 1.
    await tickGroupReadiness(deps(), "2026-05-28T00:00:00Z");
    // Simulate the bucket having been generated: promote to ready + a done job.
    await authPool.query(
      `UPDATE periodic_report_state SET status = 'ready'
        WHERE subject_id = $1 AND period = 'DAILY' AND bucket_date = '2026-05-27'`,
      [groupId],
    );
    await authPool.query(
      `INSERT INTO periodic_report_job
         (subject_id, period, bucket_date, tz, lang, model_name, model,
          status, generation, dry_run)
       VALUES ($1, 'DAILY', '2026-05-27'::date, $2, 'ENGLISH', 'openai', 'gpt-4o',
               'done', 1, FALSE)`,
      [groupId, TZ],
    );

    // Member data changes AFTER generation: a new event in the same bucket.
    await seedBaselineEvent(m1Pool, "2", "2026-05-27T05:00:00Z");
    await tickGroupReadiness(deps(), "2026-05-28T01:00:00Z");

    const { rows } = await authPool.query<{
      status: string;
      event_count: string;
    }>(
      `SELECT status, event_count::text AS event_count
         FROM periodic_report_state
        WHERE subject_id = $1 AND period = 'DAILY' AND bucket_date = '2026-05-27'`,
      [groupId],
    );
    expect(rows[0].status).toBe("dirty");
    expect(Number(rows[0].event_count)).toBe(2);
  });

  it("dirties an already-generated bucket when member data drops to zero", async () => {
    await authPool.query(
      `DELETE FROM periodic_report_state WHERE subject_id = $1`,
      [groupId],
    );
    await authPool.query(
      `DELETE FROM periodic_report_job WHERE subject_id = $1`,
      [groupId],
    );
    await m1Pool.query("DELETE FROM baseline_event");
    await seedBaselineEvent(m1Pool, "1", "2026-05-27T03:00:00Z");

    // Seed + generate the bucket (event_count = 1).
    await tickGroupReadiness(deps(), "2026-05-28T00:00:00Z");
    await authPool.query(
      `UPDATE periodic_report_state SET status = 'ready'
        WHERE subject_id = $1 AND period = 'DAILY' AND bucket_date = '2026-05-27'`,
      [groupId],
    );
    await authPool.query(
      `INSERT INTO periodic_report_job
         (subject_id, period, bucket_date, tz, lang, model_name, model,
          status, generation, dry_run)
       VALUES ($1, 'DAILY', '2026-05-27'::date, $2, 'ENGLISH', 'openai', 'gpt-4o',
               'done', 1, FALSE)`,
      [groupId, TZ],
    );

    // Member data is deleted/window-replaced AFTER generation: zero rows now
    // produce NO aggregate key, so the tick must still merge the existing
    // bucket and resync it to event_count = 0 + flip to dirty.
    await m1Pool.query("DELETE FROM baseline_event");
    await tickGroupReadiness(deps(), "2026-05-28T01:00:00Z");

    const { rows } = await authPool.query<{
      status: string;
      event_count: string;
    }>(
      `SELECT status, event_count::text AS event_count
         FROM periodic_report_state
        WHERE subject_id = $1 AND period = 'DAILY' AND bucket_date = '2026-05-27'`,
      [groupId],
    );
    expect(rows[0].status).toBe("dirty");
    expect(Number(rows[0].event_count)).toBe(0);
  });
});
