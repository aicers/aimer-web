// RFC 0002 Phase 0 (#294) — cross-DB reconciliation for analysis state.
//
// Ingest hooks (`ingest-hooks.ts`) write `*_state` rows to the auth DB
// after the customer-DB commit succeeds. Those two writes cannot be
// atomic — a customer-DB ingest commit followed by an auth-DB hook
// failure leaves customer-DB rows visible with no corresponding state
// row. Issue #294 decision 2 is the safety net: an idempotent scan
// that (a) seeds missing state rows, (b) forward-patches lagging
// columns on existing rows, and (c) is provably a no-op on its second
// pass over the same customer set.
//
// Reconciliation rules (decision 2):
//
//   - Seed missing `story_analysis_state` rows from `story.story_id`.
//   - Seed missing `periodic_report_state` rows by deriving the set
//     of `(period, bucket_date, tz)` triples that should exist given
//     the current `customers.timezone` and observed source data in
//     the trailing 24h.
//   - Forward-patch `first_member_at` / `last_member_at` from
//     `story.received_at` (proxy for member arrival — `story_member`
//     itself has no timestamp; see decision 1).
//   - Forward-patch `last_event_at` on periodic rows from
//     `baseline_event.event_time`.
//   - Never roll a value backwards. Never touch `archived` rows.
//
// Idempotence is the key acceptance criterion (issue verification
// gate): the second pass over the same customer set must report
// zero seeds and zero forward-patches.

import "server-only";

import type { Pool, PoolClient } from "pg";
import { LIVE_BUCKET_DATE, type PeriodicPeriod } from "./state";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface ReconcileCustomerOutcome {
  customerId: string;
  status: "completed" | "skipped" | "failed";
  storyStatesSeeded: number;
  storyStatesPatched: number;
  periodicStatesSeeded: number;
  periodicStatesPatched: number;
  errorMessage?: string;
}

export interface ReconcileTickOutcome {
  customers: ReconcileCustomerOutcome[];
  totalStoryStatesSeeded: number;
  totalStoryStatesPatched: number;
  totalPeriodicStatesSeeded: number;
  totalPeriodicStatesPatched: number;
}

/**
 * A pg-compatible interface for the customer DB. Mirrors the retention
 * sweeper's `CustomerConnection` so tests can pass a `PoolClient`
 * directly.
 */
export interface CustomerConnection {
  query: PoolClient["query"];
  end: () => Promise<void>;
}

export interface ReconcileDeps {
  authPool: Pool;
  connectCustomer: (customerId: string) => Promise<CustomerConnection>;
}

// ---------------------------------------------------------------------------
// Active-customer scope
// ---------------------------------------------------------------------------

interface ActiveCustomerRow {
  customer_id: string;
  timezone: string;
}

/**
 * Active set for reconciliation. We walk every customer whose
 * `customers.database_status = 'active'` and let the per-customer SQL
 * short-circuit when there is no source data. This is operationally
 * equivalent to the issue's "audit row in last 24h OR state row OR
 * customer_redaction_ranges change" rule (decision 2): inactive
 * customers fall out of the loop via `database_status`, and customers
 * with no source data emit zero seeds and zero patches.
 *
 * Walking all active customers — rather than joining against audit
 * actions — keeps the scan self-contained in the auth DB and avoids
 * coupling reconcile to the audit-log retention window.
 */
async function listActiveCustomers(
  authPool: Pool,
): Promise<ActiveCustomerRow[]> {
  const { rows } = await authPool.query<ActiveCustomerRow>(
    `SELECT id::text AS customer_id, timezone
       FROM customers
      WHERE database_status = 'active'
      ORDER BY id`,
  );
  return rows;
}

// ---------------------------------------------------------------------------
// Story state seed + forward-patch
// ---------------------------------------------------------------------------

interface StoryAggregateRow {
  story_id: string;
  first_received_at: Date;
  last_received_at: Date;
}

