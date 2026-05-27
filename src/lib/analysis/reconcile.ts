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
 * the trailing 24h and (c) recent `customer_redaction_ranges` rows
 * that still exist. The audit-DB clause covers (b) recent `phase2.*`
 * audit activity for customers that may have no state row yet (the
 * case the safety net exists to recover — a hook failure with no
 * auth-DB row written) AND (d) `customer_redaction_ranges.*` audit
 * rows for customers whose only recent activity is a redaction-range
 * DELETION (round-10 review item 2): a delete removes the auth-DB row
 * outright, so the auth-DB clause (c) cannot see it — the audit row is
 * the only remaining signal.
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
    // Issue #294 decision 2 says a customer is active for reconcile if
    // *any* `customer_redaction_ranges` change touched them. The auth-DB
    // clause already catches additions (the row's `created_at` is in
    // the last 24h) but a deletion REMOVES the row entirely — the only
    // remaining signal is the `customer_redaction_ranges.deleted` audit
    // row (round-10 review item 2). Including the full
    // `customer_redaction_ranges.*` family — added/deleted plus the
    // retroactive-job lifecycle actions — keeps the set complete and
    // mirrors the issue's "a customer_redaction_ranges change touched
    // the customer" phrasing without enumerating each variant separately.
    const { rows } = await auditPool.query<{ customer_id: string }>(
      `SELECT DISTINCT customer_id::text AS customer_id
         FROM audit_logs
        WHERE customer_id IS NOT NULL
          AND timestamp >= NOW() - INTERVAL '24 hours'
          AND (
            action IN (
              'phase2.ingest',
              'phase2.ingest_failed',
              'phase2.refresh_window',
              'phase2.backfill'
            )
            OR action LIKE 'customer_redaction_ranges.%'
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

/**
 * Round-8 review item 1: archive non-archived `story_analysis_state`
 * rows whose `story_id` no longer has any surviving `story` row in
 * customer DB.
 *
 * Why this exists: `applyWindowReplaceStoryHook` calls
 * `maybeArchiveStoryState` when `surviving === 0`, but the hook is
 * best-effort (decision 2). A hook failure leaves a `ready`/jobbed
 * state row permanently non-archived because the main reconcile pass
 * pages from customer-DB `story` aggregates — a `story_id` with zero
 * versions is invisible to that scan. This pass closes the gap by
 * iterating non-archived auth-DB state rows and archiving any whose
 * customer-DB row count is zero.
 *
 * Idempotent: re-running over the same input finds the previously
 * archived rows already at `status='archived'` and skips them.
 */
async function archiveOrphanedStoryStates(
  customerId: string,
  customerConn: CustomerConnection,
  authClient: PoolClient,
  batchSize: number,
): Promise<number> {
  let totalArchived = 0;
  let cursor: string | null = null;

  while (true) {
    // Page non-archived auth-DB state rows ordered by story_id so the
    // cursor advances deterministically across pages.
    const { rows: page }: { rows: Array<{ story_id: string }> } =
      await authClient.query<{ story_id: string }>(
        `SELECT story_id::text AS story_id
           FROM story_analysis_state
          WHERE customer_id = $1
            AND status     <> 'archived'
            AND ($2::bigint IS NULL OR story_id > $2::bigint)
          ORDER BY story_id
          LIMIT $3`,
        [customerId, cursor, batchSize],
      );
    if (page.length === 0) break;

    const ids: string[] = page.map((r) => r.story_id);
    const { rows: survivors } = await customerConn.query<{ story_id: string }>(
      `SELECT DISTINCT story_id::text AS story_id
         FROM story
        WHERE story_id = ANY($1::bigint[])`,
      [ids],
    );
    const survivingSet = new Set(survivors.map((r) => r.story_id));
    const orphans = ids.filter((id: string) => !survivingSet.has(id));

    if (orphans.length > 0) {
      const res = await authClient.query(
        `UPDATE story_analysis_state
            SET status = 'archived', updated_at = NOW()
          WHERE customer_id = $1
            AND story_id    = ANY($2::bigint[])
            AND status     <> 'archived'`,
        [customerId, orphans],
      );
      totalArchived += res.rowCount ?? 0;
    }

    cursor = page[page.length - 1].story_id;
    if (page.length < batchSize) break;
  }

  return totalArchived;
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
  // LIVE rows are seeded ONLY when source data exists in the trailing
  // 24h (issue #294 decision 4 / round-8 review item 3). DAILY /
  // WEEKLY / MONTHLY rows still derive from ALL observed source
  // timestamps because a same-day backfill of historical events must
  // produce its historical buckets even though no LIVE row should
  // appear (round-2 review item 2 + round-8 review item 3).
  //
  // The LIVE gate is "ANY source data" per issue #294 decision 2 —
  // not baseline-only. The same `src` CTE that drives DAILY / WEEKLY /
  // MONTHLY derivation already unions `baseline_event.event_time`,
  // latest-version `story.time_window_start`, and latest-version
  // `story.time_window_end`; the LIVE EXISTS check is rewritten to
  // pick from that union so a customer whose only recent source data
  // is a story batch / window-replace in the last 24h still seeds a
  // LIVE row (round-11 review item 1). Before this change the EXISTS
  // checked `baseline_event` directly, leaving story-only customers
  // without a LIVE seed even though the spec includes story timestamps
  // in the source set.
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
       WHERE EXISTS (
         SELECT 1 FROM src
          WHERE ts >= NOW() - INTERVAL '24 hours'
       )`,
    [tz, LIVE_BUCKET_DATE],
  );
  return rows;
}

