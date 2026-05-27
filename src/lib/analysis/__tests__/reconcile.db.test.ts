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
});
