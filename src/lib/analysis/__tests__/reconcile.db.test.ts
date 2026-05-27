// RFC 0002 Phase 0 (#294) — reconciliation safety-net DB tests.
//
// Covers the issue #294 decision-2 requirements:
//   - Seed missing `story_analysis_state` rows from customer-DB
//     `story` rows.
//   - Seed missing `periodic_report_state` rows from baseline / story
//     source timestamps.
//   - Forward-patch lagging columns; never roll values backwards;
//     never touch `archived` rows.
//   - Idempotence: a second pass over the same customer set reports
//     zero seeds and zero forward-patches (the issue's verification
//     gate).

import { join } from "node:path";
import type { Pool, PoolClient } from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  closeAdminPool,
  createTestDatabase,
  dropTestDatabase,
  hasPostgres,
} from "@/lib/db/__tests__/db-test-helpers";
import { runMigrations } from "@/lib/db/migrate";

vi.mock("server-only", () => ({}));

const { reconcileCustomer, runReconcileTick } = await import("../reconcile");
const { LIVE_BUCKET_DATE } = await import("../state");

const AUTH_MIGRATIONS_DIR = join(process.cwd(), "migrations", "auth");
const CUSTOMER_MIGRATIONS_DIR = join(process.cwd(), "migrations", "customer");
const AUTH_LOCK_ID = 2101;
const CUSTOMER_LOCK_ID = 2102;
const CUSTOMER_ID = "00000000-0000-0000-0000-0000000000c1";

async function seedAuthCustomer(authPool: Pool, tz: string): Promise<void> {
  await authPool.query(
    `INSERT INTO customers (id, external_key, name, database_status, timezone)
     VALUES ($1, 'recon-1', 'Recon Customer', 'active', $2)
     ON CONFLICT (id) DO UPDATE SET timezone = EXCLUDED.timezone,
                                    database_status = 'active'`,
    [CUSTOMER_ID, tz],
  );
}

async function seedStory(
  customerPool: Pool,
  storyId: string,
  storyVersion: string,
  receivedAt: string,
): Promise<void> {
  await customerPool.query(
    `INSERT INTO story
       (story_id, story_version, kind, time_window_start, time_window_end,
        summary_payload, source_aice_id, received_at)
     VALUES ($1::bigint, $2, 'auto_correlated',
             $3::timestamptz, ($3::timestamptz + INTERVAL '5 minutes'),
             '{}'::jsonb, 'aice-1', $3::timestamptz)`,
    [storyId, storyVersion, receivedAt],
  );
}

async function seedBaselineEvent(
  customerPool: Pool,
  eventKey: string,
  eventTime: string,
): Promise<void> {
  await customerPool.query(
    `INSERT INTO baseline_event
       (baseline_version, event_key, event_time, kind, raw_score,
        raw_event, score_window_context, window_signals,
        scoring_weights_snapshot, source_aice_id)
     VALUES ('v1', $1::numeric, $2::timestamptz, 'k', 0.5,
             '{}'::jsonb, '{}'::jsonb, '{}'::jsonb,
             '{}'::jsonb, 'aice-1')`,
    [eventKey, eventTime],
  );
}

function makeDeps(authPool: Pool, customerPool: Pool) {
  return {
    authPool,
    connectCustomer: async () => {
      const client: PoolClient = await customerPool.connect();
      return {
        query: client.query.bind(client) as PoolClient["query"],
        end: async () => {
          client.release();
        },
      };
    },
  };
}

