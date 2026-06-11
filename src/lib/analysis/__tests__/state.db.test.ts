// RFC 0002 (#294) — state-transition + analysis-job-worker DB tests.
//
// Covers (a) the ingest-hook state mutations, (b) the worker tick that
// flips pending → ready and seeds real queued job rows, and (c) the
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

// Pin the eager language set to English-only so the Phase 3 seeding
// assertions below count a single real job per bucket. With the app default
// `DEFAULT_LOCALE=ko` the eager set would also seed a Korean job (#389
// Part A); that multi-language behavior is covered in
// `report-worker-eager.db.test.ts`. Set before the dynamic imports so the
// report-worker module reads it at init.
process.env.DEFAULT_LOCALE = "en";

const {
  dirtyPeriodicStatesOverlapping,
  dirtyStoryStatesInRange,
  maybeArchiveStoryState,
  recordBaselineActivity,
  recordCursorWatermark,
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

/**
 * Round-9 review item 2: `recordBaselineActivity` now consumes
 * `(eventTime, receivedAt)` tuples sourced from customer-DB
 * `baseline_event.received_at` so the auth-DB `last_event_received_at`
 * is a like-for-like comparison against `MAX(baseline_event.received_at)`
 * in reconcile. Tests that only exercise `event_time` semantics reuse
 * the event_time as the received_at; tests that probe the received_at
 * column itself pass explicit values.
 */
function asAcceptedEvents(
  eventTimes: readonly Date[],
): Array<{ eventTime: Date; receivedAt: Date }> {
  return eventTimes.map((t) => ({ eventTime: t, receivedAt: t }));
}

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

  it("worker tick promotes pending → ready once idle window elapses, then seeds a real queued job", async () => {
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

    // Phase 1 (#296): the tick seeds a real `dry_run=FALSE` queued job
    // (the LLM-calling tick lands separately via `tickStoryJobsOnce`).
    const { rows } = await pool.query(
      `SELECT status, dry_run FROM story_analysis_job
        WHERE customer_id = $1 AND story_id = 1001`,
      [CUSTOMER_A],
    );
    expect(rows[0].status).toBe("queued");
    expect(rows[0].dry_run).toBe(false);
  });

  it("late member after ready+done transitions the state to dirty and re-queues", async () => {
    // The "ready+done" transition path requires a prior `done` job —
    // Phase 1 leaves jobs in `queued` until `tickStoryJobsOnce` runs
    // (which would need a live aimer client). Stamp the job done
    // manually so this test exercises the state-transition logic in
    // isolation from the worker pickup path.
    await pool.query(
      `UPDATE story_analysis_job
          SET status = 'done', last_generated_at = NOW()
        WHERE customer_id = $1 AND story_id = 1001`,
      [CUSTOMER_A],
    );
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
    // Stamp the existing 1001 job as done so the dirty flip can fire
    // (Phase 1 leaves jobs in `queued` after the dispatcher tick).
    await pool.query(
      `UPDATE story_analysis_job
          SET status = 'done', last_generated_at = NOW()
        WHERE customer_id = $1 AND story_id = 1001`,
      [CUSTOMER_A],
    );
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
      await dirtyStoryStatesInRange(client, CUSTOMER_A, [
        { storyId: "1001", lastMemberAt: null },
        { storyId: "2002", lastMemberAt: null },
      ]);
    } finally {
      client.release();
    }
    const fresh = await getStoryState(pool, CUSTOMER_A, "2002");
    expect(fresh?.status).toBe("pending");
    const ready = await getStoryState(pool, CUSTOMER_A, "1001");
    expect(ready?.status).toBe("dirty");
  });

  it("dirtyStoryStatesInRange forward-patches last_member_at along with the dirty flip (round-11 review item 2)", async () => {
    // Round-11 review item 2: without the forward-patch, reconcile
    // would later observe the newer customer-DB `story.received_at`,
    // advance `last_member_at`, and flip the already-processed row
    // back to `dirty` a second time. Synchronizing the column in the
    // same UPDATE that flips the status makes the reconcile pass a
    // no-op for the canonical mutation.
    //
    // The prior "late member after ready+done" test set
    // `last_member_at = NOW()` via `recordStoryMemberArrival(new Date())`,
    // so we anchor the forward-patch target one hour past wall-clock
    // NOW() to make the GREATEST() comparison deterministic regardless
    // of the test's wall-clock start time. A fixed literal like
    // 2026-05-27T13:45:00Z would fail any time the suite runs after
    // 13:45 UTC because the row's stored `last_member_at` would
    // already exceed the literal and GREATEST would keep the stored
    // value.
    const storyId = "1001";
    const newLastMemberAt = new Date(Date.now() + 60 * 60 * 1000);
    // Stamp the existing job as done so the dirty flip can fire (the
    // forward-patch lives in the same UPDATE as the status flip).
    await pool.query(
      `UPDATE story_analysis_job
          SET status = 'done', last_generated_at = NOW()
        WHERE customer_id = $1 AND story_id = 1001`,
      [CUSTOMER_A],
    );
    const client = await pool.connect();
    try {
      await dirtyStoryStatesInRange(client, CUSTOMER_A, [
        { storyId, lastMemberAt: newLastMemberAt },
      ]);
    } finally {
      client.release();
    }
    const row = await getStoryState(pool, CUSTOMER_A, storyId);
    expect(row?.status).toBe("dirty");
    expect(row?.last_member_at?.toISOString()).toBe(
      newLastMemberAt.toISOString(),
    );

    // Re-calling with a stale (earlier) timestamp must not roll the
    // column backwards — GREATEST guards the forward-only semantic.
    const stale = new Date("2024-01-01T00:00:00Z");
    const client2 = await pool.connect();
    try {
      await dirtyStoryStatesInRange(client2, CUSTOMER_A, [
        { storyId, lastMemberAt: stale },
      ]);
    } finally {
      client2.release();
    }
    const after = await getStoryState(pool, CUSTOMER_A, storyId);
    expect(after?.last_member_at?.toISOString()).toBe(
      newLastMemberAt.toISOString(),
    );
  });

  it("dirtyPeriodicStatesOverlapping resyncs event_count along with the dirty flip (round-11 review item 2)", async () => {
    // Round-11 review item 2 — periodic delete-only envelope case:
    // without re-syncing `event_count` in the same UPDATE that flips
    // status to `dirty`, reconcile would later observe a strict
    // decrease (`current < stored`) and flip the bucket dirty a
    // second time after the worker has already processed the first
    // dirty cycle. Passing the post-commit count via the new
    // `eventCountByBucket` parameter closes the gap.
    const customer = "00000000-0000-0000-0000-0000000000c0";
    await pool.query(
      `INSERT INTO customers (id, external_key, name)
       VALUES ($1, 'ck-eventcount', 'EventCount')
       ON CONFLICT (id) DO NOTHING`,
      [customer],
    );
    await pool.query(
      `INSERT INTO periodic_report_state
         (subject_id, period, bucket_date, tz, status,
          event_count, last_ready_at)
       VALUES ($1, 'DAILY', DATE '2026-05-20', 'Asia/Seoul', 'ready',
               10, NOW())
       ON CONFLICT DO NOTHING`,
      [customer],
    );
    await pool.query(
      `INSERT INTO periodic_report_job
         (subject_id, period, bucket_date, tz,
          lang, model_name, model,
          status, generation, dry_run,
          processing_started_at, last_generated_at)
       VALUES ($1, 'DAILY', DATE '2026-05-20', 'Asia/Seoul',
               'ENGLISH', 'openai', 'gpt-4o',
               'done', 1, TRUE, NOW(), NOW())
       ON CONFLICT DO NOTHING`,
      [customer],
    );

    const counts = new Map<string, number>([["DAILY|2026-05-20", 3]]);
    const client = await pool.connect();
    try {
      // Envelope window contains 2026-05-20 KST.
      await dirtyPeriodicStatesOverlapping(
        client,
        customer,
        new Date("2026-05-19T15:00:00Z"),
        new Date("2026-05-20T15:00:00Z"),
        counts,
      );
    } finally {
      client.release();
    }
    const { rows } = await pool.query<{
      status: string;
      event_count: string;
    }>(
      `SELECT status, event_count::text AS event_count
         FROM periodic_report_state
        WHERE subject_id = $1
          AND period      = 'DAILY'
          AND bucket_date = DATE '2026-05-20'
          AND tz          = 'Asia/Seoul'`,
      [customer],
    );
    expect(rows[0]?.status).toBe("dirty");
    expect(Number(rows[0]?.event_count)).toBe(3);
  });

  it("dirtyStoryStatesInRange forward-patches pending rows without flipping status (round-14 review item 1)", async () => {
    // Round-14 review item 1: a refresh-window / backfill that mutates
    // a story still in `pending` must update `last_member_at` so the
    // worker's idle-window readiness rule does not promote the row on
    // the stale timestamp before the 15-minute reconcile pass runs.
    // Status stays `pending` (no prior generation to invalidate) and
    // `updated_at` advances so observers can see the change.
    const storyId = "3003";
    const initial = new Date("2026-05-27T11:00:00Z");
    const client = await pool.connect();
    try {
      await recordStoryMemberArrival(client, CUSTOMER_A, storyId, initial);
    } finally {
      client.release();
    }
    const { rows: beforeRows } = await pool.query<{ updated_at: Date }>(
      `SELECT updated_at FROM story_analysis_state
        WHERE customer_id = $1 AND story_id = $2::bigint`,
      [CUSTOMER_A, storyId],
    );
    const beforeUpdatedAt = beforeRows[0]?.updated_at;
    // Make sure the next NOW() is strictly greater than the prior row's
    // updated_at on Postgres clock-tick granularity.
    await new Promise((resolve) => setTimeout(resolve, 10));

    const newLastMemberAt = new Date("2026-05-27T13:45:00Z");
    const client2 = await pool.connect();
    try {
      await dirtyStoryStatesInRange(client2, CUSTOMER_A, [
        { storyId, lastMemberAt: newLastMemberAt },
      ]);
    } finally {
      client2.release();
    }
    const { rows } = await pool.query<{
      status: string;
      last_member_at: Date | null;
      updated_at: Date;
    }>(
      `SELECT status, last_member_at, updated_at
         FROM story_analysis_state
        WHERE customer_id = $1 AND story_id = $2::bigint`,
      [CUSTOMER_A, storyId],
    );
    expect(rows[0]?.status).toBe("pending");
    expect(rows[0]?.last_member_at?.toISOString()).toBe(
      newLastMemberAt.toISOString(),
    );
    expect(rows[0]?.updated_at.getTime()).toBeGreaterThan(
      beforeUpdatedAt?.getTime() ?? 0,
    );
  });

  it("dirtyPeriodicStatesOverlapping forward-patches pending buckets without flipping status (round-14 review item 1)", async () => {
    // Round-14 review item 1: a pending DAILY/WEEKLY/MONTHLY bucket
    // overlapped by a successful refresh-window / backfill must have
    // its source aggregates resynced AND `updated_at = NOW()` stamped
    // so the worker's quiet-window gate does not promote the bucket
    // inside what should be a fresh quiet window. Status stays
    // `pending` (no prior generation to invalidate).
    const customer = "00000000-0000-0000-0000-0000000000c1";
    await pool.query(
      `INSERT INTO customers (id, external_key, name)
       VALUES ($1, 'ck-pendingbucket', 'PendingBucket')
       ON CONFLICT (id) DO NOTHING`,
      [customer],
    );
    // Insert a pending DAILY bucket with stale event_count and an
    // `updated_at` back-dated past the quiet window threshold.
    await pool.query(
      `INSERT INTO periodic_report_state
         (subject_id, period, bucket_date, tz, status,
          event_count, updated_at)
       VALUES ($1, 'DAILY', DATE '2026-05-21', 'Asia/Seoul', 'pending',
               7, NOW() - INTERVAL '2 hours')
       ON CONFLICT DO NOTHING`,
      [customer],
    );
    const { rows: beforeRows } = await pool.query<{ updated_at: Date }>(
      `SELECT updated_at FROM periodic_report_state
        WHERE subject_id = $1 AND period = 'DAILY'
          AND bucket_date = DATE '2026-05-21' AND tz = 'Asia/Seoul'`,
      [customer],
    );
    const beforeUpdatedAt = beforeRows[0]?.updated_at;

    const counts = new Map<string, number>([["DAILY|2026-05-21", 4]]);
    const client = await pool.connect();
    try {
      await dirtyPeriodicStatesOverlapping(
        client,
        customer,
        new Date("2026-05-20T15:00:00Z"),
        new Date("2026-05-21T15:00:00Z"),
        counts,
      );
    } finally {
      client.release();
    }
    const { rows } = await pool.query<{
      status: string;
      event_count: string;
      updated_at: Date;
    }>(
      `SELECT status, event_count::text AS event_count, updated_at
         FROM periodic_report_state
        WHERE subject_id = $1
          AND period      = 'DAILY'
          AND bucket_date = DATE '2026-05-21'
          AND tz          = 'Asia/Seoul'`,
      [customer],
    );
    expect(rows[0]?.status).toBe("pending");
    expect(Number(rows[0]?.event_count)).toBe(4);
    expect(rows[0]?.updated_at.getTime()).toBeGreaterThan(
      beforeUpdatedAt?.getTime() ?? 0,
    );
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

  it("unarchive in place: re-ingest after archive resets to pending, clears all source timestamps, and deletes stale jobs (round-5 review item 1)", async () => {
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
    // Decision 1: archived → pending clears ALL source timestamps so
    // the worker tick / reconcile pass re-derives readiness from the
    // canonical customer-DB `story.received_at`. Writing the hook-time
    // `memberArrivedAt` here would let the archived run's stale
    // `last_member_at` survive when it is newer than the canonical
    // value, because reconcile's forward-patch path cannot roll it
    // back.
    expect(row?.first_member_at).toBeNull();
    expect(row?.last_member_at).toBeNull();

    const jobs = await countStoryJobs(pool, CUSTOMER_A, "1001");
    // Stale archived-run jobs were deleted; new generation starts fresh.
    expect(jobs.count).toBe(0);
  });

  // `recordBaselineActivity` filters the input events through the SQL
  // predicate `t >= NOW() - INTERVAL '24 hours' AND t < NOW()` (state.ts
  // round-20 review item 1), where NOW() is the live database clock —
  // the test file does not mock the time seam. A fixed fixture date
  // therefore falls outside the rolling LIVE window once enough
  // wall-clock time elapses, which is exactly how this test broke when
  // CI ran ~28h after the original 2026-05-27T08:00:00Z fixture. Stamp
  // the event one hour before the real `Date.now()` so the assertion
  // round-trips against the same instant the worker just observed.
  it("recordBaselineActivity seeds a ready LIVE periodic_report_state row", async () => {
    const eventTime = new Date(Date.now() - 60 * 60 * 1000);
    const client = await pool.connect();
    try {
      await recordBaselineActivity(
        client,
        CUSTOMER_B,
        "Asia/Seoul",
        asAcceptedEvents([eventTime]),
      );
    } finally {
      client.release();
    }
    const { rows } = await pool.query<{
      status: string;
      last_event_at: Date | null;
    }>(
      `SELECT status, last_event_at FROM periodic_report_state
        WHERE subject_id = $1 AND period = 'LIVE'`,
      [CUSTOMER_B],
    );
    expect(rows[0]?.status).toBe("ready");
    expect(rows[0]?.last_event_at?.toISOString()).toBe(eventTime.toISOString());
  });

  it("worker seeds a real queued job for the LIVE periodic state row", async () => {
    // Phase 2 (#297): LIVE/DAILY now get real (non-dry-run) jobs. The
    // LLM dispatch in the same tick attempts the job but cannot resolve a
    // customer pool in this auth-only test env, so it stays `queued`.
    await runAnalysisJobTickOnce(pool);
    const { rows } = await pool.query<{ status: string; dry_run: boolean }>(
      `SELECT status, dry_run FROM periodic_report_job
        WHERE subject_id = $1 AND period = 'LIVE'`,
      [CUSTOMER_B],
    );
    expect(rows[0]?.status).toBe("queued");
    expect(rows[0]?.dry_run).toBe(false);
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

  it("unarchiveStoryStateIfArchived clears denormalized priority/scores (WS3 #392)", async () => {
    // A reinserted historical story starts a fresh narrative, so the prior
    // generation's denormalized canonical priority/scores no longer apply —
    // they must be cleared to NULL (the Threat Stories list excludes
    // NULL-priority rows until the next result finalizes).
    const customer = "00000000-0000-0000-0000-0000000000e1";
    await pool.query(
      `INSERT INTO customers (id, external_key, name)
       VALUES ($1, 'ck-e1', 'E1')
       ON CONFLICT (id) DO NOTHING`,
      [customer],
    );
    await pool.query(
      `INSERT INTO story_analysis_state
         (customer_id, story_id, status, priority_tier, severity_score,
          likelihood_score, last_ready_at)
       VALUES ($1, $2::bigint, 'archived', 'CRITICAL', 0.9, 0.8,
               TIMESTAMPTZ '2026-05-20T12:00:00Z')`,
      [customer, "70010"],
    );

    const client = await pool.connect();
    try {
      await unarchiveStoryStateIfArchived(client, customer, "70010");
    } finally {
      client.release();
    }

    const row = await pool.query<{
      status: string;
      priority_tier: string | null;
      severity_score: number | null;
      likelihood_score: number | null;
    }>(
      `SELECT status, priority_tier, severity_score, likelihood_score
         FROM story_analysis_state
        WHERE customer_id = $1 AND story_id = $2::bigint`,
      [customer, "70010"],
    );
    expect(row.rows[0].status).toBe("pending");
    expect(row.rows[0].priority_tier).toBeNull();
    expect(row.rows[0].severity_score).toBeNull();
    expect(row.rows[0].likelihood_score).toBeNull();
  });

  it("recordStoryMemberArrival clears denormalized priority/scores on archived → pending (WS3 #392)", async () => {
    // The member-arrival hook also unarchives in place (archived → pending);
    // it must clear the denormalized columns on that branch, while leaving
    // them untouched on non-archive branches.
    const customer = "00000000-0000-0000-0000-0000000000e2";
    await pool.query(
      `INSERT INTO customers (id, external_key, name)
       VALUES ($1, 'ck-e2', 'E2')
       ON CONFLICT (id) DO NOTHING`,
      [customer],
    );
    await pool.query(
      `INSERT INTO story_analysis_state
         (customer_id, story_id, status, priority_tier, severity_score,
          likelihood_score)
       VALUES ($1, $2::bigint, 'archived', 'HIGH', 0.7, 0.6)`,
      [customer, "70011"],
    );

    const client = await pool.connect();
    try {
      await recordStoryMemberArrival(client, customer, "70011", new Date());
    } finally {
      client.release();
    }

    const row = await pool.query<{
      status: string;
      priority_tier: string | null;
      severity_score: number | null;
      likelihood_score: number | null;
    }>(
      `SELECT status, priority_tier, severity_score, likelihood_score
         FROM story_analysis_state
        WHERE customer_id = $1 AND story_id = $2::bigint`,
      [customer, "70011"],
    );
    expect(row.rows[0].status).toBe("pending");
    expect(row.rows[0].priority_tier).toBeNull();
    expect(row.rows[0].severity_score).toBeNull();
    expect(row.rows[0].likelihood_score).toBeNull();
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
      storyVersionSurvivors: [
        {
          storyId: "70002",
          surviving: 1,
          lastReceivedAt: new Date("2026-05-27T10:00:00Z"),
        },
      ],
    });

    const row = await getStoryState(pool, customer, "70002");
    expect(row?.status).toBe("pending");
  });

  it("worker promotes pending DAILY/WEEKLY/MONTHLY rows whose settle window has elapsed (round-3 review item 2a)", async () => {
    // Reconcile seeds historical buckets as `pending`. Without the
    // worker's DAILY/WEEKLY/MONTHLY promotion SQL, those rows would
    // remain pending forever and never receive a queued report job —
    // breaking the verification gate's "no stuck-pending state rows"
    // requirement.
    const customer = "00000000-0000-0000-0000-0000000000f0";
    await pool.query(
      `INSERT INTO customers (id, external_key, name)
       VALUES ($1, 'ck-g', 'G')
       ON CONFLICT (id) DO NOTHING`,
      [customer],
    );

    // Three historical buckets well past their settle windows, plus
    // one far-future DAILY bucket that must NOT yet be ready. Back-date
    // `updated_at` past the idle-quiet window so the quiet-window gate
    // (round-7 review item 1) does not hold these rows in `pending`.
    await pool.query(
      `INSERT INTO periodic_report_state
         (subject_id, period, bucket_date, tz, status, updated_at)
       VALUES
         ($1, 'DAILY',   DATE '2024-01-15', 'Asia/Seoul', 'pending',
          NOW() - INTERVAL '2 hours'),
         ($1, 'WEEKLY',  DATE '2024-01-15', 'Asia/Seoul', 'pending',
          NOW() - INTERVAL '2 hours'),
         ($1, 'MONTHLY', DATE '2024-01-01', 'Asia/Seoul', 'pending',
          NOW() - INTERVAL '2 hours'),
         ($1, 'DAILY',   DATE '2099-12-31', 'Asia/Seoul', 'pending',
          NOW() - INTERVAL '2 hours')`,
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
        WHERE subject_id = $1
        ORDER BY period, bucket_date`,
      [customer],
    );
    const settled = new Map(
      rows.map((r) => [`${r.period}|${r.bucket_date}`, r.status]),
    );
    // Old buckets must be ready + jobbed (one real queued job each).
    expect(settled.get("DAILY|2024-01-15")).toBe("ready");
    expect(settled.get("WEEKLY|2024-01-15")).toBe("ready");
    expect(settled.get("MONTHLY|2024-01-01")).toBe("ready");
    // Far-future DAILY bucket is still well before its settle window,
    // so it must remain pending.
    expect(settled.get("DAILY|2099-12-31")).toBe("pending");

    // Phase 3 (#298): all three closed periods are now job-seeded. Each
    // ready DAILY/WEEKLY/MONTHLY bucket gets exactly one real (non-dry-run)
    // queued job for the default variant once the period filter is lifted.
    const { rows: jobRows } = await pool.query<{
      period: string;
      status: string;
      dry_run: boolean;
    }>(
      `SELECT period, status, dry_run
         FROM periodic_report_job
        WHERE subject_id = $1
          AND period IN ('DAILY', 'WEEKLY', 'MONTHLY')
        ORDER BY period`,
      [customer],
    );
    expect(jobRows).toHaveLength(3);
    expect(jobRows.map((r) => r.period)).toEqual([
      "DAILY",
      "MONTHLY",
      "WEEKLY",
    ]);
    expect(jobRows.every((r) => r.dry_run === false)).toBe(true);
  });

  it("worker holds a pending bucket with recent ingest activity in pending until the quiet window elapses (round-7 review item 1)", async () => {
    // RFC 0002 §"Periodic report readiness" requires the quiet-window
    // signal in addition to bucket-end + settle. A historical bucket
    // seeded or forward-patched by a just-finished reconcile/backfill
    // must NOT be promoted and job-seeded while the row's
    // `updated_at` is still inside the quiet window.
    const customer = "00000000-0000-0000-0000-0000000000f5";
    await pool.query(
      `INSERT INTO customers (id, external_key, name)
       VALUES ($1, 'ck-q', 'Q')
       ON CONFLICT (id) DO NOTHING`,
      [customer],
    );

    // A historical DAILY bucket past its settle window but with
    // updated_at = NOW() (simulating a backfill that just touched it).
    await pool.query(
      `INSERT INTO periodic_report_state
         (subject_id, period, bucket_date, tz, status, updated_at)
       VALUES ($1, 'DAILY', DATE '2024-01-15', 'Asia/Seoul', 'pending',
               NOW())`,
      [customer],
    );

    await runAnalysisJobTickOnce(pool);

    const { rows } = await pool.query<{ status: string }>(
      `SELECT status FROM periodic_report_state
        WHERE subject_id = $1 AND period = 'DAILY'
          AND bucket_date = DATE '2024-01-15'`,
      [customer],
    );
    // Quiet-window gate holds it in pending.
    expect(rows[0]?.status).toBe("pending");

    // Back-date past the quiet window and the same tick should now
    // promote it.
    await pool.query(
      `UPDATE periodic_report_state
          SET updated_at = NOW() - INTERVAL '2 hours'
        WHERE subject_id = $1 AND period = 'DAILY'
          AND bucket_date = DATE '2024-01-15'`,
      [customer],
    );
    await runAnalysisJobTickOnce(pool);
    const { rows: after } = await pool.query<{ status: string }>(
      `SELECT status FROM periodic_report_state
        WHERE subject_id = $1 AND period = 'DAILY'
          AND bucket_date = DATE '2024-01-15'`,
      [customer],
    );
    expect(after[0]?.status).toBe("ready");
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
         (subject_id, period, bucket_date, tz, status, last_ready_at)
       VALUES ($1, 'DAILY', DATE '2024-03-10', 'Asia/Seoul', 'ready', NOW())`,
      [customer],
    );
    await pool.query(
      `INSERT INTO periodic_report_job
         (subject_id, period, bucket_date, tz,
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
      await recordBaselineActivity(
        client,
        customer,
        "Asia/Seoul",
        asAcceptedEvents([eventTime]),
      );
    } finally {
      client.release();
    }

    const { rows } = await pool.query<{
      status: string;
      last_event_at: Date | null;
    }>(
      `SELECT status, last_event_at FROM periodic_report_state
        WHERE subject_id = $1
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
         (subject_id, period, bucket_date, tz, status, last_ready_at)
       VALUES
         ($1, 'DAILY', DATE '2024-03-10', 'Asia/Seoul', 'ready', NOW()),
         ($1, 'DAILY', DATE '2024-03-12', 'Asia/Seoul', 'ready', NOW())`,
      [customer],
    );
    for (const bucketDate of ["2024-03-10", "2024-03-12"]) {
      await pool.query(
        `INSERT INTO periodic_report_job
           (subject_id, period, bucket_date, tz,
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
      await recordBaselineActivity(
        client,
        customer,
        "Asia/Seoul",
        asAcceptedEvents([earlier, later]),
      );
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
        WHERE subject_id = $1 AND period = 'DAILY'
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

  it("dirtyPeriodicStatesOverlapping flips ready LIVE rows when the hook reports baselineTouched (round-18 review item 1)", async () => {
    // Round-18: the LIVE branch no longer reads `s.last_event_at` to
    // match against the envelope (that mixed stale stored values with
    // a fresh source-time envelope). Instead the hook supplies a
    // source-time-aligned `baselineTouched` flag computed in the
    // customer DB post-commit. Passing it directly here simulates the
    // hook for the unit-level test.
    //
    // The LIVE ready→dirty flip only fires when an analyzed (done /
    // processing) job exists for the variant (state.ts). Phase 2 (#297)
    // changed the LIVE worker to leave a real *queued* job rather than a
    // dry-run *done* one, so seed a done job here rather than leaning on
    // the dispatch tick from an earlier test in the file.
    await pool.query(
      `INSERT INTO periodic_report_job
         (subject_id, period, bucket_date, tz,
          lang, model_name, model,
          status, generation, dry_run,
          processing_started_at, last_generated_at)
       VALUES ($1, 'LIVE', DATE '1970-01-01', 'Asia/Seoul',
               COALESCE($2, 'ENGLISH'),
               COALESCE($3, 'openai'),
               COALESCE($4, 'gpt-4o'),
               'done', 1, FALSE, NOW(), NOW())
       ON CONFLICT (subject_id, period, bucket_date, tz, lang, model_name, model)
       DO UPDATE SET status = 'done'`,
      [
        CUSTOMER_B,
        process.env.ANALYSIS_DEFAULT_LANG ?? null,
        process.env.ANALYSIS_DEFAULT_MODEL_NAME ?? null,
        process.env.ANALYSIS_DEFAULT_MODEL ?? null,
      ],
    );
    const client = await pool.connect();
    try {
      await dirtyPeriodicStatesOverlapping(
        client,
        CUSTOMER_B,
        new Date("2026-05-27T07:00:00Z"),
        new Date("2026-05-27T09:00:00Z"),
        undefined,
        undefined,
        {
          baselineTouched: true,
          storyTouched: false,
          baselineMaxEventAt: new Date("2026-05-27T08:30:00Z"),
          baselineMaxReceivedAt: new Date("2026-05-27T08:30:01Z"),
          storyMaxReceivedAt: null,
        },
      );
    } finally {
      client.release();
    }
    const { rows } = await pool.query<{ status: string }>(
      `SELECT status FROM periodic_report_state
        WHERE subject_id = $1 AND period = 'LIVE'`,
      [CUSTOMER_B],
    );
    expect(rows[0]?.status).toBe("dirty");
  });

  it("dirtyPeriodicStatesOverlapping flips a story-only LIVE row when the hook reports storyTouched (round-18 review item 1)", async () => {
    // Round-17 introduced the story-side LIVE dirty path but used
    // `s.last_story_received_at` (commit-time) against a source-time
    // envelope. Round-18 replaces that with a source-time
    // `storyTouched` flag computed by the hook (latest-version stories
    // whose `[time_window_start, time_window_end]` overlaps BOTH the
    // rolling LIVE window AND the envelope). Passing `storyTouched`
    // directly here verifies the branch still flips a story-only
    // LIVE row to `dirty`, while the round-18 historical-backfill
    // regression test below verifies that a `false` flag keeps it
    // ready.
    const customer = "00000000-0000-0000-0000-000000000117";
    await pool.query(
      `INSERT INTO customers (id, external_key, name)
       VALUES ($1, 'ck-livestory-r17', 'LiveStoryR17State')
       ON CONFLICT (id) DO NOTHING`,
      [customer],
    );
    await pool.query(
      `INSERT INTO periodic_report_state
         (subject_id, period, bucket_date, tz, status,
          last_event_at, last_story_received_at, last_ready_at)
       VALUES ($1, 'LIVE', DATE '1970-01-01', 'Asia/Seoul', 'ready',
               NULL, $2::timestamptz, NOW())
       ON CONFLICT DO NOTHING`,
      [customer, "2026-05-27T08:00:00Z"],
    );
    await pool.query(
      `INSERT INTO periodic_report_job
         (subject_id, period, bucket_date, tz,
          lang, model_name, model,
          status, generation, dry_run,
          processing_started_at, last_generated_at)
       VALUES ($1, 'LIVE', DATE '1970-01-01', 'Asia/Seoul',
               COALESCE($2, 'ENGLISH'),
               COALESCE($3, 'openai'),
               COALESCE($4, 'gpt-4o'),
               'done', 1, TRUE, NOW(), NOW())
       ON CONFLICT DO NOTHING`,
      [
        customer,
        process.env.ANALYSIS_DEFAULT_LANG ?? null,
        process.env.ANALYSIS_DEFAULT_MODEL_NAME ?? null,
        process.env.ANALYSIS_DEFAULT_MODEL ?? null,
      ],
    );

    const client = await pool.connect();
    try {
      await dirtyPeriodicStatesOverlapping(
        client,
        customer,
        new Date("2026-05-27T07:00:00Z"),
        new Date("2026-05-27T09:00:00Z"),
        undefined,
        undefined,
        {
          baselineTouched: false,
          storyTouched: true,
          baselineMaxEventAt: null,
          baselineMaxReceivedAt: null,
          storyMaxReceivedAt: new Date("2026-05-27T08:45:00Z"),
        },
      );
    } finally {
      client.release();
    }
    const { rows } = await pool.query<{
      status: string;
      last_story_received_at: Date | null;
    }>(
      `SELECT status, last_story_received_at FROM periodic_report_state
        WHERE subject_id = $1 AND period = 'LIVE'`,
      [customer],
    );
    expect(rows[0]?.status).toBe("dirty");
    // Forward-patch the LIVE row's `last_story_received_at` to the
    // hook-supplied post-commit value (here `2026-05-27T08:45:00Z`).
    expect(rows[0]?.last_story_received_at?.toISOString()).toBe(
      "2026-05-27T08:45:00.000Z",
    );
  });

  it("dirtyPeriodicStatesOverlapping does not flip LIVE when the hook reports neither flag (round-18 review item 1)", async () => {
    // Round-18 regression: a historical refresh-window / backfill
    // envelope that does not touch any rolling-LIVE source data must
    // leave the LIVE row in `ready`. The hook computes
    // `baselineTouched` / `storyTouched` against the rolling LIVE
    // window AND the envelope, so a historical envelope produces
    // both flags `false`. Passing both flags `false` here verifies
    // the LIVE branch does not fire.
    const customer = "00000000-0000-0000-0000-000000000118";
    await pool.query(
      `INSERT INTO customers (id, external_key, name)
       VALUES ($1, 'ck-livestory-r18', 'LiveStoryR18State')
       ON CONFLICT (id) DO NOTHING`,
      [customer],
    );
    await pool.query(
      `INSERT INTO periodic_report_state
         (subject_id, period, bucket_date, tz, status,
          last_event_at, last_event_received_at,
          last_story_received_at, last_ready_at)
       VALUES ($1, 'LIVE', DATE '1970-01-01', 'Asia/Seoul', 'ready',
               $2::timestamptz, $2::timestamptz, $2::timestamptz, NOW())
       ON CONFLICT DO NOTHING`,
      [customer, "2026-05-27T08:00:00Z"],
    );
    await pool.query(
      `INSERT INTO periodic_report_job
         (subject_id, period, bucket_date, tz,
          lang, model_name, model,
          status, generation, dry_run,
          processing_started_at, last_generated_at)
       VALUES ($1, 'LIVE', DATE '1970-01-01', 'Asia/Seoul',
               COALESCE($2, 'ENGLISH'),
               COALESCE($3, 'openai'),
               COALESCE($4, 'gpt-4o'),
               'done', 1, TRUE, NOW(), NOW())
       ON CONFLICT DO NOTHING`,
      [
        customer,
        process.env.ANALYSIS_DEFAULT_LANG ?? null,
        process.env.ANALYSIS_DEFAULT_MODEL_NAME ?? null,
        process.env.ANALYSIS_DEFAULT_MODEL ?? null,
      ],
    );

    const client = await pool.connect();
    try {
      // Historical envelope spanning years-old source dates: no
      // overlap with the rolling LIVE window. Hook flags both false.
      await dirtyPeriodicStatesOverlapping(
        client,
        customer,
        new Date("2020-01-01T00:00:00Z"),
        new Date("2020-01-02T00:00:00Z"),
        undefined,
        undefined,
        {
          baselineTouched: false,
          storyTouched: false,
          baselineMaxEventAt: null,
          baselineMaxReceivedAt: null,
          storyMaxReceivedAt: null,
        },
      );
    } finally {
      client.release();
    }
    const { rows } = await pool.query<{ status: string }>(
      `SELECT status FROM periodic_report_state
        WHERE subject_id = $1 AND period = 'LIVE'`,
      [customer],
    );
    expect(rows[0]?.status).toBe("ready");
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
         (subject_id, period, bucket_date, tz, status, last_ready_at)
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
           (subject_id, period, bucket_date, tz,
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
        WHERE subject_id = $1
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

  it("recordBaselineActivity does not seed a LIVE row when no event_time is in the trailing 24h (round-8 review item 3)", async () => {
    // Issue #294 decision 4 + round-8 review item 3: LIVE bucket is
    // the rolling current state. A baseline batch consisting only of
    // historical event_times (e.g. a backfill replay) must NOT seed
    // a LIVE row — those events seed DAILY/WEEKLY/MONTHLY buckets
    // via the reconcile scan instead.
    const customer = "00000000-0000-0000-0000-0000000000f8";
    await pool.query(
      `INSERT INTO customers (id, external_key, name)
       VALUES ($1, 'ck-livegate', 'LiveGate')
       ON CONFLICT (id) DO NOTHING`,
      [customer],
    );

    const old = new Date("2020-01-15T03:00:00Z");
    const client = await pool.connect();
    try {
      await recordBaselineActivity(
        client,
        customer,
        "Asia/Seoul",
        asAcceptedEvents([old]),
      );
    } finally {
      client.release();
    }

    const { rows } = await pool.query(
      `SELECT period FROM periodic_report_state
        WHERE subject_id = $1`,
      [customer],
    );
    expect(rows.length).toBe(0);
  });

  it("customers timezone change archives all old-tz periodic_report_state rows via trigger (round-8 review item 2)", async () => {
    // The schema ships an AFTER UPDATE OF timezone trigger on
    // customers that archives every periodic_report_state row whose
    // tz no longer matches customers.timezone. The admin SQL update
    // path is the only mutation in Phase 0; this test verifies the
    // trigger fires on that path without needing app code.
    const customer = "00000000-0000-0000-0000-0000000000f9";
    await pool.query(
      `INSERT INTO customers (id, external_key, name, timezone)
       VALUES ($1, 'ck-tz', 'TZ', 'Asia/Seoul')
       ON CONFLICT (id) DO UPDATE SET timezone = 'Asia/Seoul'`,
      [customer],
    );
    await pool.query(
      `INSERT INTO periodic_report_state
         (subject_id, period, bucket_date, tz, status)
       VALUES
         ($1, 'LIVE',    DATE '1970-01-01', 'Asia/Seoul', 'ready'),
         ($1, 'DAILY',   DATE '2026-05-20', 'Asia/Seoul', 'ready'),
         ($1, 'WEEKLY',  DATE '2026-05-18', 'Asia/Seoul', 'dirty'),
         ($1, 'MONTHLY', DATE '2026-05-01', 'Asia/Seoul', 'pending')`,
      [customer],
    );

    await pool.query(
      `UPDATE customers SET timezone = 'America/Los_Angeles' WHERE id = $1`,
      [customer],
    );

    const { rows } = await pool.query<{ status: string }>(
      `SELECT status FROM periodic_report_state
        WHERE subject_id = $1 AND tz = 'Asia/Seoul'`,
      [customer],
    );
    expect(rows.length).toBe(4);
    for (const r of rows) expect(r.status).toBe("archived");

    // Idempotence: setting the timezone to the SAME value does not
    // re-fire (the trigger's WHEN clause checks IS DISTINCT FROM).
    await pool.query(
      `UPDATE customers SET timezone = 'America/Los_Angeles' WHERE id = $1`,
      [customer],
    );
    // No assertion needed — rows remain archived.
  });

  it("recordBaselineActivity skips archived periodic rows (round-5 review item 2)", async () => {
    // RFC 0002 §"Timezone lifecycle" + issue #294 decision 2: archived
    // periodic rows are terminal — a later baseline batch must not
    // resurrect them to `dirty` or forward-patch `last_event_at`.
    // Reconcile already enforces this; the ingest hook must too.
    const customer = "00000000-0000-0000-0000-0000000000f4";
    await pool.query(
      `INSERT INTO customers (id, external_key, name)
       VALUES ($1, 'ck-k', 'K')
       ON CONFLICT (id) DO NOTHING`,
      [customer],
    );
    const baseline = new Date("2024-06-01T00:00:00Z");
    // Archived LIVE + archived DAILY/WEEKLY/MONTHLY rows with prior
    // done jobs from the previous tz era, each pre-stamped with an
    // older `last_event_at` so we can detect forward-patching.
    await pool.query(
      `INSERT INTO periodic_report_state
         (subject_id, period, bucket_date, tz, status, last_event_at)
       VALUES
         ($1, 'LIVE',    DATE '1970-01-01', 'Asia/Seoul', 'archived', $2),
         ($1, 'DAILY',   DATE '2024-06-01', 'Asia/Seoul', 'archived', $2),
         ($1, 'WEEKLY',  DATE '2024-05-27', 'Asia/Seoul', 'archived', $2),
         ($1, 'MONTHLY', DATE '2024-06-01', 'Asia/Seoul', 'archived', $2)`,
      [customer, baseline.toISOString()],
    );
    for (const [period, bucketDate] of [
      ["LIVE", "1970-01-01"],
      ["DAILY", "2024-06-01"],
      ["WEEKLY", "2024-05-27"],
      ["MONTHLY", "2024-06-01"],
    ] as const) {
      await pool.query(
        `INSERT INTO periodic_report_job
           (subject_id, period, bucket_date, tz,
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

    // A baseline batch whose event_time lands inside every existing
    // bucket window must NOT touch the archived rows.
    const later = new Date("2024-06-15T03:00:00Z");
    const client = await pool.connect();
    try {
      await recordBaselineActivity(
        client,
        customer,
        "Asia/Seoul",
        asAcceptedEvents([later]),
      );
    } finally {
      client.release();
    }

    const { rows } = await pool.query<{
      period: string;
      bucket_date: string;
      status: string;
      last_event_at: Date | null;
    }>(
      `SELECT period, bucket_date::text AS bucket_date, status, last_event_at
         FROM periodic_report_state
        WHERE subject_id = $1
        ORDER BY period, bucket_date`,
      [customer],
    );
    for (const row of rows) {
      expect(row.status).toBe("archived");
      expect(row.last_event_at?.toISOString()).toBe(baseline.toISOString());
    }
  });

  it("recordBaselineActivity stores last_event_received_at from the per-event customer-DB received_at, not auth-DB NOW() (round-9 review item 2)", async () => {
    // Round-9 review item 2: the auth-DB `last_event_received_at`
    // must mirror the customer-DB `baseline_event.received_at` of the
    // accepted event so the reconcile forward-patch (which compares
    // against `MAX(baseline_event.received_at)`) is a like-for-like
    // comparison. Using `NOW()` could put the auth-DB column ahead of
    // an in-flight customer-DB commit and mask a later hook failure
    // whose event_time is earlier than the bucket's current max.
    const customer = "00000000-0000-0000-0000-0000000000f9";
    await pool.query(
      `INSERT INTO customers (id, external_key, name)
       VALUES ($1, 'ck-r9', 'R9')
       ON CONFLICT (id) DO NOTHING`,
      [customer],
    );
    // An event from yesterday — outside the trailing-24h LIVE window,
    // so the LIVE path is a no-op and the DAILY bucket is the only
    // surface that exercises `last_event_received_at`. Seed a DAILY
    // state row matching the bucket so the forward-patch branch fires.
    const yesterday = new Date(Date.now() - 36 * 60 * 60 * 1000);
    const eventTime = yesterday;
    // Pin received_at to a value in the past so we can prove the
    // stored column matches the passed value (not `NOW()`).
    const customerReceivedAt = new Date(eventTime.getTime() + 5_000);
    const bucketDate = await pool.query<{ d: string }>(
      `SELECT (date_trunc('day', $1::timestamptz AT TIME ZONE 'Asia/Seoul'))
              ::date::text AS d`,
      [eventTime.toISOString()],
    );
    await pool.query(
      `INSERT INTO periodic_report_state
         (subject_id, period, bucket_date, tz, status)
       VALUES ($1, 'DAILY', $2::date, 'Asia/Seoul', 'pending')`,
      [customer, bucketDate.rows[0].d],
    );

    const client = await pool.connect();
    try {
      await recordBaselineActivity(client, customer, "Asia/Seoul", [
        { eventTime, receivedAt: customerReceivedAt },
      ]);
    } finally {
      client.release();
    }

    const { rows } = await pool.query<{
      last_event_at: Date | null;
      last_event_received_at: Date | null;
    }>(
      `SELECT last_event_at, last_event_received_at
         FROM periodic_report_state
        WHERE subject_id = $1
          AND period      = 'DAILY'
          AND bucket_date = $2::date
          AND tz          = 'Asia/Seoul'`,
      [customer, bucketDate.rows[0].d],
    );
    expect(rows[0]?.last_event_at?.toISOString()).toBe(eventTime.toISOString());
    // The stored received_at MUST equal the customer-DB value passed
    // to the hook — NOT a fresh `NOW()` from the auth-DB session.
    expect(rows[0]?.last_event_received_at?.toISOString()).toBe(
      customerReceivedAt.toISOString(),
    );
  });
});

// RFC 0002 Phase 0.5 (#295) — cursor watermark write + worker readiness.
describe.skipIf(!hasPostgres)("cursor watermark (issue #295)", () => {
  let dbName: string;
  let pool: Pool;
  const CUSTOMER = "00000000-0000-0000-0000-0000000000c1";

  async function seedRow(opts: {
    period: "DAILY" | "WEEKLY" | "MONTHLY" | "LIVE";
    bucketDate: string;
    tz: string;
    status?: string;
    cursor?: Date | null;
    quality?: "strict" | "soft" | null;
    updatedAt?: Date;
  }): Promise<void> {
    const updatedAt = (opts.updatedAt ?? new Date()).toISOString();
    await pool.query(
      `INSERT INTO periodic_report_state
         (subject_id, period, bucket_date, tz, status,
          cursor_watermark, cursor_watermark_quality, updated_at)
       VALUES ($1, $2, $3::date, $4, $5, $6, $7, $8)
       ON CONFLICT (subject_id, period, bucket_date, tz) DO UPDATE
         SET status = EXCLUDED.status,
             cursor_watermark = EXCLUDED.cursor_watermark,
             cursor_watermark_quality = EXCLUDED.cursor_watermark_quality,
             updated_at = EXCLUDED.updated_at`,
      [
        CUSTOMER,
        opts.period,
        opts.bucketDate,
        opts.tz,
        opts.status ?? "pending",
        opts.cursor ? opts.cursor.toISOString() : null,
        opts.quality ?? null,
        updatedAt,
      ],
    );
  }

  async function getRow(
    period: string,
    bucketDate: string,
    tz: string,
  ): Promise<{
    cursor_watermark: Date | null;
    cursor_watermark_quality: string | null;
    status: string;
  } | null> {
    const { rows } = await pool.query<{
      cursor_watermark: Date | null;
      cursor_watermark_quality: string | null;
      status: string;
    }>(
      `SELECT cursor_watermark, cursor_watermark_quality, status
         FROM periodic_report_state
        WHERE subject_id = $1 AND period = $2
          AND bucket_date = $3::date AND tz = $4`,
      [CUSTOMER, period, bucketDate, tz],
    );
    return rows[0] ?? null;
  }

  beforeAll(async () => {
    const db = await createTestDatabase("analysis_cursor_wm");
    dbName = db.dbName;
    pool = db.pool;
    await runMigrations(pool, AUTH_MIGRATIONS_DIR, LOCK_ID);
    await pool.query(
      `INSERT INTO customers (id, external_key, name)
       VALUES ($1, 'ck-cwm', 'CWM')
       ON CONFLICT (id) DO NOTHING`,
      [CUSTOMER],
    );
  });

  afterAll(async () => {
    await dropTestDatabase(dbName, pool);
    await closeAdminPool();
  });

  it("seeds cursor_watermark on a row with NULL watermark", async () => {
    await seedRow({
      period: "DAILY",
      bucketDate: "2026-05-27",
      tz: "UTC",
      cursor: null,
      quality: null,
    });
    const client = await pool.connect();
    try {
      await recordCursorWatermark(
        client,
        CUSTOMER,
        new Date("2026-05-28T01:00:00Z"),
        "strict",
      );
    } finally {
      client.release();
    }
    const row = await getRow("DAILY", "2026-05-27", "UTC");
    expect(row?.cursor_watermark?.toISOString()).toBe(
      "2026-05-28T01:00:00.000Z",
    );
    expect(row?.cursor_watermark_quality).toBe("strict");
  });

  it("forward-only: a stale (older) write does not roll the watermark back", async () => {
    await seedRow({
      period: "DAILY",
      bucketDate: "2026-05-27",
      tz: "UTC",
      cursor: new Date("2026-05-28T05:00:00Z"),
      quality: "strict",
    });
    const client = await pool.connect();
    try {
      await recordCursorWatermark(
        client,
        CUSTOMER,
        new Date("2026-05-28T01:00:00Z"),
        "strict",
      );
    } finally {
      client.release();
    }
    const row = await getRow("DAILY", "2026-05-27", "UTC");
    expect(row?.cursor_watermark?.toISOString()).toBe(
      "2026-05-28T05:00:00.000Z",
    );
    expect(row?.cursor_watermark_quality).toBe("strict");
  });

  it("strict beats soft on equal timestamps", async () => {
    await seedRow({
      period: "DAILY",
      bucketDate: "2026-05-27",
      tz: "UTC",
      cursor: new Date("2026-05-28T01:00:00Z"),
      quality: "soft",
    });
    const client = await pool.connect();
    try {
      await recordCursorWatermark(
        client,
        CUSTOMER,
        new Date("2026-05-28T01:00:00Z"),
        "strict",
      );
    } finally {
      client.release();
    }
    const row = await getRow("DAILY", "2026-05-27", "UTC");
    expect(row?.cursor_watermark_quality).toBe("strict");
  });

  it("soft does NOT downgrade an existing strict watermark at the same timestamp", async () => {
    await seedRow({
      period: "DAILY",
      bucketDate: "2026-05-27",
      tz: "UTC",
      cursor: new Date("2026-05-28T01:00:00Z"),
      quality: "strict",
    });
    const client = await pool.connect();
    try {
      await recordCursorWatermark(
        client,
        CUSTOMER,
        new Date("2026-05-28T01:00:00Z"),
        "soft",
      );
    } finally {
      client.release();
    }
    const row = await getRow("DAILY", "2026-05-27", "UTC");
    expect(row?.cursor_watermark_quality).toBe("strict");
  });

  it("updates archived rows in place (customer-wide policy)", async () => {
    await seedRow({
      period: "DAILY",
      bucketDate: "2026-05-26",
      tz: "UTC",
      status: "archived",
      cursor: null,
      quality: null,
    });
    const client = await pool.connect();
    try {
      await recordCursorWatermark(
        client,
        CUSTOMER,
        new Date("2026-05-28T01:00:00Z"),
        "strict",
      );
    } finally {
      client.release();
    }
    const row = await getRow("DAILY", "2026-05-26", "UTC");
    expect(row?.cursor_watermark?.toISOString()).toBe(
      "2026-05-28T01:00:00.000Z",
    );
    expect(row?.status).toBe("archived");
  });

  // The worker uses Postgres NOW(), not JS Date.now(), so we can't fake
  // the clock. Instead, set the two settle env vars so the gap between
  // shortened and baseline is wide. With BASELINE=48h and SHORTENED=0h,
  // any closed bucket fails the baseline gate but passes the shortened
  // gate when (and only when) a strict watermark covers it.
  //
  // `bucket_end_at` must exactly match the SQL gate's expression
  // `(bucket_date + INTERVAL '1 day')::timestamp AT TIME ZONE tz`,
  // which for tz='UTC' is the UTC midnight of `bucket_date + 1 day`.
  // A wall-clock NOW()-24h would otherwise drift past that midnight and
  // the "cursor does NOT cover" case would silently flip into the
  // strict-cover branch. Pin `bucket_date` to "day before yesterday"
  // (UTC) so `bucket_end_at` lands on yesterday-midnight UTC: 24-48h
  // before NOW (well above the 1h fallback shortened gate, well below
  // the 48h baseline gate) for any test wall-clock.
  function pickPastBucket(): { bucketDate: string; bucketEndAt: Date } {
    const now = new Date();
    const todayMidnightMs = Date.UTC(
      now.getUTCFullYear(),
      now.getUTCMonth(),
      now.getUTCDate(),
    );
    const bucketEndAt = new Date(todayMidnightMs - 24 * 3_600_000);
    const bucketStart = new Date(bucketEndAt.getTime() - 24 * 3_600_000);
    return {
      bucketDate: bucketStart.toISOString().slice(0, 10),
      bucketEndAt,
    };
  }

  function setShortSettleEnv(): void {
    process.env.ANALYSIS_SETTLE_HOURS_DAILY = "48";
    process.env.ANALYSIS_SETTLE_HOURS_DAILY_WITH_WATERMARK = "0";
  }

  function resetSettleEnv(): void {
    process.env.ANALYSIS_SETTLE_HOURS_DAILY = undefined;
    process.env.ANALYSIS_SETTLE_HOURS_DAILY_WITH_WATERMARK = undefined;
    delete process.env.ANALYSIS_SETTLE_HOURS_DAILY;
    delete process.env.ANALYSIS_SETTLE_HOURS_DAILY_WITH_WATERMARK;
  }

  it("worker uses shortened settle when strict watermark covers bucket end", async () => {
    setShortSettleEnv();
    const { bucketDate, bucketEndAt } = pickPastBucket();
    await pool.query(
      `DELETE FROM periodic_report_state WHERE subject_id = $1`,
      [CUSTOMER],
    );
    await seedRow({
      period: "DAILY",
      bucketDate,
      tz: "UTC",
      status: "pending",
      cursor: bucketEndAt,
      quality: "strict",
      updatedAt: new Date(Date.now() - 6 * 3_600_000),
    });
    try {
      await runAnalysisJobTickOnce(pool);
      const row = await getRow("DAILY", bucketDate, "UTC");
      expect(row?.status).not.toBe("pending");
    } finally {
      resetSettleEnv();
    }
  });

  it("worker falls back to baseline settle when watermark is soft", async () => {
    setShortSettleEnv();
    const { bucketDate, bucketEndAt } = pickPastBucket();
    await pool.query(
      `DELETE FROM periodic_report_state WHERE subject_id = $1`,
      [CUSTOMER],
    );
    await seedRow({
      period: "DAILY",
      bucketDate,
      tz: "UTC",
      status: "pending",
      cursor: bucketEndAt,
      quality: "soft",
      updatedAt: new Date(Date.now() - 6 * 3_600_000),
    });
    try {
      await runAnalysisJobTickOnce(pool);
      const row = await getRow("DAILY", bucketDate, "UTC");
      expect(row?.status).toBe("pending");
    } finally {
      resetSettleEnv();
    }
  });

  it("worker falls back to baseline settle when watermark is NULL", async () => {
    setShortSettleEnv();
    const { bucketDate } = pickPastBucket();
    await pool.query(
      `DELETE FROM periodic_report_state WHERE subject_id = $1`,
      [CUSTOMER],
    );
    await seedRow({
      period: "DAILY",
      bucketDate,
      tz: "UTC",
      status: "pending",
      cursor: null,
      quality: null,
      updatedAt: new Date(Date.now() - 6 * 3_600_000),
    });
    try {
      await runAnalysisJobTickOnce(pool);
      const row = await getRow("DAILY", bucketDate, "UTC");
      expect(row?.status).toBe("pending");
    } finally {
      resetSettleEnv();
    }
  });

  it("cursor watermark write does NOT advance updated_at (round-2 review item 2)", async () => {
    // Round-2 review item 2: the worker's quiet-window gate
    // (`analysis-job-worker.ts` `tickPeriodicStates`) uses
    // `updated_at` as a source-ingest activity proxy. Because the
    // cursor write fans out customer-wide to every periodic row,
    // stamping `updated_at` from it would keep historical DAILY
    // pending rows out of readiness indefinitely whenever envelopes
    // arrive more often than `ANALYSIS_IDLE_QUIET_MINUTES`, even
    // though no source data for those buckets changed. The cursor
    // write must therefore leave `updated_at` alone.
    await pool.query(
      `DELETE FROM periodic_report_state WHERE subject_id = $1`,
      [CUSTOMER],
    );
    const oldUpdatedAt = new Date(Date.now() - 6 * 3_600_000);
    await seedRow({
      period: "DAILY",
      bucketDate: "2026-05-26",
      tz: "UTC",
      status: "pending",
      cursor: null,
      quality: null,
      updatedAt: oldUpdatedAt,
    });
    const client = await pool.connect();
    try {
      await recordCursorWatermark(
        client,
        CUSTOMER,
        new Date("2026-05-28T01:00:00Z"),
        "strict",
      );
    } finally {
      client.release();
    }
    const { rows } = await pool.query<{
      cursor_watermark: Date | null;
      cursor_watermark_quality: string | null;
      updated_at: Date;
    }>(
      `SELECT cursor_watermark, cursor_watermark_quality, updated_at
         FROM periodic_report_state
        WHERE subject_id = $1
          AND period = 'DAILY'
          AND bucket_date = '2026-05-26'::date
          AND tz = 'UTC'`,
      [CUSTOMER],
    );
    expect(rows[0]?.cursor_watermark?.toISOString()).toBe(
      "2026-05-28T01:00:00.000Z",
    );
    expect(rows[0]?.cursor_watermark_quality).toBe("strict");
    // Tolerate the second-precision round-trip from Postgres.
    const updatedAt = rows[0]?.updated_at;
    expect(updatedAt).toBeInstanceOf(Date);
    expect(
      Math.abs((updatedAt as Date).getTime() - oldUpdatedAt.getTime()),
    ).toBeLessThan(2000);
  });

  it("worker falls back to baseline settle when strict watermark does NOT cover bucket end", async () => {
    setShortSettleEnv();
    const { bucketDate, bucketEndAt } = pickPastBucket();
    await pool.query(
      `DELETE FROM periodic_report_state WHERE subject_id = $1`,
      [CUSTOMER],
    );
    await seedRow({
      period: "DAILY",
      bucketDate,
      tz: "UTC",
      status: "pending",
      // strict watermark one hour BEFORE the bucket end → does not cover.
      cursor: new Date(bucketEndAt.getTime() - 3_600_000),
      quality: "strict",
      updatedAt: new Date(Date.now() - 6 * 3_600_000),
    });
    try {
      await runAnalysisJobTickOnce(pool);
      const row = await getRow("DAILY", bucketDate, "UTC");
      expect(row?.status).toBe("pending");
    } finally {
      resetSettleEnv();
    }
  });
});

// Issue #358 — story readiness windows (idle / max-wait) are env-tunable.
// The worker reads `ANALYSIS_STORY_IDLE_MINUTES` /
// `ANALYSIS_STORY_MAX_WAIT_HOURS` at tick time and falls back to the
// 15-min / 6-hr constants via `resolveInt` (whose `> 0` floor rejects 0 /
// non-finite / negative overrides).
describe.skipIf(!hasPostgres)(
  "story readiness env overrides (issue #358)",
  () => {
    let dbName: string;
    let pool: Pool;
    const CUSTOMER = "00000000-0000-0000-0000-0000000000d8";

    async function seedPendingStory(storyId: string, idleMinutes: number) {
      // Insert a pending row whose first/last_member_at are `idleMinutes`
      // ago — under the 15-min default it is NOT yet readiness-eligible.
      await pool.query(
        `INSERT INTO story_analysis_state
         (customer_id, story_id, status, first_member_at, last_member_at)
       VALUES ($1, $2::bigint, 'pending',
               NOW() - ($3 || ' minutes')::interval,
               NOW() - ($3 || ' minutes')::interval)
       ON CONFLICT (customer_id, story_id) DO UPDATE
         SET status = 'pending',
             first_member_at = EXCLUDED.first_member_at,
             last_member_at = EXCLUDED.last_member_at`,
        [CUSTOMER, storyId, idleMinutes],
      );
    }

    async function getStatus(storyId: string): Promise<string | null> {
      const { rows } = await pool.query<{ status: string }>(
        `SELECT status FROM story_analysis_state
        WHERE customer_id = $1 AND story_id = $2::bigint`,
        [CUSTOMER, storyId],
      );
      return rows[0]?.status ?? null;
    }

    function resetIdleEnv(): void {
      delete process.env.ANALYSIS_STORY_IDLE_MINUTES;
      delete process.env.ANALYSIS_STORY_MAX_WAIT_HOURS;
    }

    beforeAll(async () => {
      const db = await createTestDatabase("analysis_story_readiness");
      dbName = db.dbName;
      pool = db.pool;
      await runMigrations(pool, AUTH_MIGRATIONS_DIR, LOCK_ID);
      await pool.query(
        `INSERT INTO customers (id, external_key, name)
       VALUES ($1, 'ck-d8', 'D8')
       ON CONFLICT (id) DO NOTHING`,
        [CUSTOMER],
      );
    });

    afterAll(async () => {
      await dropTestDatabase(dbName, pool);
      await closeAdminPool();
    });

    it("ANALYSIS_STORY_IDLE_MINUTES override shortens the idle readiness window", async () => {
      // 5 min idle: not ready under the 15-min default, but ready once the
      // idle window is overridden down to 2 min.
      await seedPendingStory("3580001", 5);
      await runAnalysisJobTickOnce(pool);
      expect(await getStatus("3580001")).toBe("pending");

      process.env.ANALYSIS_STORY_IDLE_MINUTES = "2";
      try {
        await runAnalysisJobTickOnce(pool);
        expect(await getStatus("3580001")).toBe("ready");
      } finally {
        resetIdleEnv();
      }
    });

    it("ANALYSIS_STORY_MAX_WAIT_HOURS override shortens the max-wait window", async () => {
      // A story that is still receiving members (last_member_at recent)
      // only becomes ready via the max-wait ceiling on first_member_at.
      // Backdate first_member_at 2h and keep last_member_at recent so the
      // idle window never fires; a 1h max-wait override promotes it.
      await pool.query(
        `INSERT INTO story_analysis_state
         (customer_id, story_id, status, first_member_at, last_member_at)
       VALUES ($1, 3580002, 'pending',
               NOW() - INTERVAL '2 hours', NOW())
       ON CONFLICT (customer_id, story_id) DO UPDATE
         SET status = 'pending',
             first_member_at = EXCLUDED.first_member_at,
             last_member_at = EXCLUDED.last_member_at`,
        [CUSTOMER],
      );
      await runAnalysisJobTickOnce(pool);
      expect(await getStatus("3580002")).toBe("pending");

      process.env.ANALYSIS_STORY_MAX_WAIT_HOURS = "1";
      try {
        await runAnalysisJobTickOnce(pool);
        expect(await getStatus("3580002")).toBe("ready");
      } finally {
        resetIdleEnv();
      }
    });

    it("0 / non-finite / negative overrides fall back to the defaults", async () => {
      // 5-min idle row stays pending under each invalid override because
      // `resolveInt` rejects them and restores the 15-min default.
      for (const bad of ["0", "-3", "not-a-number"]) {
        await seedPendingStory("3580003", 5);
        process.env.ANALYSIS_STORY_IDLE_MINUTES = bad;
        try {
          await runAnalysisJobTickOnce(pool);
          expect(await getStatus("3580003")).toBe("pending");
        } finally {
          resetIdleEnv();
        }
      }
    });
  },
);