interface BucketMaxEventRow {
  period: PeriodicPeriod;
  bucket_date: string;
  max_event_at: Date;
  max_received_at: Date;
  event_count: string;
}

interface BucketAggregate {
  maxEventAt: Date;
  maxReceivedAt: Date;
  eventCount: number;
}

/**
 * Per-bucket aggregates over `baseline_event`, keyed by
 * `(period, bucket_date)` in the customer's `tz`:
 *   - `maxEventAt` — max `event_time` in the bucket. Forward-patches
 *     the state row's `last_event_at`.
 *   - `maxReceivedAt` — max `received_at` in the bucket. Used as the
 *     monotone "did the bucket receive a new event?" signal so a hook
 *     failure where the new event lands earlier than the current max
 *     `event_time` still triggers a dirty transition (round-7 review
 *     item 2). Comparing only `event_time` misses that case because
 *     `MAX(event_time)` does not change when a late-arriving event
 *     has an earlier `event_time` than the existing max.
 *   - `eventCount` — `COUNT(*)` of `baseline_event` rows inside the
 *     bucket. Used as the deletion-detection signal (round-8 review
 *     item 1): when a window-replace / backfill envelope deletes
 *     events from inside a closed bucket and the auth-DB hook fails,
 *     the bucket's max `event_time` and `received_at` may not advance
 *     (delete-only refresh) yet the bucket content has changed. The
 *     stored `event_count` on the state row records the count
 *     observed by the previous reconcile pass; when the current count
 *     is strictly less than the stored count, content was removed and
 *     the row is flipped to `dirty`.
 */
async function loadPerBucketMaxEventTimes(
  customerConn: CustomerConnection,
  tz: string,
): Promise<Map<string, BucketAggregate>> {
  const { rows } = await customerConn.query<BucketMaxEventRow>(
    `SELECT 'DAILY'::text AS period,
            (date_trunc('day', event_time AT TIME ZONE $1))::date::text
              AS bucket_date,
            MAX(event_time)  AS max_event_at,
            MAX(received_at) AS max_received_at,
            COUNT(*)::text   AS event_count
       FROM baseline_event
       GROUP BY 1, 2
     UNION ALL
     SELECT 'WEEKLY'::text,
            (date_trunc('week', event_time AT TIME ZONE $1))::date::text,
            MAX(event_time),
            MAX(received_at),
            COUNT(*)::text
       FROM baseline_event
       GROUP BY 1, 2
     UNION ALL
     SELECT 'MONTHLY'::text,
            (date_trunc('month', event_time AT TIME ZONE $1))::date::text,
            MAX(event_time),
            MAX(received_at),
            COUNT(*)::text
       FROM baseline_event
       GROUP BY 1, 2`,
    [tz],
  );
  const out = new Map<string, BucketAggregate>();
  for (const r of rows) {
    out.set(`${r.period}|${r.bucket_date}|${tz}`, {
      maxEventAt: r.max_event_at,
      maxReceivedAt: r.max_received_at,
      eventCount: Number(r.event_count),
    });
  }
  return out;
}