/**
 * Compute `MIN(received_at)` and `MAX(received_at)` across all
 * `story_version` rows for every `story_id` in the customer DB.
 *
 * Per decision 1, `first_member_at = MIN(story.received_at)` and
 * `last_member_at = MAX(story.received_at)` because `story_member`
 * has no timestamp column. The MIN captures the original-narrative
 * arrival; the MAX captures the latest version's arrival (which equals
 * the canonical version under the window-replace pattern).
 */
async function loadStoryAggregates(
  customerConn: CustomerConnection,
): Promise<StoryAggregateRow[]> {
  const { rows } = await customerConn.query<StoryAggregateRow>(
    `SELECT story_id::text AS story_id,
            MIN(received_at) AS first_received_at,
            MAX(received_at) AS last_received_at
       FROM story
      GROUP BY story_id`,
  );
  return rows;
}

interface StoryStateExistingRow {
  story_id: string;
  status: "pending" | "ready" | "dirty" | "archived";
  first_member_at: Date | null;
  last_member_at: Date | null;
}

async function loadExistingStoryStates(
  authClient: PoolClient,
  customerId: string,
): Promise<Map<string, StoryStateExistingRow>> {
  const { rows } = await authClient.query<StoryStateExistingRow>(
    `SELECT story_id::text AS story_id, status,
            first_member_at, last_member_at
       FROM story_analysis_state
      WHERE customer_id = $1`,
    [customerId],
  );
  const out = new Map<string, StoryStateExistingRow>();
  for (const r of rows) out.set(r.story_id, r);
  return out;
}

interface StorySeedPatchCounts {
  seeded: number;
  patched: number;
}

async function reconcileStoryStates(
  customerId: string,
  customerConn: CustomerConnection,
  authClient: PoolClient,
): Promise<StorySeedPatchCounts> {
  const aggregates = await loadStoryAggregates(customerConn);
  if (aggregates.length === 0) return { seeded: 0, patched: 0 };

  const existing = await loadExistingStoryStates(authClient, customerId);

  let seeded = 0;
  let patched = 0;

  for (const agg of aggregates) {
    const cur = existing.get(agg.story_id);
    if (!cur) {
      // Seed missing row. New rows start `pending`; the worker tick
      // promotes them to `ready` once the readiness rule fires.
      await authClient.query(
        `INSERT INTO story_analysis_state
           (customer_id, story_id, status, first_member_at, last_member_at)
         VALUES ($1, $2::bigint, 'pending', $3, $4)
         ON CONFLICT (customer_id, story_id) DO NOTHING`,
        [
          customerId,
          agg.story_id,
          agg.first_received_at.toISOString(),
          agg.last_received_at.toISOString(),
        ],
      );
      seeded += 1;
      continue;
    }

    // Skip archived rows on forward-patch (decision 2). The next
    // member-arrival hook will unarchive in place.
    if (cur.status === "archived") continue;

    // Forward-patch only: GREATEST guards against rolling values
    // backwards. `first_member_at` is only set if currently NULL;
    // otherwise it stays put (per RFC §"Source state additions":
    // first_member_at is set on first member ingest and never updated
    // thereafter).
    const needsFirstPatch =
      cur.first_member_at === null ||
      agg.first_received_at.getTime() < cur.first_member_at.getTime();
    const needsLastPatch =
      cur.last_member_at === null ||
      agg.last_received_at.getTime() > cur.last_member_at.getTime();

    if (!needsFirstPatch && !needsLastPatch) continue;

    // For first_member_at we use LEAST (earliest wins), because the
    // canonical "first member arrival" is the earliest version's
    // received_at across all story_versions for this story_id. The
    // GREATEST/LEAST guards keep this idempotent on a second pass.
    await authClient.query(
      `UPDATE story_analysis_state
          SET first_member_at = LEAST(
                COALESCE(first_member_at, $3::timestamptz), $3::timestamptz
              ),
              last_member_at = GREATEST(
                COALESCE(last_member_at,  $4::timestamptz), $4::timestamptz
              ),
              updated_at = NOW()
        WHERE customer_id = $1
          AND story_id    = $2::bigint
          AND status      <> 'archived'`,
      [
        customerId,
        agg.story_id,
        agg.first_received_at.toISOString(),
        agg.last_received_at.toISOString(),
      ],
    );
    patched += 1;
  }

  return { seeded, patched };
}

