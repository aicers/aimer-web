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
//     the current `customers.timezone` and observed source data.
//     Bucket derivation uses ALL observed source timestamps, not just
//     the trailing 24h — a backfill committed today with old
//     `event_time` values must still produce its historical buckets
//     (round-2 review item 2).
//   - Forward-patch `first_member_at` / `last_member_at` from
//     `story.received_at` (proxy for member arrival — `story_member`
//     itself has no timestamp; see decision 1).
//   - Forward-patch `last_event_at` on periodic rows (LIVE + every
//     existing DAILY/WEEKLY/MONTHLY bucket) from
//     `baseline_event.event_time`, computed per-bucket so an event
//     that lands inside a closed bucket forwards the right row.
//   - Mirror the ingest-hook dirty trigger: when a forward-patch
//     advances `last_member_at` / `last_event_at` on a `ready` row
//     that already has a `processing`/`done` job, flip the row to
//     `dirty`. Without this, a successful customer-DB commit
//     followed by a failed best-effort hook would leave a stale
//     `ready` analysis indefinitely — the worker only picks up
//     `dirty` rows or `ready` rows missing their default-variant job.
//   - Never roll a value backwards. Never touch `archived` rows.
//
// Active-customer scope (decision 2): a customer is reconciled if any
// of the following holds in the last 24h —
//   (a) a non-archived state row was updated, or
//   (b) an audit row with action in {phase2.ingest, phase2.ingest_failed,
//       phase2.refresh_window, phase2.backfill} exists for the customer, or
//   (c) a `customer_redaction_ranges` row was created for the customer.
// Customers outside this set are skipped to keep the scan bounded.
//
// Batching (decision 2): per-customer work pages by `(customer_id,
// story_id)` and `(customer_id, period, bucket_date, tz)` at
// `ANALYSIS_RECONCILE_BATCH_SIZE` (default 500) per page so a customer
// with millions of stories does not load everything into memory.
//
// Idempotence is the key acceptance criterion (issue verification
// gate): the second pass over the same customer set must report
// zero seeds and zero forward-patches.

import "server-only";

import type { Pool, PoolClient } from "pg";
import { LIVE_BUCKET_DATE, type PeriodicPeriod } from "./state";

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const DEFAULT_BATCH_SIZE = 500;

function resolveBatchSize(): number {
  const raw = process.env.ANALYSIS_RECONCILE_BATCH_SIZE;
  if (raw == null || raw === "") return DEFAULT_BATCH_SIZE;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_BATCH_SIZE;
  return Math.floor(n);
}

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
  /**
   * Audit-DB pool. Used to filter the active-customer scope by recent
   * `phase2.*` audit rows. Optional so tests that do not need the
   * audit clause can pass `undefined`; production callers should
   * always supply it.
   */
  auditPool?: Pool;
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
 * Build the active-customer set for reconciliation per decision 2.
 *
 * The auth-DB clause covers (a) non-archived state rows updated in
 * the trailing 24h and (c) recent `customer_redaction_ranges` rows.
 * The audit-DB clause covers (b) recent `phase2.*` audit activity for
 * customers that may have no state row yet (the case the safety net
 * exists to recover — a hook failure with no auth-DB row written).
 *
 * The union is filtered back through `customers.database_status =
 * 'active'` so an audit-only hit for a since-deactivated customer
 * does not produce a customer-DB connection attempt.
 */
