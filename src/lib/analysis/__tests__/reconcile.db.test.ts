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

  it("does not touch archived story_analysis_state rows", async () => {
    await authPool.query(
      `UPDATE story_analysis_state
          SET status = 'archived', updated_at = NOW()
        WHERE customer_id = $1 AND story_id = 9001`,
      [CUSTOMER_ID],
    );
    // Add yet another story_version with a later received_at — would
    // normally trigger a forward-patch, but the row is archived.
    await seedStory(customerPool, "9001", "v4", "2026-05-26T13:00:00Z");

    const outcome = await reconcileCustomer(
      CUSTOMER_ID,
      "Asia/Seoul",
      makeDeps(authPool, customerPool),
    );
    expect(outcome.storyStatesPatched).toBe(0);

    const { rows } = await authPool.query(
      `SELECT status, last_member_at
         FROM story_analysis_state
        WHERE customer_id = $1 AND story_id = 9001`,
      [CUSTOMER_ID],
    );
    expect(rows[0].status).toBe("archived");
    expect(rows[0].last_member_at.toISOString()).toBe(
      "2026-05-26T12:00:00.000Z",
    );
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
});