// ---------------------------------------------------------------------------
// Periodic state seed + forward-patch
// ---------------------------------------------------------------------------

interface BucketDerivation {
  period: PeriodicPeriod;
  bucket_date: string;
}

interface SourceTimestampRow {
  ts: Date;
}

/**
 * Collect every source timestamp that should derive a periodic bucket
 * in the trailing 24h. Per decision 2 the source set is:
 *   - `baseline_event.event_time` for the last 24h
 *   - `story.time_window_start` / `story.time_window_end` of the
 *     latest-received_at version of every story_id whose latest
 *     received_at is in the trailing 24h
 *
 * A single UNION query keeps the customer-DB round-trip count low.
 */
async function loadActiveSourceTimestamps(
  customerConn: CustomerConnection,
): Promise<SourceTimestampRow[]> {
  const { rows } = await customerConn.query<SourceTimestampRow>(
    `WITH latest_story AS (
       SELECT story_id,
              MAX(received_at) AS max_rcv
         FROM story
        GROUP BY story_id
       )
     SELECT event_time AS ts
       FROM baseline_event
      WHERE event_time >= NOW() - INTERVAL '24 hours'
     UNION ALL
     SELECT s.time_window_start AS ts
       FROM story s
       JOIN latest_story ls
         ON ls.story_id = s.story_id AND ls.max_rcv = s.received_at
      WHERE ls.max_rcv >= NOW() - INTERVAL '24 hours'
     UNION ALL
     SELECT s.time_window_end AS ts
       FROM story s
       JOIN latest_story ls
         ON ls.story_id = s.story_id AND ls.max_rcv = s.received_at
      WHERE ls.max_rcv >= NOW() - INTERVAL '24 hours'`,
  );
  return rows;
}

/**
 * Latest `baseline_event.event_time` for the customer — used to
 * forward-patch `last_event_at` on the LIVE periodic state row.
 */
async function loadLatestBaselineEventTime(
  customerConn: CustomerConnection,
): Promise<Date | null> {
  const { rows } = await customerConn.query<{ max_ts: Date | null }>(
    `SELECT MAX(event_time) AS max_ts FROM baseline_event`,
  );
  return rows[0]?.max_ts ?? null;
}

/**
 * Derive the four periodic buckets that contain a given source
 * timestamp under a specific customer timezone (per decision 2).
 * LIVE always maps to the synthetic epoch bucket; DAILY/WEEKLY/MONTHLY
 * map to ISO day/week/month starts in that tz.
 *
 * Implemented as a single auth-DB SELECT so we get PostgreSQL's
 * `date_trunc(... AT TIME ZONE tz)::date` semantics for free —
 * doing it in JavaScript would require a tz library and would not
 * match PostgreSQL's ISO week conventions.
 */
async function deriveBucketsForTimestamps(
  authClient: PoolClient,
  tz: string,
  timestamps: Date[],
): Promise<BucketDerivation[]> {
  if (timestamps.length === 0) return [];
  const isoStrings = timestamps.map((d) => d.toISOString());
  const { rows } = await authClient.query<{
    period: PeriodicPeriod;
    bucket_date: string;
  }>(
    `WITH src AS (
       SELECT unnest($1::timestamptz[]) AS ts
     )
     SELECT 'LIVE'::text AS period, $3::date::text AS bucket_date
     UNION
     SELECT 'DAILY'::text AS period,
            (date_trunc('day', ts AT TIME ZONE $2))::date::text AS bucket_date
       FROM src
     UNION
     SELECT 'WEEKLY'::text AS period,
            (date_trunc('week', ts AT TIME ZONE $2))::date::text AS bucket_date
       FROM src
     UNION
     SELECT 'MONTHLY'::text AS period,
            (date_trunc('month', ts AT TIME ZONE $2))::date::text AS bucket_date
       FROM src`,
    [isoStrings, tz, LIVE_BUCKET_DATE],
  );
  return rows;
}

