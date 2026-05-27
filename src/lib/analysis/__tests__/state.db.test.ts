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
} = await import("../state");

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
      await recordBaselineActivity(
        client,
        CUSTOMER_B,
        "Asia/Seoul",
        new Date("2026-05-27T08:00:00Z"),
      );
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
});