/**
 * Global maxima for the LIVE bucket plus the trailing-24h existence
 * check used by issue #294 decision 4 / round-8 review item 3.
 *
 * `liveActive` is true only when `baseline_event` rows exist whose
 * `event_time >= NOW() - 24h`. LIVE state rows MUST NOT be seeded
 * when the bucket would only be backed by historical data (e.g. a
 * same-day backfill of years-old events). `maxEventAt` /
 * `maxReceivedAt` are still computed from the full table so existing
 * LIVE rows can be forward-patched if they already exist.
 */
async function loadLatestBaselineActivity(
  customerConn: CustomerConnection,
): Promise<{
  maxEventAt: Date;
  maxReceivedAt: Date;
  liveActive: boolean;
} | null> {
  const { rows } = await customerConn.query<{
    max_event_at: Date | null;
    max_received_at: Date | null;
    live_active: boolean;
  }>(
    `SELECT MAX(event_time)  AS max_event_at,
            MAX(received_at) AS max_received_at,
            EXISTS (
              SELECT 1 FROM baseline_event
               WHERE event_time >= NOW() - INTERVAL '24 hours'
            ) AS live_active
       FROM baseline_event`,
  );
  const row = rows[0];
  if (!row || row.max_event_at === null || row.max_received_at === null) {
    return null;
  }
  return {
    maxEventAt: row.max_event_at,
    maxReceivedAt: row.max_received_at,
    liveActive: row.live_active,
  };
}