interface PeriodicExistingRow {
  period: PeriodicPeriod;
  bucket_date: string;
  tz: string;
  status: "pending" | "ready" | "dirty" | "archived";
  last_event_at: Date | null;
}

async function loadExistingPeriodicStates(
  authClient: PoolClient,
  customerId: string,
): Promise<Map<string, PeriodicExistingRow>> {
  const { rows } = await authClient.query<PeriodicExistingRow>(
    `SELECT period, bucket_date::text AS bucket_date, tz, status, last_event_at
       FROM periodic_report_state
      WHERE customer_id = $1`,
    [customerId],
  );
  const out = new Map<string, PeriodicExistingRow>();
  for (const r of rows) {
    out.set(`${r.period}|${r.bucket_date}|${r.tz}`, r);
  }
  return out;
}

interface PeriodicSeedPatchCounts {
  seeded: number;
  patched: number;
}

async function reconcilePeriodicStates(
  customerId: string,
  customerTz: string,
  customerConn: CustomerConnection,
  authClient: PoolClient,
): Promise<PeriodicSeedPatchCounts> {
  const sources = await loadActiveSourceTimestamps(customerConn);
  if (sources.length === 0) return { seeded: 0, patched: 0 };

  const buckets = await deriveBucketsForTimestamps(
    authClient,
    customerTz,
    sources.map((s) => s.ts),
  );
  if (buckets.length === 0) return { seeded: 0, patched: 0 };

  const existing = await loadExistingPeriodicStates(authClient, customerId);
  // Load the latest baseline event time once, up-front. We use it both
  // for the LIVE seed (so we don't have to patch a row we just seeded)
  // and for the LIVE forward-patch on previously-existing rows. Pinning
  // a single value across seed + patch is what makes the second pass
  // a no-op.
  const latestBaseline = await loadLatestBaselineEventTime(customerConn);

  let seeded = 0;
  // Seed missing rows. LIVE rows are seeded `ready` with their
  // `last_event_at` set to the latest baseline event time at scan
  // time — matches what `recordBaselineActivity` would have written
  // had its hook succeeded. Non-LIVE rows are seeded `pending`; the
  // readiness rule for DAILY/WEEKLY/MONTHLY is a Phase 2/3 worker
  // concern and is not implemented here.
  for (const b of buckets) {
    const key = `${b.period}|${b.bucket_date}|${customerTz}`;
    if (existing.has(key)) continue;
    if (b.period === "LIVE") {
      await authClient.query(
        `INSERT INTO periodic_report_state
           (customer_id, period, bucket_date, tz,
            status, last_event_at, last_ready_at)
         VALUES ($1, 'LIVE', $2::date, $3,
                 'ready', $4, NOW())
         ON CONFLICT (customer_id, period, bucket_date, tz) DO NOTHING`,
        [
          customerId,
          LIVE_BUCKET_DATE,
          customerTz,
          latestBaseline ? latestBaseline.toISOString() : null,
        ],
      );
    } else {
      await authClient.query(
        `INSERT INTO periodic_report_state
           (customer_id, period, bucket_date, tz, status)
         VALUES ($1, $2, $3::date, $4, 'pending')
         ON CONFLICT (customer_id, period, bucket_date, tz) DO NOTHING`,
        [customerId, b.period, b.bucket_date, customerTz],
      );
    }
    seeded += 1;
  }

  // Forward-patch last_event_at on an already-existing LIVE row (the
  // only periodic bucket whose `last_event_at` is directly observable
  // in Phase 0). Newly-seeded LIVE rows have their `last_event_at`
  // set at INSERT time above, so this branch only patches lagging
  // pre-existing rows. DAILY/WEEKLY/MONTHLY last_event_at semantics
  // are Phase 2/3 worker concerns and are not reconciled here.
  let patched = 0;
  if (latestBaseline) {
    const liveKey = `LIVE|${LIVE_BUCKET_DATE}|${customerTz}`;
    const liveRow = existing.get(liveKey);
    if (
      liveRow &&
      liveRow.status !== "archived" &&
      (liveRow.last_event_at === null ||
        latestBaseline.getTime() > liveRow.last_event_at.getTime())
    ) {
      const res = await authClient.query(
        `UPDATE periodic_report_state
            SET last_event_at = GREATEST(
                  COALESCE(last_event_at, $4::timestamptz), $4::timestamptz
                ),
                updated_at = NOW()
          WHERE customer_id = $1
            AND period      = 'LIVE'
            AND bucket_date = $2::date
            AND tz          = $3
            AND status      <> 'archived'
            AND (last_event_at IS NULL OR last_event_at < $4::timestamptz)`,
        [
          customerId,
          LIVE_BUCKET_DATE,
          customerTz,
          latestBaseline.toISOString(),
        ],
      );
      if ((res.rowCount ?? 0) > 0) patched += 1;
    }
  }

  return { seeded, patched };
}

