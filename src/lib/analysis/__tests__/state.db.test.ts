// RFC 0002 Phase 0 (#294) — state-transition + Phase 0 worker DB tests.
//
// Covers (a) the ingest-hook state mutations, (b) the worker tick that
// flips pending → ready and dispatches dry-run job rows, and (c) the
// dirty / archive / unarchive transitions surfaced by window-replace.

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

const {
  dirtyPeriodicStatesOverlapping,
  dirtyStoryStatesInRange,
  maybeArchiveStoryState,
  recordBaselineActivity,
  recordStoryMemberArrival,
  unarchiveStoryStateIfArchived,
} = await import("../state");

const { applyWindowReplaceStoryHook } = await import("../ingest-hooks");

const { runAnalysisJobTickOnce } = await import(
  "@/lib/instrumentation/analysis-job-worker"
);

const AUTH_MIGRATIONS_DIR = join(process.cwd(), "migrations", "auth");
const LOCK_ID = 1099;
const CUSTOMER_A = "00000000-0000-0000-0000-0000000000aa";
const CUSTOMER_B = "00000000-0000-0000-0000-0000000000bb";

async function seedCustomers(pool: Pool): Promise<void> {
  await pool.query(
    `INSERT INTO customers (id, external_key, name)
     VALUES ($1, 'ck-a', 'A'), ($2, 'ck-b', 'B')
     ON CONFLICT (id) DO NOTHING`,
    [CUSTOMER_A, CUSTOMER_B],
  );
}

async function getStoryState(pool: Pool, customerId: string, storyId: string) {
  const { rows } = await pool.query<{
    status: string;
    first_member_at: Date | null;
    last_member_at: Date | null;
  }>(
    `SELECT status, first_member_at, last_member_at
       FROM story_analysis_state
      WHERE customer_id = $1 AND story_id = $2::bigint`,
    [customerId, storyId],
  );
  return rows[0] ?? null;
}

async function countStoryJobs(
  pool: Pool,
  customerId: string,
  storyId: string,
): Promise<{ count: number; generation: number | null }> {
  const { rows } = await pool.query<{
    count: string;
    generation: number | null;
  }>(
    `SELECT COUNT(*)::text AS count, MAX(generation) AS generation
       FROM story_analysis_job
      WHERE customer_id = $1 AND story_id = $2::bigint`,
    [customerId, storyId],
  );
  return {
    count: Number(rows[0]?.count ?? 0),
    generation: rows[0]?.generation ?? null,
  };
}