describe.skipIf(!hasPostgres)("analysis reconcile (cross-DB)", () => {
  let authDbName: string;
  let authPool: Pool;
  let customerDbName: string;
  let customerPool: Pool;

  beforeAll(async () => {
    const auth = await createTestDatabase("analysis_recon_auth");
    authDbName = auth.dbName;
    authPool = auth.pool;
    await runMigrations(authPool, AUTH_MIGRATIONS_DIR, AUTH_LOCK_ID);

    const cust = await createTestDatabase("analysis_recon_cust");
    customerDbName = cust.dbName;
    customerPool = cust.pool;
    await runMigrations(
      customerPool,
      CUSTOMER_MIGRATIONS_DIR,
      CUSTOMER_LOCK_ID,
    );

    await seedAuthCustomer(authPool, "Asia/Seoul");
  });

  afterAll(async () => {
    await dropTestDatabase(authDbName, authPool);
    await dropTestDatabase(customerDbName, customerPool);
    await closeAdminPool();
  });

  it("seeds a missing story_analysis_state row from customer-DB story", async () => {
    await seedStory(customerPool, "9001", "v1", "2026-05-26T10:00:00Z");
    await seedStory(customerPool, "9001", "v2", "2026-05-26T11:30:00Z");

    const outcome = await reconcileCustomer(
      CUSTOMER_ID,
      "Asia/Seoul",
      makeDeps(authPool, customerPool),
    );
    expect(outcome.status).toBe("completed");
    expect(outcome.storyStatesSeeded).toBe(1);

    const { rows } = await authPool.query(
      `SELECT status,
              first_member_at,
              last_member_at
         FROM story_analysis_state
        WHERE customer_id = $1 AND story_id = 9001`,
      [CUSTOMER_ID],
    );
    expect(rows[0].status).toBe("pending");
    // Both versions feed first/last via MIN/MAX(received_at).
    expect(rows[0].first_member_at.toISOString()).toBe(
      "2026-05-26T10:00:00.000Z",
    );
    expect(rows[0].last_member_at.toISOString()).toBe(
      "2026-05-26T11:30:00.000Z",
    );
  });

  it("a second reconcile pass is a no-op (zero seeds, zero patches)", async () => {
    const outcome = await reconcileCustomer(
      CUSTOMER_ID,
      "Asia/Seoul",
      makeDeps(authPool, customerPool),
    );
    expect(outcome.status).toBe("completed");
    expect(outcome.storyStatesSeeded).toBe(0);
    expect(outcome.storyStatesPatched).toBe(0);
    expect(outcome.periodicStatesSeeded).toBe(0);
    expect(outcome.periodicStatesPatched).toBe(0);
  });

  it("forward-patches last_member_at when a later story_version lands but never rolls backwards", async () => {
    await seedStory(customerPool, "9001", "v3", "2026-05-26T12:00:00Z");

    const first = await reconcileCustomer(
      CUSTOMER_ID,
      "Asia/Seoul",
      makeDeps(authPool, customerPool),
    );
    expect(first.storyStatesPatched).toBe(1);

    const { rows } = await authPool.query(
      `SELECT first_member_at, last_member_at
         FROM story_analysis_state
        WHERE customer_id = $1 AND story_id = 9001`,
      [CUSTOMER_ID],
    );
    // last_member_at advances to v3; first_member_at stays at v1.
    expect(rows[0].first_member_at.toISOString()).toBe(
      "2026-05-26T10:00:00.000Z",
    );
    expect(rows[0].last_member_at.toISOString()).toBe(
      "2026-05-26T12:00:00.000Z",
    );

    // Second pass is a no-op again.
    const second = await reconcileCustomer(
      CUSTOMER_ID,
      "Asia/Seoul",
      makeDeps(authPool, customerPool),
    );
    expect(second.storyStatesPatched).toBe(0);
  });

  it("unarchives a story_analysis_state row when the customer DB still has a surviving aggregate (round-16 review item 1)", async () => {
    // Decision 1 reinsert path. The successful ingest path runs
    // `unarchiveStoryStateIfArchived` in `state.ts`, but that hook is
    // best-effort: on failure the auth-side row stays `archived` while
    // the customer DB already holds new versions for the same
    // `story_id`. Reconcile must close that window — reset to
    // `pending`, populate canonical timestamps from the aggregate,
    // clear `last_ready_at`, and drop stale jobs from the prior
    // archived generation.
    await authPool.query(
      `UPDATE story_analysis_state
          SET status = 'archived', last_ready_at = NOW(), updated_at = NOW()
        WHERE customer_id = $1 AND story_id = 9001`,
      [CUSTOMER_ID],
    );
    // Stale job from the prior archived generation.
    await authPool.query(
      `INSERT INTO story_analysis_job
         (customer_id, story_id, lang, model_name, model,
          status, generation, dry_run,
          processing_started_at, last_generated_at)
       VALUES ($1, 9001, 'ENGLISH', 'openai', 'gpt-4o',
               'done', 1, TRUE, NOW(), NOW())`,
      [CUSTOMER_ID],
    );
    // Reinsert: a refresh-window / backfill commits a new version
    // after archive. With the auth-side hook failed, only reconcile
    // can recover the state row.
    await seedStory(customerPool, "9001", "v4", "2026-05-26T13:00:00Z");

    const outcome = await reconcileCustomer(
      CUSTOMER_ID,
      "Asia/Seoul",
      makeDeps(authPool, customerPool),
    );
    expect(outcome.storyStatesPatched).toBeGreaterThanOrEqual(1);

    const { rows } = await authPool.query(
      `SELECT status,
              first_member_at,
              last_member_at,
              last_ready_at
         FROM story_analysis_state
        WHERE customer_id = $1 AND story_id = 9001`,
      [CUSTOMER_ID],
    );
    expect(rows[0].status).toBe("pending");
    // Canonical timestamps from the aggregate spanning v1 (10:00) to
    // v4 (13:00).
    expect(rows[0].first_member_at.toISOString()).toBe(
      "2026-05-26T10:00:00.000Z",
    );
    expect(rows[0].last_member_at.toISOString()).toBe(
      "2026-05-26T13:00:00.000Z",
    );
    expect(rows[0].last_ready_at).toBeNull();

    // Stale jobs from the prior archived generation are deleted so
    // the worker can schedule a fresh narrative on the next tick.
    const { rows: jobs } = await authPool.query(
      `SELECT 1 FROM story_analysis_job
        WHERE customer_id = $1 AND story_id = 9001`,
      [CUSTOMER_ID],
    );
    expect(jobs.length).toBe(0);

    // Second pass is a no-op: status is now 'pending', the LEAST/
    // GREATEST guards see no change.
    const second = await reconcileCustomer(
      CUSTOMER_ID,
      "Asia/Seoul",
      makeDeps(authPool, customerPool),
    );
    expect(second.storyStatesSeeded).toBe(0);
    expect(second.storyStatesPatched).toBe(0);
  });

  it("seeds periodic_report_state rows for LIVE + DAILY + WEEKLY + MONTHLY when source data exists in the last 24h", async () => {
    // Use NOW() so the "trailing 24h" filter actually fires.
    const nowIso = new Date().toISOString();
    await seedBaselineEvent(customerPool, "1", nowIso);

    const outcome = await reconcileCustomer(
      CUSTOMER_ID,
      "Asia/Seoul",
      makeDeps(authPool, customerPool),
    );
    // The story-side tests above already seeded yesterday's DAILY /
    // WEEKLY / MONTHLY buckets via their own source timestamps; this
    // baseline ingest adds at minimum today's DAILY bucket and the
    // first `last_event_at` population. The structural check below
    // pins the post-state — all four periods must exist.
    expect(outcome.status).toBe("completed");

    const { rows: live } = await authPool.query(
      `SELECT status, last_event_at
         FROM periodic_report_state
        WHERE customer_id = $1
          AND period = 'LIVE'
          AND bucket_date = $2::date
          AND tz = 'Asia/Seoul'`,
      [CUSTOMER_ID, LIVE_BUCKET_DATE],
    );
    expect(live[0]?.status).toBe("ready");
    expect(live[0]?.last_event_at).not.toBeNull();

    const { rows: periods } = await authPool.query<{ period: string }>(
      `SELECT DISTINCT period
         FROM periodic_report_state
        WHERE customer_id = $1
        ORDER BY period`,
      [CUSTOMER_ID],
    );
    expect(periods.map((r) => r.period).sort()).toEqual([
      "DAILY",
      "LIVE",
      "MONTHLY",
      "WEEKLY",
    ]);
  });

  it("periodic seed is idempotent across a second pass", async () => {
    const outcome = await reconcileCustomer(
      CUSTOMER_ID,
      "Asia/Seoul",
      makeDeps(authPool, customerPool),
    );
    expect(outcome.periodicStatesSeeded).toBe(0);
    expect(outcome.periodicStatesPatched).toBe(0);
  });

  it("runReconcileTick walks all active customers and reports totals", async () => {
    const tickOutcome = await runReconcileTick(
      makeDeps(authPool, customerPool),
    );
    expect(
      tickOutcome.customers.some((c) => c.customerId === CUSTOMER_ID),
    ).toBe(true);
    // Everything is already reconciled, so totals are all zero.
    expect(tickOutcome.totalStoryStatesSeeded).toBe(0);
    expect(tickOutcome.totalStoryStatesPatched).toBe(0);
    expect(tickOutcome.totalPeriodicStatesSeeded).toBe(0);
    expect(tickOutcome.totalPeriodicStatesPatched).toBe(0);
  });

  it("derives historical periodic buckets from old baseline event_time committed today (round-2 review item 2)", async () => {
    // A separate customer so we can observe a fresh seed count.
    const historicalCustomer = "00000000-0000-0000-0000-0000000000c2";
    await authPool.query(
      `INSERT INTO customers (id, external_key, name, database_status, timezone)
       VALUES ($1, 'recon-2', 'Historical', 'active', 'Asia/Seoul')
       ON CONFLICT (id) DO UPDATE SET database_status = 'active'`,
      [historicalCustomer],
    );

    // Old event_time — outside the trailing-24h window from a real
    // clock — but committed "now" simulating a same-day backfill.
    await seedBaselineEvent(customerPool, "777", "2024-01-15T03:00:00Z");

    const outcome = await reconcileCustomer(
      historicalCustomer,
      "Asia/Seoul",
      makeDeps(authPool, customerPool),
    );
    expect(outcome.status).toBe("completed");

    // 2024-01-15 03:00 UTC = 2024-01-15 12:00 KST → DAILY bucket
    // 2024-01-15 KST, WEEKLY 2024-01-15 (Monday), MONTHLY 2024-01-01.
    const { rows } = await authPool.query<{
      period: string;
      bucket_date: string;
    }>(
      `SELECT period, bucket_date::text AS bucket_date
         FROM periodic_report_state
        WHERE customer_id = $1
        ORDER BY period, bucket_date`,
      [historicalCustomer],
    );
    const set = new Set(rows.map((r) => `${r.period}|${r.bucket_date}`));
    expect(set.has("DAILY|2024-01-15")).toBe(true);
    expect(set.has("MONTHLY|2024-01-01")).toBe(true);
    expect(set.has(`LIVE|${LIVE_BUCKET_DATE}`)).toBe(true);
  });

  it("flips ready story_analysis_state to dirty when a hook failure leaves last_member_at stale (round-6 review item 1)", async () => {
    // Round-6 review item 1: customer DB commits a late story_member
    // / story_version for a `ready` row with a `done` job, but
    // `applyStoryIngestHook` fails. Reconcile must advance
    // `last_member_at` AND flip the row to `dirty` — otherwise the
    // worker (which only picks up `dirty` rows or `ready` rows
    // missing the default-variant job) leaves the stale analysis
    // ready indefinitely.
    const dirtyCustomer = "00000000-0000-0000-0000-0000000000c4";
    await authPool.query(
      `INSERT INTO customers (id, external_key, name, database_status, timezone)
       VALUES ($1, 'recon-dirty-story', 'Dirty Story', 'active', 'Asia/Seoul')
       ON CONFLICT (id) DO UPDATE SET database_status = 'active'`,
      [dirtyCustomer],
    );
    await seedStory(customerPool, "9101", "v1", "2026-05-26T10:00:00Z");
    // Seed an existing `ready` state row plus a `done` job — the
    // post-hook steady state before the missing event arrives.
    await authPool.query(
      `INSERT INTO story_analysis_state
         (customer_id, story_id, status,
          first_member_at, last_member_at, last_ready_at)
       VALUES ($1, 9101, 'ready',
               '2026-05-26T10:00:00Z'::timestamptz,
               '2026-05-26T10:00:00Z'::timestamptz,
               NOW())`,
      [dirtyCustomer],
    );
    await authPool.query(
      `INSERT INTO story_analysis_job
         (customer_id, story_id, lang, model_name, model,
          status, generation, dry_run,
          processing_started_at, last_generated_at)
       VALUES ($1, 9101, 'ENGLISH', 'openai', 'gpt-4o',
               'done', 1, TRUE, NOW(), NOW())`,
      [dirtyCustomer],
    );

    // Customer-DB commits a later version (simulating the racing
    // member arrival); auth-DB hook failed.
    await seedStory(customerPool, "9101", "v2", "2026-05-26T12:00:00Z");

    const outcome = await reconcileCustomer(
      dirtyCustomer,
      "Asia/Seoul",
      makeDeps(authPool, customerPool),
    );
    expect(outcome.status).toBe("completed");
    expect(outcome.storyStatesPatched).toBe(1);

    const { rows } = await authPool.query(
      `SELECT status, last_member_at
         FROM story_analysis_state
        WHERE customer_id = $1 AND story_id = 9101`,
      [dirtyCustomer],
    );
    expect(rows[0].status).toBe("dirty");
    expect(rows[0].last_member_at.toISOString()).toBe(
      "2026-05-26T12:00:00.000Z",
    );

    // Second pass is a no-op: last_member_at is already at v2.
    const second = await reconcileCustomer(
      dirtyCustomer,
      "Asia/Seoul",
      makeDeps(authPool, customerPool),
    );
    expect(second.storyStatesPatched).toBe(0);
  });

  it("flips ready DAILY periodic_report_state to dirty when a baseline-hook failure leaves last_event_at stale (round-6 review item 2)", async () => {
    // Round-6 review item 2: customer DB commits a baseline event
    // whose `event_time` lands inside a closed DAILY bucket already
    // in `ready` with a `done` job, but `applyBaselineIngestHook`
    // fails. Reconcile must advance `last_event_at` on the existing
    // bucket AND flip it to `dirty`.
    const periodicCustomer = "00000000-0000-0000-0000-0000000000c5";
    await authPool.query(
      `INSERT INTO customers (id, external_key, name, database_status, timezone)
       VALUES ($1, 'recon-dirty-periodic', 'Dirty Periodic', 'active', 'Asia/Seoul')
       ON CONFLICT (id) DO UPDATE SET database_status = 'active'`,
      [periodicCustomer],
    );
    // Pre-existing closed DAILY bucket in `ready` with a done job.
    // Bucket 2026-05-20 KST = 2026-05-19 15:00 .. 2026-05-20 15:00 UTC.
    await authPool.query(
      `INSERT INTO periodic_report_state
         (customer_id, period, bucket_date, tz,
          status, last_event_at, last_ready_at)
       VALUES ($1, 'DAILY', '2026-05-20'::date, 'Asia/Seoul',
               'ready',
               '2026-05-19T20:00:00Z'::timestamptz, NOW())`,
      [periodicCustomer],
    );
    await authPool.query(
      `INSERT INTO periodic_report_job
         (customer_id, period, bucket_date, tz,
          lang, model_name, model,
          status, generation, dry_run,
          processing_started_at, last_generated_at)
       VALUES ($1, 'DAILY', '2026-05-20'::date, 'Asia/Seoul',
               'ENGLISH', 'openai', 'gpt-4o',
               'done', 1, TRUE, NOW(), NOW())`,
      [periodicCustomer],
    );
    // Later event_time inside the same DAILY bucket: 2026-05-20 05:00
    // KST = 2026-05-19 20:00 UTC is the existing last_event_at;
    // 2026-05-20 13:00 KST = 2026-05-20 04:00 UTC is later but still
    // inside the same DAILY bucket.
    await seedBaselineEvent(customerPool, "501", "2026-05-20T04:00:00Z");

    const outcome = await reconcileCustomer(
      periodicCustomer,
      "Asia/Seoul",
      makeDeps(authPool, customerPool),
    );
    expect(outcome.status).toBe("completed");
    // The closed DAILY bucket exists, so the patch counts toward
    // periodicStatesPatched (not seeded). Other periods are seeded as
    // fresh rows (LIVE / WEEKLY / MONTHLY) — those are seeds, not
    // patches.
    expect(outcome.periodicStatesPatched).toBeGreaterThanOrEqual(1);

    const { rows } = await authPool.query(
      `SELECT status, last_event_at
         FROM periodic_report_state
        WHERE customer_id = $1
          AND period      = 'DAILY'
          AND bucket_date = '2026-05-20'::date
          AND tz          = 'Asia/Seoul'`,
      [periodicCustomer],
    );
    expect(rows[0].status).toBe("dirty");
    expect(rows[0].last_event_at.toISOString()).toBe(
      "2026-05-20T04:00:00.000Z",
    );

    // Second pass is a no-op for the closed bucket.
    const second = await reconcileCustomer(
      periodicCustomer,
      "Asia/Seoul",
      makeDeps(authPool, customerPool),
    );
    expect(second.periodicStatesSeeded).toBe(0);
    expect(second.periodicStatesPatched).toBe(0);
  });

  it("flips ready DAILY periodic_report_state to dirty when a baseline-hook failure adds a non-max event_time (round-7 review item 2)", async () => {
    // Round-7 review item 2: customer DB commits a baseline event
    // whose `event_time` is EARLIER than the bucket's current
    // `last_event_at`, inside a closed DAILY bucket already in
    // `ready` with a `done` job, and `applyBaselineIngestHook`
    // fails. The round-6 patch compared only `event_time` and
    // skipped this row; reconcile now also tracks
    // `last_event_received_at` so the late-arriving event whose
    // event_time does not advance the bucket max still triggers a
    // dirty transition.
    const customer = "00000000-0000-0000-0000-0000000000c7";
    await authPool.query(
      `INSERT INTO customers (id, external_key, name, database_status, timezone)
       VALUES ($1, 'recon-r7', 'Recon R7', 'active', 'Asia/Seoul')
       ON CONFLICT (id) DO UPDATE SET database_status = 'active'`,
      [customer],
    );
    // Use a unique bucket date to avoid leakage from prior tests
    // that share the customer DB pool. Bucket 2025-03-15 KST =
    // 2025-03-14 15:00 UTC..2025-03-15 15:00 UTC.
    // Seed the bucket's existing max event_time and back-date its
    // received_at so the new event can advance received_at without
    // advancing event_time.
    await customerPool.query(
      `INSERT INTO baseline_event
         (baseline_version, event_key, event_time, kind, raw_score,
          raw_event, score_window_context, window_signals,
          scoring_weights_snapshot, source_aice_id, received_at)
       VALUES ('v1', 7770::numeric, '2025-03-14T16:00:00Z'::timestamptz,
               'k', 0.5, '{}'::jsonb, '{}'::jsonb, '{}'::jsonb,
               '{}'::jsonb, 'aice-1', '2025-03-14T16:00:01Z'::timestamptz)`,
    );
    await authPool.query(
      `INSERT INTO periodic_report_state
         (customer_id, period, bucket_date, tz,
          status, last_event_at, last_event_received_at, last_ready_at)
       VALUES ($1, 'DAILY', '2025-03-15'::date, 'Asia/Seoul',
               'ready',
               '2025-03-14T16:00:00Z'::timestamptz,
               '2025-03-14T16:00:01Z'::timestamptz,
               NOW())`,
      [customer],
    );
    await authPool.query(
      `INSERT INTO periodic_report_job
         (customer_id, period, bucket_date, tz,
          lang, model_name, model,
          status, generation, dry_run,
          processing_started_at, last_generated_at)
       VALUES ($1, 'DAILY', '2025-03-15'::date, 'Asia/Seoul',
               'ENGLISH', 'openai', 'gpt-4o',
               'done', 1, TRUE, NOW(), NOW())`,
      [customer],
    );
    // New event inside the same DAILY bucket whose event_time
    // (2025-03-14T15:30Z) is STRICTLY EARLIER than the stored max
    // — event_time-only logic would skip it. received_at defaults
    // to NOW() at insert, which is later than the stored
    // last_event_received_at of 2025-03-14T16:00:01Z.
    await seedBaselineEvent(customerPool, "7771", "2025-03-14T15:30:00Z");

    const outcome = await reconcileCustomer(
      customer,
      "Asia/Seoul",
      makeDeps(authPool, customerPool),
    );
    expect(outcome.status).toBe("completed");
    expect(outcome.periodicStatesPatched).toBeGreaterThanOrEqual(1);

    const { rows } = await authPool.query(
      `SELECT status, last_event_at, last_event_received_at
         FROM periodic_report_state
        WHERE customer_id = $1
          AND period      = 'DAILY'
          AND bucket_date = '2025-03-15'::date
          AND tz          = 'Asia/Seoul'`,
      [customer],
    );
    expect(rows[0].status).toBe("dirty");
    // last_event_at does not roll backward — the bucket-wide max
    // event_time is still the seeded 2025-03-14T16:00:00Z value
    // since the new event is earlier.
    expect(rows[0].last_event_at.toISOString()).toBe(
      "2025-03-14T16:00:00.000Z",
    );
    // last_event_received_at advanced past the stored value via
    // the late-arriving event's NOW() default.
    expect(new Date(rows[0].last_event_received_at).getTime()).toBeGreaterThan(
      new Date("2025-03-14T16:00:01Z").getTime(),
    );

    // Second pass: the customer DB hasn't changed, so received_at
    // max is now at the patched stored value — no-op.
    const second = await reconcileCustomer(
      customer,
      "Asia/Seoul",
      makeDeps(authPool, customerPool),
    );
    expect(second.periodicStatesSeeded).toBe(0);
    expect(second.periodicStatesPatched).toBe(0);
  });

  it("archives orphaned story_analysis_state rows whose customer-DB story is fully gone (round-8 review item 1)", async () => {
    // The window-replace hook archives state rows when `surviving=0`
    // but is best-effort (decision 2). After a hook failure, the
    // main reconcile pass cannot see a `story_id` with zero versions
    // because it pages from customer-DB `story` aggregates. The
    // orphan-archive scan iterates non-archived auth-DB rows and
    // archives any whose customer-DB row count is zero.
    const customer = "00000000-0000-0000-0000-0000000000c8";
    await authPool.query(
      `INSERT INTO customers (id, external_key, name, database_status, timezone)
       VALUES ($1, 'recon-orph', 'Orphan', 'active', 'Asia/Seoul')
       ON CONFLICT (id) DO UPDATE SET database_status = 'active'`,
      [customer],
    );
    // Pre-existing ready state row with a done job — never had a
    // customer-DB story (or the story was deleted before any
    // customer-DB seed).
    await authPool.query(
      `INSERT INTO story_analysis_state
         (customer_id, story_id, status,
          first_member_at, last_member_at, last_ready_at)
       VALUES ($1, 9201, 'ready',
               '2025-01-01T00:00:00Z'::timestamptz,
               '2025-01-01T00:00:00Z'::timestamptz,
               NOW())`,
      [customer],
    );
    await authPool.query(
      `INSERT INTO story_analysis_job
         (customer_id, story_id, lang, model_name, model,
          status, generation, dry_run,
          processing_started_at, last_generated_at)
       VALUES ($1, 9201, 'ENGLISH', 'openai', 'gpt-4o',
               'done', 1, TRUE, NOW(), NOW())`,
      [customer],
    );

    const outcome = await reconcileCustomer(
      customer,
      "Asia/Seoul",
      makeDeps(authPool, customerPool),
    );
    expect(outcome.status).toBe("completed");
    // The archive count rolls into storyStatesPatched (same semantic
    // class as forward-only state changes).
    expect(outcome.storyStatesPatched).toBeGreaterThanOrEqual(1);

    const { rows } = await authPool.query(
      `SELECT status FROM story_analysis_state
        WHERE customer_id = $1 AND story_id = 9201`,
      [customer],
    );
    expect(rows[0].status).toBe("archived");

    // Second pass is a no-op.
    const second = await reconcileCustomer(
      customer,
      "Asia/Seoul",
      makeDeps(authPool, customerPool),
    );
    expect(second.storyStatesPatched).toBe(0);
  });

  it("dirties a closed DAILY bucket when reconcile detects deleted events (round-8 review item 1)", async () => {
    // Round-8 review item 1: a window-replace / backfill envelope
    // can delete `baseline_event` rows from inside a closed bucket
    // and the auth-DB hook can fail. When the deletion does not
    // advance `MAX(event_time)` or `MAX(received_at)` (delete-only
    // refresh, or a replacement whose new events are older than
    // the survivors), reconcile must still detect content removal.
    // `event_count` is the deletion-detection signal: the state row
    // stores the last observed count; when the recomputed count is
    // strictly less, the row is flipped to `dirty`.
    const customer = "00000000-0000-0000-0000-0000000000c9";
    await authPool.query(
      `INSERT INTO customers (id, external_key, name, database_status, timezone)
       VALUES ($1, 'recon-delcnt', 'DelCount', 'active', 'Asia/Seoul')
       ON CONFLICT (id) DO UPDATE SET database_status = 'active'`,
      [customer],
    );
    // Use a unique bucket date to avoid leakage from the shared
    // customer DB. Bucket 2025-04-10 KST.
    // Pre-seed three baseline events in the bucket on the customer DB.
    for (const [key, ts] of [
      ["8001", "2025-04-09T20:00:00Z"],
      ["8002", "2025-04-09T22:00:00Z"],
      ["8003", "2025-04-10T05:00:00Z"],
    ] as const) {
      await customerPool.query(
        `INSERT INTO baseline_event
           (baseline_version, event_key, event_time, kind, raw_score,
            raw_event, score_window_context, window_signals,
            scoring_weights_snapshot, source_aice_id)
         VALUES ('v1', $1::numeric, $2::timestamptz, 'k', 0.5,
                 '{}'::jsonb, '{}'::jsonb, '{}'::jsonb,
                 '{}'::jsonb, 'aice-1')`,
        [key, ts],
      );
    }
    // Pre-existing ready DAILY bucket with a done job and the
    // matching count of 3 (steady state after the prior hook
    // success), plus the corresponding `last_event_at` so the
    // forward-patch path does not fire on event_time advance.
    await authPool.query(
      `INSERT INTO periodic_report_state
         (customer_id, period, bucket_date, tz, status,
          last_event_at, last_event_received_at, event_count, last_ready_at)
       VALUES ($1, 'DAILY', '2025-04-10'::date, 'Asia/Seoul', 'ready',
               '2025-04-10T05:00:00Z'::timestamptz,
               '2025-04-10T05:00:01Z'::timestamptz,
               3, NOW())`,
      [customer],
    );
    await authPool.query(
      `INSERT INTO periodic_report_job
         (customer_id, period, bucket_date, tz,
          lang, model_name, model,
          status, generation, dry_run,
          processing_started_at, last_generated_at)
       VALUES ($1, 'DAILY', '2025-04-10'::date, 'Asia/Seoul',
               'ENGLISH', 'openai', 'gpt-4o',
               'done', 1, TRUE, NOW(), NOW())`,
      [customer],
    );

    // First pass with stored count == current count: forward-patch
    // path only advances `last_event_received_at` to match the
    // customer-DB max (auto-NOW from INSERT). The dirty trigger
    // SHOULD NOT fire on its own here because no envelope happened.
    // We do not assert this directly — the next step is the
    // interesting one.
    await reconcileCustomer(
      customer,
      "Asia/Seoul",
      makeDeps(authPool, customerPool),
    );

    // Simulate a delete-only refresh-window: remove one event from
    // the bucket. The bucket's MAX(event_time) does NOT advance
    // (still 2025-04-10T05:00:00Z if we delete an earlier event),
    // and MAX(received_at) does not advance (we only deleted).
    await customerPool.query(
      `DELETE FROM baseline_event WHERE event_key = 8002::numeric`,
    );

    const dirtyOutcome = await reconcileCustomer(
      customer,
      "Asia/Seoul",
      makeDeps(authPool, customerPool),
    );
    expect(dirtyOutcome.status).toBe("completed");
    expect(dirtyOutcome.periodicStatesPatched).toBeGreaterThanOrEqual(1);

    const { rows: afterDelete } = await authPool.query<{
      status: string;
      event_count: string;
    }>(
      `SELECT status, event_count::text AS event_count
         FROM periodic_report_state
        WHERE customer_id = $1
          AND period      = 'DAILY'
          AND bucket_date = '2025-04-10'::date
          AND tz          = 'Asia/Seoul'`,
      [customer],
    );
    expect(afterDelete[0].status).toBe("dirty");
    expect(Number(afterDelete[0].event_count)).toBe(2);

    // Second pass with no further changes: stored == current → no-op.
    const second = await reconcileCustomer(
      customer,
      "Asia/Seoul",
      makeDeps(authPool, customerPool),
    );
    expect(second.periodicStatesPatched).toBe(0);
  });

  it("dirties an existing DAILY bucket when a story envelope hook failure changes the bucket's stories (round-12 review item 1)", async () => {
    // Story refresh-window / backfill envelopes can mutate the inputs
    // of an already-generated DAILY/WEEKLY/MONTHLY report WITHOUT
    // touching any baseline_event row. `applyWindowReplaceEnvelopeHook`
    // is the success path; on hook failure (decision 2), only reconcile
    // can rescue the stale report. Without per-bucket story aggregates,
    // baseline-only reconcile signals do not move and the stale row
    // stays ready/done forever. This test reproduces that sequence and
    // asserts reconcile flips the row to dirty via the new
    // `last_story_received_at` / `story_count` columns.
    const customer = "00000000-0000-0000-0000-0000000000ce";
    await authPool.query(
      `INSERT INTO customers (id, external_key, name, database_status, timezone)
       VALUES ($1, 'recon-storydirty', 'StoryDirty', 'active', 'Asia/Seoul')
       ON CONFLICT (id) DO UPDATE SET database_status = 'active'`,
      [customer],
    );
    await customerPool.query(`TRUNCATE TABLE baseline_event CASCADE`);
    await customerPool.query(`TRUNCATE TABLE story CASCADE`);

    // Two stories whose time_window lands inside the 2025-06-10 KST
    // DAILY bucket (UTC 2025-06-09T15:00 .. 2025-06-10T15:00). Use
    // explicit time_window* via a direct INSERT so we can pin the
    // story's window precisely; seedStory() uses received_at for both.
    await customerPool.query(
      `INSERT INTO story
         (story_id, story_version, kind,
          time_window_start, time_window_end,
          summary_payload, source_aice_id, received_at)
       VALUES (7001, 'v1', 'auto_correlated',
               '2025-06-10T01:00:00Z'::timestamptz,
               '2025-06-10T02:00:00Z'::timestamptz,
               '{}'::jsonb, 'aice-1',
               '2025-06-10T03:00:00Z'::timestamptz),
              (7002, 'v1', 'auto_correlated',
               '2025-06-10T04:00:00Z'::timestamptz,
               '2025-06-10T05:00:00Z'::timestamptz,
               '{}'::jsonb, 'aice-1',
               '2025-06-10T06:00:00Z'::timestamptz)`,
    );

    // Pre-existing ready DAILY bucket with a done job, story aggregates
    // already in sync with the current customer-DB state (count = 2,
    // last_story_received_at = 2025-06-10T06:00:00Z). This mirrors the
    // steady state after a prior successful envelope-hook cycle.
    await authPool.query(
      `INSERT INTO periodic_report_state
         (customer_id, period, bucket_date, tz, status,
          last_event_at, last_event_received_at, event_count,
          last_story_received_at, story_count, last_ready_at)
       VALUES ($1, 'DAILY', '2025-06-10'::date, 'Asia/Seoul', 'ready',
               NULL, NULL, 0,
               '2025-06-10T06:00:00Z'::timestamptz, 2, NOW())`,
      [customer],
    );
    await authPool.query(
      `INSERT INTO periodic_report_job
         (customer_id, period, bucket_date, tz,
          lang, model_name, model,
          status, generation, dry_run,
          processing_started_at, last_generated_at)
       VALUES ($1, 'DAILY', '2025-06-10'::date, 'Asia/Seoul',
               'ENGLISH', 'openai', 'gpt-4o',
               'done', 1, TRUE, NOW(), NOW())`,
      [customer],
    );

    // Simulate a story-side refresh-window envelope that landed in
    // customer DB but whose auth-side hook failed: a new version of
    // story 7001 with a strictly later `received_at`, no baseline
    // change. Reconcile must detect this via `last_story_received_at`.
    await customerPool.query(
      `INSERT INTO story
         (story_id, story_version, kind,
          time_window_start, time_window_end,
          summary_payload, source_aice_id, received_at)
       VALUES (7001, 'v2', 'auto_correlated',
               '2025-06-10T01:30:00Z'::timestamptz,
               '2025-06-10T02:30:00Z'::timestamptz,
               '{}'::jsonb, 'aice-1',
               '2025-06-10T07:00:00Z'::timestamptz)`,
    );

    const outcome = await reconcileCustomer(
      customer,
      "Asia/Seoul",
      makeDeps(authPool, customerPool),
    );
    expect(outcome.status).toBe("completed");
    expect(outcome.periodicStatesPatched).toBeGreaterThanOrEqual(1);

    const { rows: afterAdd } = await authPool.query<{
      status: string;
      story_count: string;
      last_story_received_at: Date;
    }>(
      `SELECT status, story_count::text AS story_count,
              last_story_received_at
         FROM periodic_report_state
        WHERE customer_id = $1
          AND period      = 'DAILY'
          AND bucket_date = '2025-06-10'::date
          AND tz          = 'Asia/Seoul'`,
      [customer],
    );
    expect(afterAdd[0].status).toBe("dirty");
    expect(Number(afterAdd[0].story_count)).toBe(2);
    expect(new Date(afterAdd[0].last_story_received_at).toISOString()).toBe(
      "2025-06-10T07:00:00.000Z",
    );

    // Second pass with no further changes is a no-op (decision-2
    // idempotence gate).
    const second = await reconcileCustomer(
      customer,
      "Asia/Seoul",
      makeDeps(authPool, customerPool),
    );
    expect(second.periodicStatesPatched).toBe(0);

    // Now exercise the deletion path: drop story 7002 (a story
    // window-replace whose hook failed). `story_count` decreases from
    // 2 to 1 while `last_story_received_at` does not advance. The
    // row must still be flipped to dirty and `story_count` re-synced.
    // First reset status to ready so we can observe a fresh dirty flip.
    await authPool.query(
      `UPDATE periodic_report_state
          SET status = 'ready', updated_at = NOW()
        WHERE customer_id = $1
          AND period = 'DAILY'
          AND bucket_date = '2025-06-10'::date
          AND tz = 'Asia/Seoul'`,
      [customer],
    );
    await customerPool.query(`DELETE FROM story WHERE story_id = 7002`);

    const deletionOutcome = await reconcileCustomer(
      customer,
      "Asia/Seoul",
      makeDeps(authPool, customerPool),
    );
    expect(deletionOutcome.periodicStatesPatched).toBeGreaterThanOrEqual(1);

    const { rows: afterDel } = await authPool.query<{
      status: string;
      story_count: string;
    }>(
      `SELECT status, story_count::text AS story_count
         FROM periodic_report_state
        WHERE customer_id = $1
          AND period      = 'DAILY'
          AND bucket_date = '2025-06-10'::date
          AND tz          = 'Asia/Seoul'`,
      [customer],
    );
    expect(afterDel[0].status).toBe("dirty");
    expect(Number(afterDel[0].story_count)).toBe(1);

    // Second pass after deletion is also a no-op.
    const secondAfterDel = await reconcileCustomer(
      customer,
      "Asia/Seoul",
      makeDeps(authPool, customerPool),
    );
    expect(secondAfterDel.periodicStatesPatched).toBe(0);
  });

  it("does not spuriously dirty a boundary DAILY bucket whose start equals a story's time_window_end (round-13 review item 1)", async () => {
    // `generate_series(date_trunc(start), date_trunc(end), '1 day')` is
    // inclusive on both ends. For a story whose time_window_end lands
    // exactly on a daily-bucket boundary in the customer's tz, the
    // naive enumeration would emit the trailing boundary bucket too.
    // The half-open overlap rule says the story does NOT overlap that
    // bucket (`time_window_end > bucket_start` is false). Without the
    // re-applied WHERE filter, reconcile would compute fake aggregates
    // for the boundary bucket and dirty an already-generated report
    // for a story that does not belong to it. This regression test
    // pins a story whose KST-local window ends at exactly the start of
    // a DAILY bucket and asserts: (a) the previous-day bucket is in
    // sync and stays ready, (b) the boundary bucket stays ready with
    // its original zero-story aggregates intact, and (c) a second
    // reconcile pass is a no-op.
    const customer = "00000000-0000-0000-0000-0000000000cf";
    await authPool.query(
      `INSERT INTO customers (id, external_key, name, database_status, timezone)
       VALUES ($1, 'recon-boundary', 'Boundary', 'active', 'Asia/Seoul')
       ON CONFLICT (id) DO UPDATE SET database_status = 'active'`,
      [customer],
    );
    await customerPool.query(`TRUNCATE TABLE baseline_event CASCADE`);
    await customerPool.query(`TRUNCATE TABLE story CASCADE`);

    // KST = UTC+9. The 2025-06-11 KST DAILY bucket starts at
    // 2025-06-10T15:00:00Z. The story's time_window_end is pinned to
    // that exact instant, so it overlaps the 2025-06-10 KST bucket
    // (which spans 2025-06-09T15:00Z..2025-06-10T15:00Z) but NOT the
    // 2025-06-11 KST bucket.
    await customerPool.query(
      `INSERT INTO story
         (story_id, story_version, kind,
          time_window_start, time_window_end,
          summary_payload, source_aice_id, received_at)
       VALUES (7101, 'v1', 'auto_correlated',
               '2025-06-10T14:00:00Z'::timestamptz,
               '2025-06-10T15:00:00Z'::timestamptz,
               '{}'::jsonb, 'aice-1',
               '2025-06-10T15:00:00Z'::timestamptz)`,
    );

    // Pre-existing ready DAILY rows for both buckets with aggregates
    // already in sync with the current customer-DB state:
    //   - 2025-06-10 KST: story_count=1, last_story_received_at=15:00Z
    //   - 2025-06-11 KST: story_count=0, last_story_received_at=NULL
    await authPool.query(
      `INSERT INTO periodic_report_state
         (customer_id, period, bucket_date, tz, status,
          last_event_at, last_event_received_at, event_count,
          last_story_received_at, story_count, last_ready_at)
       VALUES ($1, 'DAILY', '2025-06-10'::date, 'Asia/Seoul', 'ready',
               NULL, NULL, 0,
               '2025-06-10T15:00:00Z'::timestamptz, 1, NOW()),
              ($1, 'DAILY', '2025-06-11'::date, 'Asia/Seoul', 'ready',
               NULL, NULL, 0,
               NULL, 0, NOW())`,
      [customer],
    );
    for (const bucketDate of ["2025-06-10", "2025-06-11"]) {
      await authPool.query(
        `INSERT INTO periodic_report_job
           (customer_id, period, bucket_date, tz,
            lang, model_name, model,
            status, generation, dry_run,
            processing_started_at, last_generated_at)
         VALUES ($1, 'DAILY', $2::date, 'Asia/Seoul',
                 'ENGLISH', 'openai', 'gpt-4o',
                 'done', 1, TRUE, NOW(), NOW())`,
        [customer, bucketDate],
      );
    }

    const outcome = await reconcileCustomer(
      customer,
      "Asia/Seoul",
      makeDeps(authPool, customerPool),
    );
    expect(outcome.status).toBe("completed");
    expect(outcome.periodicStatesPatched).toBe(0);

    const { rows } = await authPool.query<{
      bucket_date: Date;
      status: string;
      story_count: string;
      last_story_received_at: Date | null;
    }>(
      `SELECT bucket_date, status,
              story_count::text AS story_count,
              last_story_received_at
         FROM periodic_report_state
        WHERE customer_id = $1
          AND period      = 'DAILY'
          AND tz          = 'Asia/Seoul'
        ORDER BY bucket_date`,
      [customer],
    );
    expect(rows).toHaveLength(2);
    expect(rows[0].status).toBe("ready");
    expect(Number(rows[0].story_count)).toBe(1);
    expect(rows[1].status).toBe("ready");
    expect(Number(rows[1].story_count)).toBe(0);
    expect(rows[1].last_story_received_at).toBeNull();
  });

  it("does not seed a LIVE row when no source data falls in the trailing 24h (round-8 review item 3)", async () => {
    // Issue #294 decision 4 + round-8 review item 3: LIVE is the
    // rolling current state and must only be seeded when source
    // data exists in the trailing 24h. A same-day backfill of
    // historical events seeds DAILY / WEEKLY / MONTHLY buckets
    // only.
    const customer = "00000000-0000-0000-0000-0000000000ca";
    await authPool.query(
      `INSERT INTO customers (id, external_key, name, database_status, timezone)
       VALUES ($1, 'recon-livegate', 'LiveGate', 'active', 'Asia/Seoul')
       ON CONFLICT (id) DO UPDATE SET database_status = 'active'`,
      [customer],
    );
    // Isolate the customer DB: remove all baseline_event + story
    // rows so the LIVE EXISTS check sees only this test's data.
    // (The shared customer pool is okay because no test below
    // depends on the prior fixture state.)
    await customerPool.query(`TRUNCATE TABLE baseline_event CASCADE`);
    await customerPool.query(`TRUNCATE TABLE story CASCADE`);

    await seedBaselineEvent(customerPool, "9001", "2024-01-15T03:00:00Z");

    const outcome = await reconcileCustomer(
      customer,
      "Asia/Seoul",
      makeDeps(authPool, customerPool),
    );
    expect(outcome.status).toBe("completed");

    const { rows } = await authPool.query<{ period: string }>(
      `SELECT DISTINCT period
         FROM periodic_report_state
        WHERE customer_id = $1
        ORDER BY period`,
      [customer],
    );
    const periods = rows.map((r) => r.period).sort();
    // LIVE MUST be absent; DAILY/WEEKLY/MONTHLY are seeded from the
    // historical event_time.
    expect(periods).toEqual(["DAILY", "MONTHLY", "WEEKLY"]);
  });

  it("seeds a LIVE row when only story timestamps fall in the trailing 24h (round-11 review item 1)", async () => {
    // Issue #294 decision 2 sources LIVE bucket existence from ANY
    // source data in the trailing 24h — baseline OR story. The
    // previous LIVE EXISTS check on `deriveAllBuckets` was
    // baseline-only and would leave a story-only customer without a
    // LIVE row even though the spec includes story timestamps in the
    // source set. This test exercises the fixed gate by seeding a
    // recent `story.time_window_start`/`time_window_end` and asserting
    // a LIVE row is created.
    const customer = "00000000-0000-0000-0000-0000000000d0";
    await authPool.query(
      `INSERT INTO customers (id, external_key, name, database_status, timezone)
       VALUES ($1, 'recon-livestory', 'LiveStory', 'active', 'Asia/Seoul')
       ON CONFLICT (id) DO UPDATE SET database_status = 'active'`,
      [customer],
    );
    await customerPool.query(`TRUNCATE TABLE baseline_event CASCADE`);
    await customerPool.query(`TRUNCATE TABLE story CASCADE`);

    const recent = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    await seedStory(customerPool, "8001", "v1", recent);

    const outcome = await reconcileCustomer(
      customer,
      "Asia/Seoul",
      makeDeps(authPool, customerPool),
    );
    expect(outcome.status).toBe("completed");

    const { rows } = await authPool.query<{
      period: string;
      last_event_at: Date | null;
      last_story_received_at: Date | null;
    }>(
      `SELECT period, last_event_at, last_story_received_at
         FROM periodic_report_state
        WHERE customer_id = $1
        ORDER BY period`,
      [customer],
    );
    expect(rows.map((r) => r.period).sort()).toContain("LIVE");

    // Round-17 review item 1: the LIVE seed must populate
    // `last_story_received_at` from the global latest-version story
    // max so the envelope hook's LIVE story proxy can fire later.
    // `last_event_at` stays NULL because the customer has no
    // `baseline_event` rows.
    const liveRow = rows.find((r) => r.period === "LIVE");
    expect(liveRow?.last_event_at).toBeNull();
    const liveStoryAt = liveRow?.last_story_received_at ?? null;
    expect(liveStoryAt).not.toBeNull();
    if (liveStoryAt !== null) {
      expect(new Date(liveStoryAt).toISOString()).toBe(
        new Date(recent).toISOString(),
      );
    }

    // Second pass must remain a no-op (decision-2 idempotence gate).
    const second = await reconcileCustomer(
      customer,
      "Asia/Seoul",
      makeDeps(authPool, customerPool),
    );
    expect(second.periodicStatesSeeded).toBe(0);
    expect(second.periodicStatesPatched).toBe(0);
  });

  it("forward-patches and dirties a story-only LIVE row on a new latest-version story (round-17 review item 1)", async () => {
    // Round-17 gap: round-11 made story-only LIVE rows seedable, but
    // recovery paths still dropped story signals for LIVE
    // (`storyPatchSource = null` for LIVE in reconcile, no story
    // proxy in the envelope-hook WHERE). A story-only LIVE row would
    // stay `ready` forever even when a later story refresh-window /
    // backfill mutated the trailing 24h.
    //
    // This test exercises the reconcile-side recovery: seed a LIVE
    // row from one story, dry-run-job it `done` so the dirty
    // predicate gate (processing/done job exists) is satisfied,
    // mutate the customer-DB story to advance its latest-version
    // `received_at` (the envelope hook is intentionally skipped here
    // — that's the "hook failed" path), then reconcile and assert
    // the LIVE row flipped to `dirty` and `last_story_received_at`
    // forward-patched.
    const customer = "00000000-0000-0000-0000-0000000000d1";
    await authPool.query(
      `INSERT INTO customers (id, external_key, name, database_status, timezone)
       VALUES ($1, 'recon-livestory-r17', 'LiveStoryR17', 'active', 'Asia/Seoul')
       ON CONFLICT (id) DO UPDATE SET database_status = 'active',
                                      timezone = 'Asia/Seoul'`,
      [customer],
    );
    await customerPool.query(`TRUNCATE TABLE baseline_event CASCADE`);
    await customerPool.query(`TRUNCATE TABLE story CASCADE`);
    await authPool.query(
      `DELETE FROM periodic_report_state WHERE customer_id = $1`,
      [customer],
    );
    await authPool.query(
      `DELETE FROM periodic_report_job WHERE customer_id = $1`,
      [customer],
    );

    const initialAt = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    await seedStory(customerPool, "8101", "v1", initialAt);

    // First reconcile seeds the LIVE row with `last_story_received_at`
    // = initialAt and status='ready'.
    let outcome = await reconcileCustomer(
      customer,
      "Asia/Seoul",
      makeDeps(authPool, customerPool),
    );
    expect(outcome.status).toBe("completed");

    // Persist a done dry-run job so the dirty predicate's
    // `EXISTS (processing|done job)` gate is satisfied.
    await authPool.query(
      `INSERT INTO periodic_report_job
         (customer_id, period, bucket_date, tz,
          lang, model_name, model,
          status, generation, dry_run,
          processing_started_at, last_generated_at)
       VALUES ($1, 'LIVE', DATE '1970-01-01', 'Asia/Seoul',
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

    // Mutate the customer-DB story so its latest-version received_at
    // advances. This is the "envelope hook failed" path: no auth-DB
    // write happens here — reconcile must catch it.
    const advancedAt = new Date(Date.now() - 5 * 60 * 1000).toISOString();
    await seedStory(customerPool, "8101", "v2", advancedAt);

    outcome = await reconcileCustomer(
      customer,
      "Asia/Seoul",
      makeDeps(authPool, customerPool),
    );
    expect(outcome.status).toBe("completed");
    expect(outcome.periodicStatesPatched).toBeGreaterThanOrEqual(1);

    const { rows: after } = await authPool.query<{
      status: string;
      last_story_received_at: Date | null;
    }>(
      `SELECT status, last_story_received_at
         FROM periodic_report_state
        WHERE customer_id = $1
          AND period      = 'LIVE'
          AND bucket_date = DATE '1970-01-01'
          AND tz          = 'Asia/Seoul'`,
      [customer],
    );
    expect(after[0].status).toBe("dirty");
    const advancedStoryAt = after[0].last_story_received_at;
    expect(advancedStoryAt).not.toBeNull();
    if (advancedStoryAt !== null) {
      expect(new Date(advancedStoryAt).toISOString()).toBe(
        new Date(advancedAt).toISOString(),
      );
    }

    // Second pass must remain a no-op (decision-2 idempotence gate).
    const second = await reconcileCustomer(
      customer,
      "Asia/Seoul",
      makeDeps(authPool, customerPool),
    );
    expect(second.periodicStatesSeeded).toBe(0);
    expect(second.periodicStatesPatched).toBe(0);
  });

  it("does not dirty LIVE on a historical backfill outside the rolling window (round-18 review item 1)", async () => {
    // Round-18: the reconcile loaders for LIVE source signals
    // (`loadLatestBaselineActivity` and `loadLatestStoryActivity`)
    // are scoped to the rolling LIVE window (`event_time >= NOW()-24h`
    // for baseline; `time_window_*` overlapping `[NOW()-24h, NOW())`
    // for story). Before the fix they took the global max across
    // every row, so a same-day backfill of historical data — whose
    // `event_time` / `time_window_*` is years old but whose
    // `received_at` is fresh — would advance `last_event_received_at`
    // / `last_story_received_at` on the LIVE row and trip the dirty
    // trigger. After the fix, the loader's filtered maxima do not
    // change on a historical backfill, so reconcile leaves the LIVE
    // row in `ready`.
    const customer = "00000000-0000-0000-0000-0000000000d2";
    await authPool.query(
      `INSERT INTO customers (id, external_key, name, database_status, timezone)
       VALUES ($1, 'recon-live-r18', 'LiveR18', 'active', 'Asia/Seoul')
       ON CONFLICT (id) DO UPDATE SET database_status = 'active',
                                      timezone = 'Asia/Seoul'`,
      [customer],
    );
    await customerPool.query(`TRUNCATE TABLE baseline_event CASCADE`);
    await customerPool.query(`TRUNCATE TABLE story CASCADE`);
    await authPool.query(
      `DELETE FROM periodic_report_state WHERE customer_id = $1`,
      [customer],
    );
    await authPool.query(
      `DELETE FROM periodic_report_job WHERE customer_id = $1`,
      [customer],
    );

    // Current rolling-window data: one story whose time window lies
    // inside the trailing 24h. This seeds a LIVE row on the first
    // reconcile pass with `last_story_received_at` = currentAt.
    const currentAt = new Date(Date.now() - 30 * 60 * 1000).toISOString();
    await seedStory(customerPool, "8201", "v1", currentAt);

    let outcome = await reconcileCustomer(
      customer,
      "Asia/Seoul",
      makeDeps(authPool, customerPool),
    );
    expect(outcome.status).toBe("completed");

    // Persist a done dry-run job so the dirty predicate gate is
    // satisfied (worker has already produced a generation for this
    // LIVE row). Without this gate the LIVE row would stay `ready`
    // anyway and the assertion would not distinguish round-18.
    await authPool.query(
      `INSERT INTO periodic_report_job
         (customer_id, period, bucket_date, tz,
          lang, model_name, model,
          status, generation, dry_run,
          processing_started_at, last_generated_at)
       VALUES ($1, 'LIVE', DATE '1970-01-01', 'Asia/Seoul',
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

    // Backfill a historical baseline event (years-old event_time) and
    // a historical story (years-old `time_window_*`). Both rows have
    // a fresh customer-DB `received_at` (the default NOW()) — the
    // exact configuration that would have advanced the LIVE row's
    // `last_event_received_at` / `last_story_received_at` under the
    // pre-round-18 global-max loaders.
    await seedBaselineEvent(customerPool, "8202", "2020-01-15T08:00:00Z");
    await customerPool.query(
      `INSERT INTO story
         (story_id, story_version, kind, time_window_start, time_window_end,
          summary_payload, source_aice_id, received_at)
       VALUES (8203::bigint, 'v1', 'auto_correlated',
               '2020-01-15T08:00:00Z'::timestamptz,
               '2020-01-15T08:05:00Z'::timestamptz,
               '{}'::jsonb, 'aice-r18', NOW())`,
    );

    outcome = await reconcileCustomer(
      customer,
      "Asia/Seoul",
      makeDeps(authPool, customerPool),
    );
    expect(outcome.status).toBe("completed");

    const { rows } = await authPool.query<{
      status: string;
      last_event_at: Date | null;
      last_event_received_at: Date | null;
      last_story_received_at: Date | null;
    }>(
      `SELECT status, last_event_at, last_event_received_at,
              last_story_received_at
         FROM periodic_report_state
        WHERE customer_id = $1
          AND period      = 'LIVE'
          AND bucket_date = DATE '1970-01-01'
          AND tz          = 'Asia/Seoul'`,
      [customer],
    );
    expect(rows[0]?.status).toBe("ready");
    // The historical baseline event must NOT advance LIVE source
    // columns: `event_time` is outside the rolling 24h, so the
    // filtered loader returns NULL for baseline maxima and the
    // existing NULLs / current values stay put.
    expect(rows[0]?.last_event_at).toBeNull();
    expect(rows[0]?.last_event_received_at).toBeNull();
    // Story `last_story_received_at` stays at the value seeded from
    // the current (rolling-window) story; the historical story (whose
    // `time_window_*` is outside the rolling window) is filtered out
    // by `loadLatestStoryActivity`, so the LIVE row's stored value
    // is unchanged.
    expect(rows[0]?.last_story_received_at?.toISOString()).toBe(
      new Date(currentAt).toISOString(),
    );

    // Second pass is a no-op — confirms the loader's filtered maxima
    // are stable across reconcile cycles even with historical rows
    // sitting in the customer DB.
    const second = await reconcileCustomer(
      customer,
      "Asia/Seoul",
      makeDeps(authPool, customerPool),
    );
    expect(second.periodicStatesSeeded).toBe(0);
    expect(second.periodicStatesPatched).toBe(0);
  });

  it("archives periodic_report_state rows on tz change via the customers UPDATE trigger (round-8 review item 2)", async () => {
    // Round-8 review item 2: the customer-level timezone change
    // (admin SQL path, no UI in Phase 0) must archive any existing
    // `periodic_report_state` rows whose `tz` does not match the
    // new `customers.timezone`. The trigger added in migration
    // 0030 fires on UPDATE OF timezone and runs the archive SET.
    const customer = "00000000-0000-0000-0000-0000000000cb";
    await authPool.query(
      `INSERT INTO customers (id, external_key, name, database_status, timezone)
       VALUES ($1, 'recon-tz', 'TZ', 'active', 'Asia/Seoul')
       ON CONFLICT (id) DO UPDATE SET database_status = 'active',
                                      timezone = 'Asia/Seoul'`,
      [customer],
    );
    // Pre-seed three Asia/Seoul rows (one of each period) so we
    // can verify the trigger archives all of them.
    await authPool.query(
      `INSERT INTO periodic_report_state
         (customer_id, period, bucket_date, tz, status)
       VALUES
         ($1, 'LIVE',    DATE '1970-01-01', 'Asia/Seoul', 'ready'),
         ($1, 'DAILY',   DATE '2026-05-20', 'Asia/Seoul', 'ready'),
         ($1, 'MONTHLY', DATE '2026-05-01', 'Asia/Seoul', 'pending')`,
      [customer],
    );

    // Admin SQL path — UPDATE customers.timezone.
    await authPool.query(
      `UPDATE customers SET timezone = 'America/Los_Angeles' WHERE id = $1`,
      [customer],
    );

    const { rows } = await authPool.query<{ period: string; status: string }>(
      `SELECT period, status
         FROM periodic_report_state
        WHERE customer_id = $1
        ORDER BY period, bucket_date`,
      [customer],
    );
    expect(rows.length).toBe(3);
    for (const r of rows) expect(r.status).toBe("archived");

    // A subsequent reconcile pass for the new tz must not resurrect
    // the archived rows: forward-patch skips archived (existing
    // behavior). The trigger leaves the old-tz rows terminal and
    // any new-tz rows are seeded lazily by reconcile when source
    // data exists.
    const newTzOutcome = await reconcileCustomer(
      customer,
      "America/Los_Angeles",
      makeDeps(authPool, customerPool),
    );
    expect(newTzOutcome.status).toBe("completed");
    const { rows: stillArchived } = await authPool.query<{ status: string }>(
      `SELECT status FROM periodic_report_state
        WHERE customer_id = $1 AND tz = 'Asia/Seoul'`,
      [customer],
    );
    for (const r of stillArchived) expect(r.status).toBe("archived");
  });

  it("runReconcileTick excludes customers with no recent activity", async () => {
    // Add an inactive-by-scope customer: 'active' database_status but
    // no state rows, no audit hits, no redaction-range rows.
    const dormant = "00000000-0000-0000-0000-0000000000c3";
    await authPool.query(
      `INSERT INTO customers (id, external_key, name, database_status, timezone)
       VALUES ($1, 'recon-3', 'Dormant', 'active', 'Asia/Seoul')
       ON CONFLICT (id) DO NOTHING`,
      [dormant],
    );

    const tickOutcome = await runReconcileTick(
      makeDeps(authPool, customerPool),
    );
    // Dormant customer must be excluded — the active-customer scope
    // (decision 2) only walks customers with recent state/audit/
    // redaction-range activity.
    expect(tickOutcome.customers.some((c) => c.customerId === dormant)).toBe(
      false,
    );
  });

  it("includes a customer whose only recent activity is a customer_redaction_ranges deletion (round-10 review item 2)", async () => {
    // A redaction-range DELETE removes the auth-DB row and emits a
    // `customer_redaction_ranges.deleted` audit row. The auth-DB
    // clause cannot see the deletion (the row is gone); the audit-DB
    // clause is the only remaining signal. Issue #294 decision 2
    // includes redaction-range changes in the active set, and round-10
    // review item 2 flagged that deletions were missing from the
    // audit-action allowlist.
    const delCustomer = "00000000-0000-0000-0000-0000000000dd";
    await authPool.query(
      `INSERT INTO customers (id, external_key, name, database_status, timezone)
       VALUES ($1, 'recon-del', 'DelOnly', 'active', 'Asia/Seoul')
       ON CONFLICT (id) DO NOTHING`,
      [delCustomer],
    );

    // Minimal mock audit pool. Reconcile only invokes `query` against
    // the audit pool with a single SELECT — anything else is unused.
    let captured = "";
    const mockAuditPool = {
      query: async (sql: string) => {
        captured = sql;
        return { rows: [{ customer_id: delCustomer }] };
      },
    } as unknown as Pool;

    const tickOutcome = await runReconcileTick({
      authPool,
      auditPool: mockAuditPool,
      connectCustomer: makeDeps(authPool, customerPool).connectCustomer,
    });

    // The audit-DB clause must filter on the `customer_redaction_ranges.*`
    // action family so a delete-only customer is picked up.
    expect(captured).toMatch(/customer_redaction_ranges\.%/);
    expect(
      tickOutcome.customers.some((c) => c.customerId === delCustomer),
    ).toBe(true);
  });
});