async function listActiveCustomers(
  authPool: Pool,
  auditPool: Pool | undefined,
): Promise<ActiveCustomerRow[]> {
  const auditCustomerIds = await loadAuditActiveCustomerIds(auditPool);
  const { rows } = await authPool.query<ActiveCustomerRow>(
    `SELECT c.id::text AS customer_id, c.timezone
       FROM customers c
      WHERE c.database_status = 'active'
        AND (
          c.id = ANY($1::uuid[])
          OR EXISTS (
            SELECT 1 FROM story_analysis_state s
             WHERE s.customer_id = c.id
               AND s.status <> 'archived'
               AND s.updated_at >= NOW() - INTERVAL '24 hours'
          )
          OR EXISTS (
            SELECT 1 FROM periodic_report_state p
             WHERE p.customer_id = c.id
               AND p.status <> 'archived'
               AND p.updated_at >= NOW() - INTERVAL '24 hours'
          )
          OR EXISTS (
            SELECT 1 FROM customer_redaction_ranges r
             WHERE r.customer_id = c.id
               AND r.created_at >= NOW() - INTERVAL '24 hours'
          )
        )
      ORDER BY c.id`,
    [auditCustomerIds],
  );
  return rows;
}

async function loadAuditActiveCustomerIds(
  auditPool: Pool | undefined,
): Promise<string[]> {
  if (!auditPool) return [];
  try {
    const { rows } = await auditPool.query<{ customer_id: string }>(
      `SELECT DISTINCT customer_id::text AS customer_id
         FROM audit_logs
        WHERE customer_id IS NOT NULL
          AND timestamp >= NOW() - INTERVAL '24 hours'
          AND action IN (
            'phase2.ingest',
            'phase2.ingest_failed',
            'phase2.refresh_window',
            'phase2.backfill'
          )`,
    );
    return rows.map((r) => r.customer_id);
  } catch (err) {
    // Audit DB failures must not stall the scan — the auth-DB clauses
    // are the primary signal. Log and proceed with an empty audit set.
    console.error(
      "[analysis-reconcile] audit pool query failed, proceeding without audit-active customers:",
      err,
    );
    return [];
  }
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
 * Page through `story_id` aggregates in the customer DB by ascending
 * `story_id`. Each page returns `MIN(received_at)` and
 * `MAX(received_at)` across all `story_version` rows.
 *
 * Per decision 1, `first_member_at = MIN(story.received_at)` and
 * `last_member_at = MAX(story.received_at)` because `story_member`
 * has no timestamp column.
 */
async function loadStoryAggregatePage(
  customerConn: CustomerConnection,
  afterStoryId: string | null,
  pageSize: number,
): Promise<StoryAggregateRow[]> {
  const { rows } = await customerConn.query<StoryAggregateRow>(
    `SELECT story_id::text AS story_id,
            MIN(received_at) AS first_received_at,
            MAX(received_at) AS last_received_at
       FROM story
      WHERE $1::bigint IS NULL OR story_id > $1::bigint
      GROUP BY story_id
      ORDER BY story_id
      LIMIT $2`,
    [afterStoryId, pageSize],
  );
  return rows;
}

interface StoryStateExistingRow {
  story_id: string;
  status: "pending" | "ready" | "dirty" | "archived";
  first_member_at: Date | null;
  last_member_at: Date | null;
}

async function loadExistingStoryStatesForIds(
  authClient: PoolClient,
  customerId: string,
  storyIds: readonly string[],
): Promise<Map<string, StoryStateExistingRow>> {
  if (storyIds.length === 0) return new Map();
  const { rows } = await authClient.query<StoryStateExistingRow>(
    `SELECT story_id::text AS story_id, status,
            first_member_at, last_member_at
       FROM story_analysis_state
      WHERE customer_id = $1
        AND story_id = ANY($2::bigint[])`,
    [customerId, storyIds],
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
  batchSize: number,
): Promise<StorySeedPatchCounts> {
  let seeded = 0;
  let patched = 0;
  let cursor: string | null = null;

  while (true) {
    const aggregates = await loadStoryAggregatePage(
      customerConn,
      cursor,
      batchSize,
    );
    if (aggregates.length === 0) break;

    const storyIds = aggregates.map((a) => a.story_id);
    const existing = await loadExistingStoryStatesForIds(
      authClient,
      customerId,
      storyIds,
    );

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

      // Forward-patch only: LEAST/GREATEST guards keep the second pass
      // a no-op. `first_member_at` only moves earlier; `last_member_at`
      // only moves later.
      const needsFirstPatch =
        cur.first_member_at === null ||
        agg.first_received_at.getTime() < cur.first_member_at.getTime();
      const needsLastPatch =
        cur.last_member_at === null ||
        agg.last_received_at.getTime() > cur.last_member_at.getTime();
      if (!needsFirstPatch && !needsLastPatch) continue;

      // Mirror the ingest-hook dirty trigger: when the forward-patch
      // moves `last_member_at` later AND the row is `ready` with a
      // processing/done job, flip it to `dirty`. The worker's pickup
      // filter selects only `dirty` or `ready` rows missing their
      // default-variant job, so without this branch a successful
      // customer-DB commit followed by a failed `applyStoryIngestHook`
      // would leave the stale analysis ready indefinitely (round-6
      // review item 1). Idempotent: a second pass finds
      // `last_member_at` already == new value, the CASE WHEN is false,
      // and no transition happens.
      await authClient.query(
        `UPDATE story_analysis_state
            SET first_member_at = LEAST(
                  COALESCE(first_member_at, $3::timestamptz), $3::timestamptz
                ),
                last_member_at = GREATEST(
                  COALESCE(last_member_at,  $4::timestamptz), $4::timestamptz
                ),
                status = CASE
                  WHEN status = 'ready'
                    AND (last_member_at IS NULL
                         OR $4::timestamptz > last_member_at)
                    AND EXISTS (
                      SELECT 1 FROM story_analysis_job j
                       WHERE j.customer_id = $1
                         AND j.story_id    = $2::bigint
                         AND j.status IN ('processing', 'done')
                    )
                  THEN 'dirty'
                  ELSE status
                END,
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

    cursor = aggregates[aggregates.length - 1].story_id;
    if (aggregates.length < batchSize) break;
  }

  return { seeded, patched };
}

// ---------------------------------------------------------------------------
// Periodic state seed + forward-patch
// ---------------------------------------------------------------------------

interface BucketRow {
  period: PeriodicPeriod;
  bucket_date: string;
}

/**
 * Derive the complete set of distinct `(period, bucket_date)` triples
 * that should exist for the customer given its current `tz` and ALL
 * observed source timestamps. The derivation runs in the customer DB
 * (so we get PostgreSQL's tz-aware `date_trunc` semantics) and returns
 * a `DISTINCT`-collapsed result — bounded by time-span, not event
 * count.
 *
 * No `event_time >= NOW() - 24h` filter (round-2 review item 2): a
 * backfill committed today with old event_time values must still
 * derive its historical buckets. The active-customer scope above
 * already gates whether we run this query at all.
 */
async function deriveAllBuckets(
  customerConn: CustomerConnection,
  tz: string,
): Promise<BucketRow[]> {
  const { rows } = await customerConn.query<BucketRow>(
    `WITH latest_story AS (
       SELECT story_id, MAX(received_at) AS max_rcv
         FROM story
        GROUP BY story_id
     ),
     src AS (
       SELECT event_time AS ts FROM baseline_event
       UNION ALL
       SELECT s.time_window_start FROM story s
         JOIN latest_story ls
           ON ls.story_id = s.story_id AND ls.max_rcv = s.received_at
       UNION ALL
       SELECT s.time_window_end FROM story s
         JOIN latest_story ls
           ON ls.story_id = s.story_id AND ls.max_rcv = s.received_at
     )
     SELECT DISTINCT 'DAILY'::text AS period,
            (date_trunc('day', ts AT TIME ZONE $1))::date::text AS bucket_date
       FROM src
     UNION
     SELECT DISTINCT 'WEEKLY'::text AS period,
            (date_trunc('week', ts AT TIME ZONE $1))::date::text AS bucket_date
       FROM src
     UNION
     SELECT DISTINCT 'MONTHLY'::text AS period,
            (date_trunc('month', ts AT TIME ZONE $1))::date::text AS bucket_date
       FROM src
     UNION
     SELECT 'LIVE'::text AS period,
            $2::date::text AS bucket_date
       WHERE EXISTS (SELECT 1 FROM src)`,
    [tz, LIVE_BUCKET_DATE],
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

interface BucketMaxEventRow {
  period: PeriodicPeriod;
  bucket_date: string;
  max_event_at: Date;
}

/**
 * Per-bucket max `baseline_event.event_time`, keyed by
 * `(period, bucket_date)` in the customer's `tz`. Used to
 * forward-patch `last_event_at` on existing DAILY / WEEKLY / MONTHLY
 * rows so a baseline batch whose event lands inside an already-done
 * closed bucket can advance that bucket's `last_event_at` (and flip
 * it `dirty`) when the auth-DB hook failed after the customer-DB
 * commit (round-6 review item 2).
 */
async function loadPerBucketMaxEventTimes(
  customerConn: CustomerConnection,
  tz: string,
): Promise<Map<string, Date>> {
  const { rows } = await customerConn.query<BucketMaxEventRow>(
    `SELECT 'DAILY'::text AS period,
            (date_trunc('day', event_time AT TIME ZONE $1))::date::text
              AS bucket_date,
            MAX(event_time) AS max_event_at
       FROM baseline_event
       GROUP BY 1, 2
     UNION ALL
     SELECT 'WEEKLY'::text,
            (date_trunc('week', event_time AT TIME ZONE $1))::date::text,
            MAX(event_time)
       FROM baseline_event
       GROUP BY 1, 2
     UNION ALL
     SELECT 'MONTHLY'::text,
            (date_trunc('month', event_time AT TIME ZONE $1))::date::text,
            MAX(event_time)
       FROM baseline_event
       GROUP BY 1, 2`,
    [tz],
  );
  const out = new Map<string, Date>();
  for (const r of rows) {
    out.set(`${r.period}|${r.bucket_date}|${tz}`, r.max_event_at);
  }
  return out;
}

interface PeriodicExistingRow {
  period: PeriodicPeriod;
  bucket_date: string;
  tz: string;
  status: "pending" | "ready" | "dirty" | "archived";
  last_event_at: Date | null;
}

async function loadExistingPeriodicStatesForBuckets(
  authClient: PoolClient,
  customerId: string,
  tz: string,
  buckets: readonly BucketRow[],
): Promise<Map<string, PeriodicExistingRow>> {
  if (buckets.length === 0) return new Map();
  const periods = buckets.map((b) => b.period);
  const dates = buckets.map((b) => b.bucket_date);
  const { rows } = await authClient.query<PeriodicExistingRow>(
    `SELECT period, bucket_date::text AS bucket_date, tz, status, last_event_at
       FROM periodic_report_state
      WHERE customer_id = $1
        AND tz          = $2
        AND (period, bucket_date) IN (
          SELECT p, d FROM unnest($3::text[], $4::date[]) AS u(p, d)
        )`,
    [customerId, tz, periods, dates],
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
  batchSize: number,
): Promise<PeriodicSeedPatchCounts> {
  const allBuckets = await deriveAllBuckets(customerConn, customerTz);
  if (allBuckets.length === 0) return { seeded: 0, patched: 0 };

  // Pin a single `latestBaseline` value across the entire customer
  // pass: LIVE seed and forward-patch must agree, or the second pass
  // would forward-patch a row we just inserted.
  const latestBaseline = await loadLatestBaselineEventTime(customerConn);
  // Per-bucket max event_time for DAILY/WEEKLY/MONTHLY forward-patch.
  // Computed once per customer so a single round trip serves every
  // existing-row update below — same idempotence guarantee as the
  // LIVE path.
  const bucketMaxEvent = await loadPerBucketMaxEventTimes(
    customerConn,
    customerTz,
  );

  let seeded = 0;
  let patched = 0;

  // Page through derived buckets by `(period, bucket_date)`. The
  // existing-row lookup is scoped to the page so memory stays bounded
  // when the time-span is multi-year.
  for (let i = 0; i < allBuckets.length; i += batchSize) {
    const page = allBuckets.slice(i, i + batchSize);
    const existing = await loadExistingPeriodicStatesForBuckets(
      authClient,
      customerId,
      customerTz,
      page,
    );

    for (const b of page) {
      const key = `${b.period}|${b.bucket_date}|${customerTz}`;
      if (!existing.has(key)) {
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
          // Seed DAILY/WEEKLY/MONTHLY with `last_event_at` already
          // populated from the per-bucket max event time. The
          // forward-patch branch below would otherwise patch the
          // freshly-seeded NULL on the next pass and break the
          // decision-2 idempotence acceptance criterion.
          const seedLastEventAt = bucketMaxEvent.get(key);
          await authClient.query(
            `INSERT INTO periodic_report_state
               (customer_id, period, bucket_date, tz, status, last_event_at)
             VALUES ($1, $2, $3::date, $4, 'pending', $5)
             ON CONFLICT (customer_id, period, bucket_date, tz) DO NOTHING`,
            [
              customerId,
              b.period,
              b.bucket_date,
              customerTz,
              seedLastEventAt ? seedLastEventAt.toISOString() : null,
            ],
          );
        }
        seeded += 1;
        continue;
      }

      // Forward-patch `last_event_at` on existing rows. Both LIVE and
      // DAILY/WEEKLY/MONTHLY are reconciled here so an existing closed
      // bucket whose hook failed (round-6 review item 2) still
      // observes its missed `event_time` and — if a processing/done
      // job already exists — transitions `ready → dirty` to trigger
      // re-analysis.
      const row = existing.get(key);
      if (!row) continue;
      if (row.status === "archived") continue;

      const patchSource =
        b.period === "LIVE"
          ? latestBaseline
          : (bucketMaxEvent.get(key) ?? null);
      if (patchSource === null) continue;
      if (
        row.last_event_at !== null &&
        patchSource.getTime() <= row.last_event_at.getTime()
      ) {
        continue;
      }

      // The CASE WHEN mirrors `recordBaselineActivity`'s dirty trigger
      // exactly: only `ready` rows with at least one processing/done
      // job flip to `dirty`. `pending` and `dirty` rows are
      // forward-patched without status change. Idempotent: a second
      // pass finds `last_event_at >= patchSource` and the WHERE clause
      // makes the UPDATE a no-op.
      const res = await authClient.query(
        `UPDATE periodic_report_state s
            SET last_event_at = GREATEST(
                  COALESCE(s.last_event_at, $5::timestamptz), $5::timestamptz
                ),
                status = CASE
                  WHEN s.status = 'ready'
                    AND (s.last_event_at IS NULL
                         OR $5::timestamptz > s.last_event_at)
                    AND EXISTS (
                      SELECT 1 FROM periodic_report_job j
                       WHERE j.customer_id = s.customer_id
                         AND j.period      = s.period
                         AND j.bucket_date = s.bucket_date
                         AND j.tz          = s.tz
                         AND j.status IN ('processing', 'done')
                    )
                  THEN 'dirty'
                  ELSE s.status
                END,
                updated_at = NOW()
          WHERE s.customer_id = $1
            AND s.period      = $2
            AND s.bucket_date = $3::date
            AND s.tz          = $4
            AND s.status      <> 'archived'
            AND (s.last_event_at IS NULL
                 OR s.last_event_at < $5::timestamptz)`,
        [
          customerId,
          b.period,
          b.bucket_date,
          customerTz,
          patchSource.toISOString(),
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
  const batchSize = resolveBatchSize();
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
    const story = await reconcileStoryStates(
      customerId,
      conn,
      authClient,
      batchSize,
    );
    const periodic = await reconcilePeriodicStates(
      customerId,
      customerTz,
      conn,
      authClient,
      batchSize,
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
  const customers = await listActiveCustomers(deps.authPool, deps.auditPool);
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