// ---------------------------------------------------------------------------
// Per-customer driver
// ---------------------------------------------------------------------------

export async function reconcileCustomer(
  customerId: string,
  customerTz: string,
  deps: ReconcileDeps,
): Promise<ReconcileCustomerOutcome> {
  let conn: CustomerConnection;
  try {
    conn = await deps.connectCustomer(customerId);
  } catch (err) {
    return {
      customerId,
      status: "failed",
      storyStatesSeeded: 0,
      storyStatesPatched: 0,
      periodicStatesSeeded: 0,
      periodicStatesPatched: 0,
      errorMessage: err instanceof Error ? err.message : String(err),
    };
  }

  const authClient = await deps.authPool.connect();
  try {
    await authClient.query("BEGIN");
    const story = await reconcileStoryStates(customerId, conn, authClient);
    const periodic = await reconcilePeriodicStates(
      customerId,
      customerTz,
      conn,
      authClient,
    );
    await authClient.query("COMMIT");
    return {
      customerId,
      status: "completed",
      storyStatesSeeded: story.seeded,
      storyStatesPatched: story.patched,
      periodicStatesSeeded: periodic.seeded,
      periodicStatesPatched: periodic.patched,
    };
  } catch (err) {
    await authClient.query("ROLLBACK").catch(() => {});
    return {
      customerId,
      status: "failed",
      storyStatesSeeded: 0,
      storyStatesPatched: 0,
      periodicStatesSeeded: 0,
      periodicStatesPatched: 0,
      errorMessage: err instanceof Error ? err.message : String(err),
    };
  } finally {
    authClient.release();
    await conn.end().catch(() => {});
  }
}

// ---------------------------------------------------------------------------
// Per-tick driver
// ---------------------------------------------------------------------------

export async function runReconcileTick(
  deps: ReconcileDeps,
): Promise<ReconcileTickOutcome> {
  const customers = await listActiveCustomers(deps.authPool);
  const outcomes: ReconcileCustomerOutcome[] = [];
  let totalStoryStatesSeeded = 0;
  let totalStoryStatesPatched = 0;
  let totalPeriodicStatesSeeded = 0;
  let totalPeriodicStatesPatched = 0;

  for (const c of customers) {
    const o = await reconcileCustomer(c.customer_id, c.timezone, deps);
    outcomes.push(o);
    totalStoryStatesSeeded += o.storyStatesSeeded;
    totalStoryStatesPatched += o.storyStatesPatched;
    totalPeriodicStatesSeeded += o.periodicStatesSeeded;
    totalPeriodicStatesPatched += o.periodicStatesPatched;
    if (o.status === "failed") {
      console.error(
        `[analysis-reconcile] customer ${c.customer_id} failed:`,
        o.errorMessage,
      );
    }
  }

  return {
    customers: outcomes,
    totalStoryStatesSeeded,
    totalStoryStatesPatched,
    totalPeriodicStatesSeeded,
    totalPeriodicStatesPatched,
  };
}