interface PeriodicExistingRow {
  period: PeriodicPeriod;
  bucket_date: string;
  tz: string;
  status: "pending" | "ready" | "dirty" | "archived";
  last_event_at: Date | null;
  last_event_received_at: Date | null;
  event_count: string;
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
    `SELECT period, bucket_date::text AS bucket_date, tz, status,
            last_event_at, last_event_received_at,
            event_count::text AS event_count
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
  // would forward-patch a row we just inserted. Tracks both max
  // `event_time` and max `received_at` (round-7 review item 2).
  const latestBaseline = await loadLatestBaselineActivity(customerConn);
  // Per-bucket max event_time + max received_at for DAILY/WEEKLY/
  // MONTHLY forward-patch. Computed once per customer so a single
  // round trip serves every existing-row update below — same
  // idempotence guarantee as the LIVE path.
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
                status, last_event_at, last_event_received_at,
                last_ready_at)
             VALUES ($1, 'LIVE', $2::date, $3,
                     'ready', $4, $5, NOW())
             ON CONFLICT (customer_id, period, bucket_date, tz) DO NOTHING`,
            [
              customerId,
              LIVE_BUCKET_DATE,
              customerTz,
              latestBaseline ? latestBaseline.maxEventAt.toISOString() : null,
              latestBaseline
                ? latestBaseline.maxReceivedAt.toISOString()
                : null,
            ],
          );
        } else {
          // Seed DAILY/WEEKLY/MONTHLY with `last_event_at` and
          // `last_event_received_at` already populated from the
          // per-bucket aggregates. The forward-patch branch below
          // would otherwise patch the freshly-seeded NULLs on the
          // next pass and break the decision-2 idempotence
          // acceptance criterion. `event_count` is seeded with the
          // current bucket count so a second reconcile pass with no
          // intervening ingest activity sees `stored == current` and
          // is a no-op.
          const agg = bucketMaxEvent.get(key);
          await authClient.query(
            `INSERT INTO periodic_report_state
               (customer_id, period, bucket_date, tz, status,
                last_event_at, last_event_received_at, event_count)
             VALUES ($1, $2, $3::date, $4, 'pending', $5, $6, $7)
             ON CONFLICT (customer_id, period, bucket_date, tz) DO NOTHING`,
            [
              customerId,
              b.period,
              b.bucket_date,
              customerTz,
              agg ? agg.maxEventAt.toISOString() : null,
              agg ? agg.maxReceivedAt.toISOString() : null,
              agg ? agg.eventCount : 0,
            ],
          );
        }
        seeded += 1;
        continue;
      }

      // Forward-patch `last_event_at` + `last_event_received_at` on
      // existing rows. Both LIVE and DAILY/WEEKLY/MONTHLY are
      // reconciled here so an existing closed bucket whose hook
      // failed still observes its missed event (round-6 review item
      // 2 + round-7 review item 2).
      //
      // The dirty-trigger signal is `received_at` rather than
      // `event_time`: a late-arriving event whose `event_time` is
      // earlier than the current `last_event_at` does not advance
      // the event-time max but DOES advance the received-time max.
      // Using `received_at` catches that case; using only
      // `event_time` (as the previous round-6 patch did) misses it.
      const row = existing.get(key);
      if (!row) continue;
      if (row.status === "archived") continue;

      const patchSource =
        b.period === "LIVE"
          ? latestBaseline
          : (bucketMaxEvent.get(key) ?? null);
      if (patchSource === null) continue;
      const advancesEventAt =
        row.last_event_at === null ||
        patchSource.maxEventAt.getTime() > row.last_event_at.getTime();
      const advancesReceivedAt =
        row.last_event_received_at === null ||
        patchSource.maxReceivedAt.getTime() >
          row.last_event_received_at.getTime();
      // Round-8 review item 1: detect content removal from a closed
      // bucket whose maxima did not advance (delete-only refresh /
      // backfill envelope after a hook failure). LIVE buckets are
      // global-count and cannot reliably distinguish "the trailing
      // 24h shrank" from "events fell out of the window", so deletion
      // detection runs on DAILY/WEEKLY/MONTHLY only — the periods
      // that the envelope-overlap dirty helper targets. The SQL below
      // dirties on a strict decrease but resyncs `event_count` to the
      // current count on any change so the next pass is a no-op.
      const currentCount =
        b.period === "LIVE" || !("eventCount" in patchSource)
          ? null
          : patchSource.eventCount;
      const countChanged =
        currentCount !== null && currentCount !== Number(row.event_count);
      if (!advancesEventAt && !advancesReceivedAt && !countChanged) continue;

      // The CASE WHEN mirrors `recordBaselineActivity`'s dirty trigger
      // exactly: only `ready` rows with at least one processing/done
      // job flip to `dirty`. `pending` and `dirty` rows are
      // forward-patched without status change. Dirty trigger fires
      // when either `event_time` advances, `received_at` advances, or
      // `event_count` strictly decreased (round-8 review item 1:
      // catches delete-only refresh / backfill envelopes whose
      // maxima do not move).
      //
      // `event_count` is always re-stored to the current count (max
      // with stored value would prevent down-moves which is exactly
      // what we need to detect on the next pass). Idempotent: a
      // second pass with no intervening change finds `stored ==
      // current` and the WHERE clause makes the UPDATE a no-op.
      const res = await authClient.query(
        `UPDATE periodic_report_state s
            SET last_event_at = GREATEST(
                  COALESCE(s.last_event_at, $5::timestamptz), $5::timestamptz
                ),
                last_event_received_at = GREATEST(
                  COALESCE(s.last_event_received_at, $6::timestamptz),
                  $6::timestamptz
                ),
                event_count = COALESCE($7::bigint, s.event_count),
                status = CASE
                  WHEN s.status = 'ready'
                    AND (
                      s.last_event_at IS NULL
                      OR $5::timestamptz > s.last_event_at
                      OR s.last_event_received_at IS NULL
                      OR $6::timestamptz > s.last_event_received_at
                      OR ($7::bigint IS NOT NULL AND $7::bigint < s.event_count)
                    )
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
            AND (
              s.last_event_at IS NULL
              OR s.last_event_at < $5::timestamptz
              OR s.last_event_received_at IS NULL
              OR s.last_event_received_at < $6::timestamptz
              OR ($7::bigint IS NOT NULL AND $7::bigint <> s.event_count)
            )`,
        [
          customerId,
          b.period,
          b.bucket_date,
          customerTz,
          patchSource.maxEventAt.toISOString(),
          patchSource.maxReceivedAt.toISOString(),
          currentCount,
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
    // Round-8 review item 1: archive state rows whose `story_id` has
    // zero surviving customer-DB versions. Best-effort window-replace
    // hooks can fail after the customer-DB commit; without this pass
    // the orphaned state row would stay ready/dirty forever (it is
    // invisible to `reconcileStoryStates` because the customer DB
    // has no row for it). Archive counts roll into `storyStatesPatched`
    // since they are forward-only state changes — same semantic class
    // as forward-patching `last_member_at`.
    const orphanArchived = await archiveOrphanedStoryStates(
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
      storyStatesPatched: story.patched + orphanArchived,
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