describe.skipIf(!hasPostgres)("analysis state transitions (auth DB)", () => {
  let dbName: string;
  let pool: Pool;

  beforeAll(async () => {
    const db = await createTestDatabase("analysis_state");
    dbName = db.dbName;
    pool = db.pool;
    await runMigrations(pool, AUTH_MIGRATIONS_DIR, LOCK_ID);
    await seedCustomers(pool);
  });

  afterAll(async () => {
    await dropTestDatabase(dbName, pool);
    await closeAdminPool();
  });

  it("recordStoryMemberArrival creates a pending state row on first ingest", async () => {
    const client = await pool.connect();
    try {
      await recordStoryMemberArrival(
        client,
        CUSTOMER_A,
        "1001",
        new Date("2026-05-27T10:00:00Z"),
      );
    } finally {
      client.release();
    }
    const row = await getStoryState(pool, CUSTOMER_A, "1001");
    expect(row?.status).toBe("pending");
    expect(row?.first_member_at?.toISOString()).toBe(
      "2026-05-27T10:00:00.000Z",
    );
    expect(row?.last_member_at?.toISOString()).toBe("2026-05-27T10:00:00.000Z");
  });

  it("subsequent member arrival forward-patches last_member_at only", async () => {
    const client = await pool.connect();
    try {
      await recordStoryMemberArrival(
        client,
        CUSTOMER_A,
        "1001",
        new Date("2026-05-27T10:30:00Z"),
      );
    } finally {
      client.release();
    }
    const row = await getStoryState(pool, CUSTOMER_A, "1001");
    expect(row?.first_member_at?.toISOString()).toBe(
      "2026-05-27T10:00:00.000Z",
    );
    expect(row?.last_member_at?.toISOString()).toBe("2026-05-27T10:30:00.000Z");
  });

  it("worker tick promotes pending → ready once idle window elapses, then dispatches a dry-run job", async () => {
    // Back-date `last_member_at` past the 15min idle threshold so the
    // worker's NOW()-based readiness check fires deterministically.
    await pool.query(
      `UPDATE story_analysis_state
          SET last_member_at = NOW() - INTERVAL '20 minutes',
              first_member_at = NOW() - INTERVAL '20 minutes'
        WHERE customer_id = $1 AND story_id = 1001`,
      [CUSTOMER_A],
    );
    await runAnalysisJobTickOnce(pool);

    const row = await getStoryState(pool, CUSTOMER_A, "1001");
    expect(row?.status).toBe("ready");
    const jobs = await countStoryJobs(pool, CUSTOMER_A, "1001");
    expect(jobs.count).toBe(1);
    expect(jobs.generation).toBe(1);

    const { rows } = await pool.query(
      `SELECT status, dry_run FROM story_analysis_job
        WHERE customer_id = $1 AND story_id = 1001`,
      [CUSTOMER_A],
    );
    expect(rows[0].status).toBe("done");
    expect(rows[0].dry_run).toBe(true);
  });

  it("late member after ready+done transitions the state to dirty and re-queues", async () => {
    const client = await pool.connect();
    try {
      await recordStoryMemberArrival(client, CUSTOMER_A, "1001", new Date());
    } finally {
      client.release();
    }
    const row = await getStoryState(pool, CUSTOMER_A, "1001");
    expect(row?.status).toBe("dirty");

    // Next worker tick advances generation and flips dirty → ready.
    await runAnalysisJobTickOnce(pool);
    const jobs = await countStoryJobs(pool, CUSTOMER_A, "1001");
    expect(jobs.generation).toBeGreaterThanOrEqual(2);
    const after = await getStoryState(pool, CUSTOMER_A, "1001");
    expect(after?.status).toBe("ready");
  });

  it("dirtyStoryStatesInRange only flips rows whose jobs are processing/done", async () => {
    // Seed a fresh pending row that has no jobs yet — must NOT be
    // dirtied by an overlap (decision: dirty only past-ready states).
    const client = await pool.connect();
    try {
      await recordStoryMemberArrival(
        client,
        CUSTOMER_A,
        "2002",
        new Date("2026-05-27T11:00:00Z"),
      );
      await dirtyStoryStatesInRange(client, CUSTOMER_A, ["1001", "2002"]);
    } finally {
      client.release();
    }
    const fresh = await getStoryState(pool, CUSTOMER_A, "2002");
    expect(fresh?.status).toBe("pending");
    const ready = await getStoryState(pool, CUSTOMER_A, "1001");
    expect(ready?.status).toBe("dirty");
  });

  it("maybeArchiveStoryState archives only when no story version survives", async () => {
    const client = await pool.connect();
    try {
      // surviving > 0 is a no-op.
      await maybeArchiveStoryState(client, CUSTOMER_A, "1001", 1);
      const stillReady = await getStoryState(pool, CUSTOMER_A, "1001");
      expect(stillReady?.status).not.toBe("archived");

      await maybeArchiveStoryState(client, CUSTOMER_A, "1001", 0);
      const archived = await getStoryState(pool, CUSTOMER_A, "1001");
      expect(archived?.status).toBe("archived");
    } finally {
      client.release();
    }
  });

  it("unarchive in place: re-ingest after archive resets to pending and clears stale jobs", async () => {
    const client = await pool.connect();
    try {
      await recordStoryMemberArrival(
        client,
        CUSTOMER_A,
        "1001",
        new Date("2026-05-27T20:00:00Z"),
      );
    } finally {
      client.release();
    }
    const row = await getStoryState(pool, CUSTOMER_A, "1001");
    expect(row?.status).toBe("pending");
    expect(row?.first_member_at?.toISOString()).toBe(
      "2026-05-27T20:00:00.000Z",
    );

    const jobs = await countStoryJobs(pool, CUSTOMER_A, "1001");
    // Stale archived-run jobs were deleted; new generation starts fresh.
    expect(jobs.count).toBe(0);
  });

  it("recordBaselineActivity seeds a ready LIVE periodic_report_state row", async () => {
    const client = await pool.connect();
    try {
      await recordBaselineActivity(client, CUSTOMER_B, "Asia/Seoul", [
        new Date("2026-05-27T08:00:00Z"),
      ]);
    } finally {
      client.release();
    }
    const { rows } = await pool.query<{
      status: string;
      last_event_at: Date | null;
    }>(
      `SELECT status, last_event_at FROM periodic_report_state
        WHERE customer_id = $1 AND period = 'LIVE'`,
      [CUSTOMER_B],
    );
    expect(rows[0]?.status).toBe("ready");
    expect(rows[0]?.last_event_at?.toISOString()).toBe(
      "2026-05-27T08:00:00.000Z",
    );
  });

  it("worker dispatches a dry-run job for the LIVE periodic state row", async () => {
    await runAnalysisJobTickOnce(pool);
    const { rows } = await pool.query<{ status: string; dry_run: boolean }>(
      `SELECT status, dry_run FROM periodic_report_job
        WHERE customer_id = $1 AND period = 'LIVE'`,
      [CUSTOMER_B],
    );
    expect(rows[0]?.status).toBe("done");
    expect(rows[0]?.dry_run).toBe(true);
  });

  it("worker tick does not let non-ready pending rows starve later ready-eligible pending rows (round-2 starvation regression)", async () => {
    // Seed BATCH_SIZE pending rows whose first/last_member_at are
    // NOW() so they are NOT ready-eligible, ordered to land at the
    // front of the (customer_id, story_id) pickup order. Then seed a
    // single pending row that IS ready-eligible. With the old SQL
    // (no readiness filter), the first BATCH_SIZE rows would fill the
    // LIMIT and the late row would never be inspected. With the SQL
    // readiness filter, only ready-eligible rows occupy slots so the
    // late row is promoted in the same tick.
    const customer = "00000000-0000-0000-0000-0000000000cc";
    await pool.query(
      `INSERT INTO customers (id, external_key, name)
       VALUES ($1, 'ck-c', 'C')
       ON CONFLICT (id) DO NOTHING`,
      [customer],
    );

    // 150 non-ready front rows.
    for (let i = 0; i < 150; i++) {
      await pool.query(
        `INSERT INTO story_analysis_state
           (customer_id, story_id, status, first_member_at, last_member_at)
         VALUES ($1, $2::bigint, 'pending', NOW(), NOW())
         ON CONFLICT (customer_id, story_id) DO NOTHING`,
        [customer, String(50_000 + i)],
      );
    }
    // One ready-eligible late row (story_id sorts after the front).
    await pool.query(
      `INSERT INTO story_analysis_state
         (customer_id, story_id, status, first_member_at, last_member_at)
       VALUES ($1, $2::bigint, 'pending',
               NOW() - INTERVAL '20 minutes',
               NOW() - INTERVAL '20 minutes')
       ON CONFLICT (customer_id, story_id) DO NOTHING`,
      [customer, "99999"],
    );

    await runAnalysisJobTickOnce(pool);

    const { rows } = await pool.query<{ status: string }>(
      `SELECT status FROM story_analysis_state
        WHERE customer_id = $1 AND story_id = 99999`,
      [customer],
    );
    expect(rows[0]?.status).toBe("ready");

    // None of the non-ready front rows should have been promoted.
    const { rows: frontReady } = await pool.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM story_analysis_state
        WHERE customer_id = $1 AND status = 'ready'
          AND story_id BETWEEN 50000 AND 50149`,
      [customer],
    );
    expect(Number(frontReady[0].count)).toBe(0);
  });

  it("worker tick does not let already-jobbed ready rows starve newer ready rows (round-2 starvation regression)", async () => {
    // Seed BATCH_SIZE+1 ready rows. Pre-create dry-run jobs for the
    // first BATCH_SIZE so they are already done. With the old SQL
    // (selected every ready row), the first BATCH_SIZE filled the
    // LIMIT slot and the late row never got a first job. With the
    // `NOT EXISTS` filter, only ready rows missing a job qualify.
    const customer = "00000000-0000-0000-0000-0000000000dd";
    await pool.query(
      `INSERT INTO customers (id, external_key, name)
       VALUES ($1, 'ck-d', 'D')
       ON CONFLICT (id) DO NOTHING`,
      [customer],
    );

    for (let i = 0; i < 150; i++) {
      const storyId = String(60_000 + i);
      await pool.query(
        `INSERT INTO story_analysis_state
           (customer_id, story_id, status, first_member_at, last_member_at,
            last_ready_at)
         VALUES ($1, $2::bigint, 'ready', NOW(), NOW(), NOW())
         ON CONFLICT (customer_id, story_id) DO NOTHING`,
        [customer, storyId],
      );
      await pool.query(
        `INSERT INTO story_analysis_job
           (customer_id, story_id, lang, model_name, model,
            status, generation, dry_run,
            processing_started_at, last_generated_at)
         VALUES ($1, $2::bigint,
                 COALESCE($3, 'ENGLISH'),
                 COALESCE($4, 'openai'),
                 COALESCE($5, 'gpt-4o'),
                 'done', 1, TRUE, NOW(), NOW())
         ON CONFLICT DO NOTHING`,
        [
          customer,
          storyId,
          process.env.ANALYSIS_DEFAULT_LANG ?? null,
          process.env.ANALYSIS_DEFAULT_MODEL_NAME ?? null,
          process.env.ANALYSIS_DEFAULT_MODEL ?? null,
        ],
      );
    }
    // One late ready row with NO job.
    await pool.query(
      `INSERT INTO story_analysis_state
         (customer_id, story_id, status, first_member_at, last_member_at,
          last_ready_at)
       VALUES ($1, $2::bigint, 'ready', NOW(), NOW(), NOW())
       ON CONFLICT (customer_id, story_id) DO NOTHING`,
      [customer, "98888"],
    );

    await runAnalysisJobTickOnce(pool);

    const { rows } = await pool.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM story_analysis_job
        WHERE customer_id = $1 AND story_id = 98888`,
      [customer],
    );
    expect(Number(rows[0].count)).toBe(1);
  });

  it("unarchiveStoryStateIfArchived resets archived rows to pending and deletes stale jobs (round-3 review item 1)", async () => {
    // The window-replace path archives a story (surviving=0), then a
    // later refresh-window/backfill re-inserts at least one version
    // (surviving>0). Without the unarchive helper, the row stayed
    // `archived` forever because `dirtyStoryStatesInRange` skips
    // archived rows and `maybeArchiveStoryState` is a no-op for
    // surviving>0.
    const customer = "00000000-0000-0000-0000-0000000000ee";
    await pool.query(
      `INSERT INTO customers (id, external_key, name)
       VALUES ($1, 'ck-e', 'E')
       ON CONFLICT (id) DO NOTHING`,
      [customer],
    );

    // Seed an archived row with an existing dry-run job from the
    // prior run.
    await pool.query(
      `INSERT INTO story_analysis_state
         (customer_id, story_id, status, first_member_at, last_member_at, last_ready_at)
       VALUES ($1, $2::bigint, 'archived',
               TIMESTAMPTZ '2026-05-20T10:00:00Z',
               TIMESTAMPTZ '2026-05-20T11:00:00Z',
               TIMESTAMPTZ '2026-05-20T12:00:00Z')`,
      [customer, "70001"],
    );
    await pool.query(
      `INSERT INTO story_analysis_job
         (customer_id, story_id, lang, model_name, model,
          status, generation, dry_run,
          processing_started_at, last_generated_at)
       VALUES ($1, $2::bigint,
               COALESCE($3, 'ENGLISH'),
               COALESCE($4, 'openai'),
               COALESCE($5, 'gpt-4o'),
               'done', 1, TRUE,
               TIMESTAMPTZ '2026-05-20T12:00:00Z',
               TIMESTAMPTZ '2026-05-20T12:00:00Z')`,
      [
        customer,
        "70001",
        process.env.ANALYSIS_DEFAULT_LANG ?? null,
        process.env.ANALYSIS_DEFAULT_MODEL_NAME ?? null,
        process.env.ANALYSIS_DEFAULT_MODEL ?? null,
      ],
    );

    const client = await pool.connect();
    try {
      await unarchiveStoryStateIfArchived(client, customer, "70001");
    } finally {
      client.release();
    }

    const row = await getStoryState(pool, customer, "70001");
    expect(row?.status).toBe("pending");
    // Decision 1: timestamps cleared to NULL so the next worker tick
    // / reconcile forward-patch re-derives readiness from the new
    // canonical version's `story.received_at`, instead of carrying
    // forward a hook-time NOW() that reconcile can never roll back.
    expect(row?.first_member_at).toBeNull();
    expect(row?.last_member_at).toBeNull();
    const jobs = await countStoryJobs(pool, customer, "70001");
    expect(jobs.count).toBe(0);
  });

  it("applyWindowReplaceStoryHook unarchives a previously archived story on re-insertion (round-3 review item 1)", async () => {
    // End-to-end version of the unarchive case through the hook the
    // route handler actually calls — refresh-window/backfill receives
    // `storyVersionSurvivors = [{ storyId, surviving > 0 }]` for a
    // story that had been archived in a prior window-replace.
    const customer = "00000000-0000-0000-0000-0000000000ef";
    await pool.query(
      `INSERT INTO customers (id, external_key, name)
       VALUES ($1, 'ck-f', 'F')
       ON CONFLICT (id) DO NOTHING`,
      [customer],
    );
    await pool.query(
      `INSERT INTO story_analysis_state
         (customer_id, story_id, status, first_member_at, last_member_at, last_ready_at)
       VALUES ($1, $2::bigint, 'archived',
               TIMESTAMPTZ '2026-05-20T10:00:00Z',
               TIMESTAMPTZ '2026-05-20T11:00:00Z',
               TIMESTAMPTZ '2026-05-20T12:00:00Z')`,
      [customer, "70002"],
    );

    await applyWindowReplaceStoryHook(pool, {
      customerId: customer,
      mutatedStoryIds: ["70002"],
      storyVersionSurvivors: [{ storyId: "70002", surviving: 1 }],
    });

    const row = await getStoryState(pool, customer, "70002");
    expect(row?.status).toBe("pending");
  });

  it("worker promotes pending DAILY/WEEKLY/MONTHLY rows whose settle window has elapsed (round-3 review item 2a)", async () => {
    // Reconcile seeds historical buckets as `pending`. Without the
    // worker's DAILY/WEEKLY/MONTHLY promotion SQL, those rows would
    // remain pending forever and never receive a Phase 0 dry-run job
    // — breaking the verification gate's "no stuck-pending state
    // rows" requirement.
    const customer = "00000000-0000-0000-0000-0000000000f0";
    await pool.query(
      `INSERT INTO customers (id, external_key, name)
       VALUES ($1, 'ck-g', 'G')
       ON CONFLICT (id) DO NOTHING`,
      [customer],
    );

    // Three historical buckets well past their settle windows, plus
    // one far-future DAILY bucket that must NOT yet be ready.
    await pool.query(
      `INSERT INTO periodic_report_state
         (customer_id, period, bucket_date, tz, status)
       VALUES
         ($1, 'DAILY',   DATE '2024-01-15', 'Asia/Seoul', 'pending'),
         ($1, 'WEEKLY',  DATE '2024-01-15', 'Asia/Seoul', 'pending'),
         ($1, 'MONTHLY', DATE '2024-01-01', 'Asia/Seoul', 'pending'),
         ($1, 'DAILY',   DATE '2099-12-31', 'Asia/Seoul', 'pending')`,
      [customer],
    );

    await runAnalysisJobTickOnce(pool);

    const { rows } = await pool.query<{
      period: string;
      bucket_date: string;
      status: string;
    }>(
      `SELECT period, bucket_date::text AS bucket_date, status
         FROM periodic_report_state
        WHERE customer_id = $1
        ORDER BY period, bucket_date`,
      [customer],
    );
    const settled = new Map(
      rows.map((r) => [`${r.period}|${r.bucket_date}`, r.status]),
    );
    // Old buckets must be ready + jobbed (one dry-run job each).
    expect(settled.get("DAILY|2024-01-15")).toBe("ready");
    expect(settled.get("WEEKLY|2024-01-15")).toBe("ready");
    expect(settled.get("MONTHLY|2024-01-01")).toBe("ready");
    // Far-future DAILY bucket is still well before its settle window,
    // so it must remain pending.
    expect(settled.get("DAILY|2099-12-31")).toBe("pending");

    const { rows: jobRows } = await pool.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count
         FROM periodic_report_job
        WHERE customer_id = $1
          AND period IN ('DAILY', 'WEEKLY', 'MONTHLY')`,
      [customer],
    );
    // One dry-run job per settled historical bucket (3 total).
    expect(Number(jobRows[0].count)).toBe(3);
  });

  it("recordBaselineActivity dirties an existing closed DAILY bucket with a done job (round-3 review item 2b)", async () => {
    // A baseline batch with old event_time landing inside an
    // already-done DAILY bucket must flip that bucket to `dirty` so
    // the verification gate can observe the dirty transition. Before
    // the round-3 fix, the hook only touched the LIVE row.
    const customer = "00000000-0000-0000-0000-0000000000f1";
    await pool.query(
      `INSERT INTO customers (id, external_key, name)
       VALUES ($1, 'ck-h', 'H')
       ON CONFLICT (id) DO NOTHING`,
      [customer],
    );

    const eventTime = new Date("2024-03-10T03:00:00Z");
    // 2024-03-10 03:00Z = 2024-03-10 12:00 KST → DAILY 2024-03-10.
    await pool.query(
      `INSERT INTO periodic_report_state
         (customer_id, period, bucket_date, tz, status, last_ready_at)
       VALUES ($1, 'DAILY', DATE '2024-03-10', 'Asia/Seoul', 'ready', NOW())`,
      [customer],
    );
    await pool.query(
      `INSERT INTO periodic_report_job
         (customer_id, period, bucket_date, tz,
          lang, model_name, model,
          status, generation, dry_run,
          processing_started_at, last_generated_at)
       VALUES ($1, 'DAILY', DATE '2024-03-10', 'Asia/Seoul',
               COALESCE($2, 'ENGLISH'),
               COALESCE($3, 'openai'),
               COALESCE($4, 'gpt-4o'),
               'done', 1, TRUE, NOW(), NOW())`,
      [
        customer,
        process.env.ANALYSIS_DEFAULT_LANG ?? null,
        process.env.ANALYSIS_DEFAULT_MODEL_NAME ?? null,
        process.env.ANALYSIS_DEFAULT_MODEL ?? null,
      ],
    );

    const client = await pool.connect();
    try {
      await recordBaselineActivity(client, customer, "Asia/Seoul", [eventTime]);
    } finally {
      client.release();
    }

    const { rows } = await pool.query<{
      status: string;
      last_event_at: Date | null;
    }>(
      `SELECT status, last_event_at FROM periodic_report_state
        WHERE customer_id = $1
          AND period = 'DAILY'
          AND bucket_date = DATE '2024-03-10'`,
      [customer],
    );
    expect(rows[0]?.status).toBe("dirty");
    expect(rows[0]?.last_event_at?.toISOString()).toBe(
      "2024-03-10T03:00:00.000Z",
    );
  });

  it("recordBaselineActivity dirties EVERY done bucket the batch overran (round-4 review item 3)", async () => {
    // Round 4: a single baseline batch can contain accepted events in
    // multiple already-done DAILY buckets. The old hook collapsed the
    // batch to a single max event_time and only dirtied one bucket
    // per period. The fix is to forward the full list of accepted
    // event_times so the hook can flip every overlapped bucket to
    // `dirty`.
    const customer = "00000000-0000-0000-0000-0000000000f3";
    await pool.query(
      `INSERT INTO customers (id, external_key, name)
       VALUES ($1, 'ck-j', 'J')
       ON CONFLICT (id) DO NOTHING`,
      [customer],
    );
    // Two ready DAILY buckets, each with a done dry-run job.
    await pool.query(
      `INSERT INTO periodic_report_state
         (customer_id, period, bucket_date, tz, status, last_ready_at)
       VALUES
         ($1, 'DAILY', DATE '2024-03-10', 'Asia/Seoul', 'ready', NOW()),
         ($1, 'DAILY', DATE '2024-03-12', 'Asia/Seoul', 'ready', NOW())`,
      [customer],
    );
    for (const bucketDate of ["2024-03-10", "2024-03-12"]) {
      await pool.query(
        `INSERT INTO periodic_report_job
           (customer_id, period, bucket_date, tz,
            lang, model_name, model,
            status, generation, dry_run,
            processing_started_at, last_generated_at)
         VALUES ($1, 'DAILY', $2::date, 'Asia/Seoul',
                 COALESCE($3, 'ENGLISH'),
                 COALESCE($4, 'openai'),
                 COALESCE($5, 'gpt-4o'),
                 'done', 1, TRUE, NOW(), NOW())`,
        [
          customer,
          bucketDate,
          process.env.ANALYSIS_DEFAULT_LANG ?? null,
          process.env.ANALYSIS_DEFAULT_MODEL_NAME ?? null,
          process.env.ANALYSIS_DEFAULT_MODEL ?? null,
        ],
      );
    }

    const earlier = new Date("2024-03-10T03:00:00Z"); // 2024-03-10 KST
    const later = new Date("2024-03-12T03:00:00Z"); // 2024-03-12 KST
    const client = await pool.connect();
    try {
      // Both events forwarded; hook must dirty BOTH done buckets, not
      // only the bucket containing the maximum event_time.
      await recordBaselineActivity(client, customer, "Asia/Seoul", [
        earlier,
        later,
      ]);
    } finally {
      client.release();
    }

    const { rows } = await pool.query<{
      bucket_date: string;
      status: string;
      last_event_at: Date | null;
    }>(
      `SELECT bucket_date::text AS bucket_date, status, last_event_at
         FROM periodic_report_state
        WHERE customer_id = $1 AND period = 'DAILY'
        ORDER BY bucket_date`,
      [customer],
    );
    const byDate = new Map(
      rows.map((r) => [
        r.bucket_date,
        { status: r.status, last: r.last_event_at },
      ]),
    );
    expect(byDate.get("2024-03-10")?.status).toBe("dirty");
    expect(byDate.get("2024-03-12")?.status).toBe("dirty");
    // Each bucket's last_event_at picks up only events that fell
    // INSIDE that bucket, not the global batch max.
    expect(byDate.get("2024-03-10")?.last?.toISOString()).toBe(
      "2024-03-10T03:00:00.000Z",
    );
    expect(byDate.get("2024-03-12")?.last?.toISOString()).toBe(
      "2024-03-12T03:00:00.000Z",
    );
  });

  it("dirtyPeriodicStatesOverlapping flips ready LIVE rows when the event window overlaps", async () => {
    const client = await pool.connect();
    try {
      await dirtyPeriodicStatesOverlapping(
        client,
        CUSTOMER_B,
        new Date("2026-05-27T07:00:00Z"),
        new Date("2026-05-27T09:00:00Z"),
      );
    } finally {
      client.release();
    }
    const { rows } = await pool.query<{ status: string }>(
      `SELECT status FROM periodic_report_state
        WHERE customer_id = $1 AND period = 'LIVE'`,
      [CUSTOMER_B],
    );
    expect(rows[0]?.status).toBe("dirty");
  });

  it("dirtyPeriodicStatesOverlapping flips DAILY/WEEKLY/MONTHLY by true bucket-range overlap (round-4 review item 2)", async () => {
    // Round 4: a MONTHLY row at bucket_date=2026-05-01 represents the
    // window [2026-05-01, 2026-06-01) in s.tz. A refresh envelope of
    // [2026-05-15, 2026-05-16) overlaps that window, so the row must
    // flip to `dirty` — even though `bucket_date` itself (2026-05-01)
    // is outside the envelope and `last_event_at` may not lie in the
    // envelope either. The earlier OR-bucket_date-in-range check
    // missed this case.
    const customer = "00000000-0000-0000-0000-0000000000f2";
    await pool.query(
      `INSERT INTO customers (id, external_key, name)
       VALUES ($1, 'ck-i', 'I')
       ON CONFLICT (id) DO NOTHING`,
      [customer],
    );
    // Three ready rows whose buckets contain 2026-05-15 12:00 Asia/Seoul:
    //   DAILY   2026-05-15 / WEEKLY 2026-05-11 / MONTHLY 2026-05-01
    // Plus one ready DAILY 2026-04-30 outside the envelope which must
    // remain ready.
    await pool.query(
      `INSERT INTO periodic_report_state
         (customer_id, period, bucket_date, tz, status, last_ready_at)
       VALUES
         ($1, 'DAILY',   DATE '2026-05-15', 'Asia/Seoul', 'ready', NOW()),
         ($1, 'WEEKLY',  DATE '2026-05-11', 'Asia/Seoul', 'ready', NOW()),
         ($1, 'MONTHLY', DATE '2026-05-01', 'Asia/Seoul', 'ready', NOW()),
         ($1, 'DAILY',   DATE '2026-04-30', 'Asia/Seoul', 'ready', NOW())`,
      [customer],
    );
    // Seed a done job for each so the dirty trigger fires (the helper
    // only dirties rows that have at least one processing/done job).
    for (const [period, bucketDate] of [
      ["DAILY", "2026-05-15"],
      ["WEEKLY", "2026-05-11"],
      ["MONTHLY", "2026-05-01"],
      ["DAILY", "2026-04-30"],
    ] as const) {
      await pool.query(
        `INSERT INTO periodic_report_job
           (customer_id, period, bucket_date, tz,
            lang, model_name, model,
            status, generation, dry_run,
            processing_started_at, last_generated_at)
         VALUES ($1, $2, $3::date, 'Asia/Seoul',
                 COALESCE($4, 'ENGLISH'),
                 COALESCE($5, 'openai'),
                 COALESCE($6, 'gpt-4o'),
                 'done', 1, TRUE, NOW(), NOW())`,
        [
          customer,
          period,
          bucketDate,
          process.env.ANALYSIS_DEFAULT_LANG ?? null,
          process.env.ANALYSIS_DEFAULT_MODEL_NAME ?? null,
          process.env.ANALYSIS_DEFAULT_MODEL ?? null,
        ],
      );
    }

    const client = await pool.connect();
    try {
      // Refresh envelope spans 2026-05-15 03:00Z..2026-05-16 03:00Z
      // (= roughly 2026-05-15 12:00..2026-05-16 12:00 in Asia/Seoul).
      // - DAILY   2026-05-15 window: 2026-05-15 00:00 KST..2026-05-16 00:00 KST → overlaps.
      // - WEEKLY  2026-05-11 window: 2026-05-11 00:00 KST..2026-05-18 00:00 KST → overlaps.
      // - MONTHLY 2026-05-01 window: 2026-05-01 00:00 KST..2026-06-01 00:00 KST → overlaps.
      // - DAILY   2026-04-30 window: 2026-04-30 00:00 KST..2026-05-01 00:00 KST → does NOT overlap.
      await dirtyPeriodicStatesOverlapping(
        client,
        customer,
        new Date("2026-05-15T03:00:00Z"),
        new Date("2026-05-16T03:00:00Z"),
      );
    } finally {
      client.release();
    }
    const { rows } = await pool.query<{
      period: string;
      bucket_date: string;
      status: string;
    }>(
      `SELECT period, bucket_date::text AS bucket_date, status
         FROM periodic_report_state
        WHERE customer_id = $1
        ORDER BY period, bucket_date`,
      [customer],
    );
    const byKey = new Map(
      rows.map((r) => [`${r.period}|${r.bucket_date}`, r.status]),
    );
    expect(byKey.get("DAILY|2026-05-15")).toBe("dirty");
    expect(byKey.get("WEEKLY|2026-05-11")).toBe("dirty");
    expect(byKey.get("MONTHLY|2026-05-01")).toBe("dirty");
    // Out-of-envelope DAILY must remain ready.
    expect(byKey.get("DAILY|2026-04-30")).toBe("ready");
  });
});
