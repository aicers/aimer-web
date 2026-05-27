// RFC 0002 Phase 0 (#294) — state-transition helpers shared by ingest
// hooks and the analysis-job-worker.
//
// State rows live in the auth DB and answer "is the source data ready
// to be analyzed at all?". Per-variant work lives on `*_analysis_job`
// rows (also auth DB). See RFC 0002 §"Readiness and scheduling" and
// §"Dirty transitions" for the rules implemented here.
//
// Phase 0's worker does not call the LLM — it persists `dry_run=TRUE`
// job rows so dirty transitions can be observed during the 48h
// verification gate (issue #294, decision 3). The functions below are
// shared between (a) the ingest hooks that mark state rows dirty and
// (b) the worker tick that promotes pending → ready and enqueues new
// jobs.

import "server-only";

import type { PoolClient } from "pg";

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

export const DEFAULT_STORY_IDLE_MINUTES = 15;
export const DEFAULT_STORY_MAX_WAIT_HOURS = 6;
export const DEFAULT_REPORT_SETTLE_HOURS_DAILY = 3;
export const DEFAULT_REPORT_SETTLE_HOURS_WEEKLY = 6;
export const DEFAULT_REPORT_SETTLE_HOURS_MONTHLY = 12;
export const DEFAULT_REPORT_IDLE_QUIET_MINUTES = 30;

// LIVE rows use a synthetic bucket_date (RFC 0002 §"LIVE bucket_date
// convention", issue #294 decision 4). The PK keeps `tz` so a tz change
// produces a new LIVE row.
export const LIVE_BUCKET_DATE = "1970-01-01";

export type StateStatus = "pending" | "ready" | "dirty" | "archived";

// ---------------------------------------------------------------------------
// Story state hooks
// ---------------------------------------------------------------------------

/**
 * Called from baseline/story ingest after the customer-DB commit
 * succeeds. INSERTs a fresh `pending` state row for a new story, or
 * forward-patches `last_member_at` and (if applicable) flips the row to
 * `dirty` when a member arrives for a story already past `ready`.
 *
 * Idempotent: replaying the same member-arrival call is a no-op once
 * `last_member_at >= memberArrivedAt`. `first_member_at` is set on
 * first insert only (per RFC 0002 §"Source state additions").
 *
 * Archived → pending on re-insertion: per issue #294 decision 1, all
 * three source timestamps are RESET to NULL (not the hook-time
 * `memberArrivedAt`). The reconcile forward-patch path can only roll
 * timestamps forward; writing the hook-time value here would let the
 * archived run's stale `last_member_at` survive when it is newer than
 * the reintroduced story's canonical `story.received_at`. NULLing both
 * lets the next worker tick / reconcile pass re-derive readiness from
 * the canonical source. Stale jobs from the archived run are deleted
 * regardless of how the row got back to `pending`.
 */
export async function recordStoryMemberArrival(
  client: PoolClient,
  customerId: string,
  storyId: string,
  memberArrivedAt: Date,
): Promise<void> {
  await client.query(
    `INSERT INTO story_analysis_state
       (customer_id, story_id, status, first_member_at, last_member_at)
     VALUES ($1, $2::bigint, 'pending', $3, $3)
     ON CONFLICT (customer_id, story_id) DO UPDATE
       SET first_member_at = CASE
             -- Decision 1: unarchive in place clears ALL source
             -- timestamps so canonical re-derivation wins over
             -- hook-time values that reconcile cannot roll back.
             WHEN story_analysis_state.status = 'archived' THEN NULL
             ELSE story_analysis_state.first_member_at
           END,
           last_member_at = CASE
             WHEN story_analysis_state.status = 'archived' THEN NULL
             ELSE GREATEST(
               story_analysis_state.last_member_at, EXCLUDED.last_member_at
             )
           END,
           last_ready_at = CASE
             WHEN story_analysis_state.status = 'archived' THEN NULL
             ELSE story_analysis_state.last_ready_at
           END,
           -- Archived → pending takes priority over the dirty trigger
           -- (decision 1: unarchive in place starts a fresh narrative).
           -- Late member on a ready story with at least one processing/
           -- done job transitions to dirty per RFC 0002 §"Dirty
           -- transitions" rule 1. The worker tick re-queues the variant
           -- jobs; this hook only flips the state.
           status = CASE
             WHEN story_analysis_state.status = 'archived' THEN 'pending'
             WHEN story_analysis_state.status = 'ready'
               AND EXISTS (
                 SELECT 1 FROM story_analysis_job j
                  WHERE j.customer_id = story_analysis_state.customer_id
                    AND j.story_id    = story_analysis_state.story_id
                    AND j.status IN ('processing', 'done')
               )
             THEN 'dirty'
             ELSE story_analysis_state.status
           END,
           updated_at = NOW()`,
    [customerId, storyId, memberArrivedAt.toISOString()],
  );
  // If we transitioned from archived → pending, the prior generation's
  // job rows belong to the archived run and must be deleted (decision 1).
  // We can detect the transition by checking whether the row now has
  // `status = 'pending'` and `last_ready_at IS NULL` while job rows still
  // exist; the simplest correct behavior is to delete any job rows for
  // story_ids we just unarchived. The previous UPDATE branch above can't
  // distinguish unarchive from a true first insert without RETURNING, so
  // do a follow-up DELETE for safety; it is a no-op when nothing was
  // unarchived.
  await client.query(
    `DELETE FROM story_analysis_job j
      WHERE j.customer_id = $1
        AND j.story_id    = $2::bigint
        AND EXISTS (
          SELECT 1 FROM story_analysis_state s
           WHERE s.customer_id = j.customer_id
             AND s.story_id    = j.story_id
             AND s.status      = 'pending'
             AND s.last_ready_at IS NULL
        )`,
    [customerId, storyId],
  );
}

/**
 * Window-replace or backfill deletes one or more `story_version` rows
 * for a `story_id`. If no `story_version` remains, the state row
 * transitions to `archived` (decision 1). If a surviving version still
 * exists, the row is left alone (decision 1: archive condition is
 * "no story row remains", not "any DELETE").
 *
 * Pass `surviving` as the count of `story` rows that remain in the
 * customer DB for the given `(story_id)`. The caller is responsible
 * for computing this within the same transaction as the DELETE.
 */
export async function maybeArchiveStoryState(
  client: PoolClient,
  customerId: string,
  storyId: string,
  surviving: number,
): Promise<void> {
  if (surviving > 0) return;
  await client.query(
    `UPDATE story_analysis_state
        SET status = 'archived',
            updated_at = NOW()
      WHERE customer_id = $1
        AND story_id    = $2::bigint
        AND status      <> 'archived'`,
    [customerId, storyId],
  );
}

/**
 * Window-replace or backfill re-inserts at least one `story_version`
 * for a previously archived `story_id` (decision 1: unarchive in
 * place). The state row resets to `pending` and ALL source timestamps
 * are cleared to NULL so the next worker tick (and/or the reconcile
 * forward-patch path) re-derives readiness from the canonical
 * customer-DB story timestamps for the surviving versions. Stale jobs
 * from the prior archived run are deleted.
 *
 * Issue #294 decision 1 spells this out:
 *   UPDATE the same state row SET status='pending',
 *     first_member_at=NULL, last_member_at=NULL, last_ready_at=NULL;
 *   DELETE any *_analysis_job rows for that story_id from the
 *   archived run.
 *
 * Writing NOW() into the timestamps would leave a hook-time value
 * that reconcile's forward-only patch can never roll backwards,
 * which would delay readiness on a reinserted historical story.
 *
 * No-op when the row is missing or already non-archived — the
 * dirty/archive helpers cover those branches. Reconcile and the
 * regular member-arrival hook also unarchive on their own paths;
 * this helper closes the window-replace/backfill path that neither
 * `dirtyStoryStatesInRange` (skips archived) nor `maybeArchiveStoryState`
 * (only handles surviving=0) reaches.
 */
export async function unarchiveStoryStateIfArchived(
  client: PoolClient,
  customerId: string,
  storyId: string,
): Promise<void> {
  const { rowCount } = await client.query(
    `UPDATE story_analysis_state
        SET status         = 'pending',
            first_member_at = NULL,
            last_member_at  = NULL,
            last_ready_at   = NULL,
            updated_at      = NOW()
      WHERE customer_id = $1
        AND story_id    = $2::bigint
        AND status      = 'archived'`,
    [customerId, storyId],
  );
  if ((rowCount ?? 0) === 0) return;
  // Stale jobs belong to the prior archived run (decision 1).
  await client.query(
    `DELETE FROM story_analysis_job
      WHERE customer_id = $1
        AND story_id    = $2::bigint`,
    [customerId, storyId],
  );
}

/**
 * Window-replace or backfill envelope overlaps stories already past
 * ready — those rows transition to `dirty` per RFC 0002 §"Dirty
 * transitions" rule 2.
 */
export async function dirtyStoryStatesInRange(
  client: PoolClient,
  customerId: string,
  storyIds: readonly string[],
): Promise<void> {
  if (storyIds.length === 0) return;
  await client.query(
    `UPDATE story_analysis_state s
        SET status = 'dirty', updated_at = NOW()
      WHERE s.customer_id = $1
        AND s.story_id    = ANY($2::bigint[])
        AND s.status IN ('ready', 'dirty')
        AND EXISTS (
          SELECT 1 FROM story_analysis_job j
           WHERE j.customer_id = s.customer_id
             AND j.story_id    = s.story_id
             AND j.status IN ('processing', 'done')
        )`,
    [customerId, storyIds],
  );
}

// ---------------------------------------------------------------------------
// Periodic-report state hooks
// ---------------------------------------------------------------------------

export type PeriodicPeriod = "LIVE" | "DAILY" | "WEEKLY" | "MONTHLY";

/**
 * Record that a Phase 2 baseline batch landed for a customer. Updates
 * the LIVE bucket and every existing DAILY/WEEKLY/MONTHLY bucket
 * whose window contains ANY of the accepted `event_time`s — so a
 * single batch with events landing inside multiple already-`done`
 * closed buckets marks ALL of them `dirty` for re-analysis (RFC 0002
 * §"Dirty transitions" rule 1, applied per affected bucket).
 *
 * `eventTimes` must be the full list of accepted `event_time` values
 * for the batch. Passing only the most-recent event would miss any
 * earlier event that landed in a different done bucket; the route
 * handler therefore captures every accepted event and forwards them
 * unchanged to this hook.
 *
 * The DAILY/WEEKLY/MONTHLY rows themselves are NOT seeded here: the
 * reconcile scan derives the full bucket set from
 * `customers.timezone` plus observed source timestamps on its own
 * cadence (decision 2). The ingest hook only forward-patches +
 * dirties rows that already exist; if reconcile has not yet seeded
 * the historical bucket, reconcile will pick it up on its next pass
 * with the correct `last_event_at` already derivable from the source.
 *
 * Archived periodic rows are SKIPPED: per RFC 0002 §"Timezone
 * lifecycle" and issue #294 decision 2, archived periodic rows are
 * terminal. A later baseline batch must not roll an archived row
 * back to dirty or forward-patch its `last_event_at`. A customer
 * reverting a timezone change requires explicit reactivation, not
 * an accidental ingest-driven resurrection. The reconcile scan
 * already enforces the same rule on the forward-patch side.
 */
export async function recordBaselineActivity(
  client: PoolClient,
  customerId: string,
  tz: string,
  eventTimes: readonly Date[],
): Promise<void> {
  if (eventTimes.length === 0) return;
  const isoTimes = eventTimes.map((t) => t.toISOString());

  // LIVE: rolling state, so it stamps the MAX event_time as
  // last_event_at and dirties the row if a done/processing job
  // already exists. The ON CONFLICT WHERE clause excludes archived
  // rows so a terminal-archived LIVE row stays archived.
  //
  // The `WHERE t >= NOW() - INTERVAL '24 hours'` filter on the input
  // events restricts LIVE seeding / forward-patching to the trailing
  // 24h window per issue #294 decision 4 and round-8 review item 3.
  // A same-day backfill of historical `event_time` values must NOT
  // create or advance a LIVE row — those events seed DAILY/WEEKLY/
  // MONTHLY buckets only. If no event in the batch qualifies, the
  // CTE's `max_t.t` is NULL and the `WHERE max_t.t IS NOT NULL`
  // guard turns the INSERT into a no-op.
  //
  // `last_event_received_at` is the reconcile safety-net signal
  // (round-7 review item 2): it advances every time the bucket
  // receives a new event regardless of whether `event_time`
  // advances, so a hook failure followed by reconcile catches up
  // even when the new event lands earlier than the current max.
  // Using `NOW()` here is the customer-DB-side ingest-commit
  // boundary: customer-DB `baseline_event.received_at` defaults to
  // `NOW()` at INSERT, and the hook runs after that commit, so the
  // auth-DB `NOW()` is >= the maximum customer-DB `received_at`.
  // That ordering keeps the reconcile comparison conservative —
  // hook success leaves no missed events; hook failure leaves the
  // column behind the customer DB and reconcile observes the lag.
  await client.query(
    `WITH max_t AS (
       SELECT MAX(t) AS t
         FROM unnest($4::timestamptz[]) AS t
        WHERE t >= NOW() - INTERVAL '24 hours'
     )
     INSERT INTO periodic_report_state
       (customer_id, period, bucket_date, tz, status,
        last_event_at, last_event_received_at)
     SELECT $1, 'LIVE', $2::date, $3, 'ready', max_t.t, NOW()
       FROM max_t
      WHERE max_t.t IS NOT NULL
     ON CONFLICT (customer_id, period, bucket_date, tz) DO UPDATE
       SET last_event_at = GREATEST(
             periodic_report_state.last_event_at, EXCLUDED.last_event_at
           ),
           last_event_received_at = GREATEST(
             periodic_report_state.last_event_received_at, NOW()
           ),
           status = CASE
             WHEN periodic_report_state.status = 'ready'
               AND EXISTS (
                 SELECT 1 FROM periodic_report_job j
                  WHERE j.customer_id  = periodic_report_state.customer_id
                    AND j.period       = periodic_report_state.period
                    AND j.bucket_date  = periodic_report_state.bucket_date
                    AND j.tz           = periodic_report_state.tz
                    AND j.status IN ('processing', 'done')
               )
             THEN 'dirty'
             ELSE periodic_report_state.status
           END,
           updated_at = NOW()
       WHERE periodic_report_state.status <> 'archived'`,
    [customerId, LIVE_BUCKET_DATE, tz, isoTimes],
  );

  // DAILY/WEEKLY/MONTHLY: forward-patch + dirty every existing row
  // whose bucket window contains at least one accepted event_time.
  // The CTE collapses the input timestamps to (period, bucket_date,
  // max-event-time-inside-the-bucket) tuples so a single UPDATE can
  // touch all affected rows, and each row's last_event_at picks up
  // the latest event THAT FELL INSIDE THE BUCKET — not the global
  // batch max. Existing-only — seeding is reconcile's job. Archived
  // rows are skipped so they stay terminal. `last_event_received_at`
  // advances on every bucket touched so reconcile catches missed
  // events whose `event_time` is earlier than the current max
  // (round-7 review item 2).
  await client.query(
    `WITH events(t) AS (
       SELECT t FROM unnest($3::timestamptz[]) AS t
     ),
     buckets(period, bucket_date, max_t) AS (
       SELECT 'DAILY'::text,
              (date_trunc('day',   t AT TIME ZONE $2))::date,
              MAX(t)
         FROM events
        GROUP BY 1, 2
       UNION ALL
       SELECT 'WEEKLY'::text,
              (date_trunc('week',  t AT TIME ZONE $2))::date,
              MAX(t)
         FROM events
        GROUP BY 1, 2
       UNION ALL
       SELECT 'MONTHLY'::text,
              (date_trunc('month', t AT TIME ZONE $2))::date,
              MAX(t)
         FROM events
        GROUP BY 1, 2
     )
     UPDATE periodic_report_state s
        SET last_event_at = GREATEST(s.last_event_at, b.max_t),
            last_event_received_at = GREATEST(
              s.last_event_received_at, NOW()
            ),
            status = CASE
              WHEN s.status = 'ready'
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
       FROM buckets b
      WHERE s.customer_id = $1
        AND s.tz          = $2
        AND s.period      = b.period
        AND s.bucket_date = b.bucket_date
        AND s.status      <> 'archived'`,
    [customerId, tz, isoTimes],
  );
}

/**
 * Dirty all periodic_report_state rows whose bucket window overlaps
 * the supplied [from, to) envelope.
 *
 * Per RFC 0002 §"Dirty transitions" rule 2 (envelope overlap), a row
 * is dirtied when `[bucket_start, bucket_end)` intersects `[from, to)`
 * — i.e. `bucket_start < to AND bucket_end > from`. The bucket window
 * is computed in the row's `tz` so a 2026-05-15 refresh correctly
 * overlaps a MONTHLY 2026-05-01 (which spans 2026-05-01..2026-06-01),
 * not just rows whose `bucket_date` happens to fall inside the
 * envelope.
 *
 * LIVE has no fixed bucket window — it's the rolling current state
 * — so it falls back to the `last_event_at` proxy: if the row's
 * most recent observed event lies inside the envelope, the LIVE row
 * is affected.
 */
export async function dirtyPeriodicStatesOverlapping(
  client: PoolClient,
  customerId: string,
  from: Date,
  to: Date,
): Promise<void> {
  await client.query(
    `UPDATE periodic_report_state s
        SET status = 'dirty', updated_at = NOW()
      WHERE s.customer_id = $1
        AND s.status IN ('ready', 'dirty')
        AND (
          -- LIVE: no fixed window, use last_event_at proxy.
          (s.period = 'LIVE'
            AND s.last_event_at IS NOT NULL
            AND s.last_event_at >= $2
            AND s.last_event_at <  $3)
          -- DAILY / WEEKLY / MONTHLY: true bucket-range overlap in s.tz.
          OR (s.period IN ('DAILY', 'WEEKLY', 'MONTHLY')
            AND ((s.bucket_date::timestamp) AT TIME ZONE s.tz) < $3::timestamptz
            AND ((CASE s.period
                    WHEN 'DAILY'   THEN s.bucket_date::timestamp + INTERVAL '1 day'
                    WHEN 'WEEKLY'  THEN s.bucket_date::timestamp + INTERVAL '1 week'
                    WHEN 'MONTHLY' THEN s.bucket_date::timestamp + INTERVAL '1 month'
                  END) AT TIME ZONE s.tz) > $2::timestamptz)
        )
        AND EXISTS (
          SELECT 1 FROM periodic_report_job j
           WHERE j.customer_id  = s.customer_id
             AND j.period       = s.period
             AND j.bucket_date  = s.bucket_date
             AND j.tz           = s.tz
             AND j.status IN ('processing', 'done')
        )`,
    [customerId, from.toISOString(), to.toISOString()],
  );
}

// ---------------------------------------------------------------------------
// Pure helpers — story readiness rule
// ---------------------------------------------------------------------------

/**
 * Story readiness rule (RFC 0002 §"Story readiness"). A state row in
 * `pending` becomes `ready` when either:
 *   - `NOW() - last_member_at >= idleMinutes` (default 15min), or
 *   - `NOW() - first_member_at >= maxWaitHours` (default 6h).
 *
 * Returns false when either timestamp is missing — a brand-new row
 * cannot be ready yet.
 */
export function isStoryReady(
  now: Date,
  firstMemberAt: Date | null,
  lastMemberAt: Date | null,
  idleMinutes = DEFAULT_STORY_IDLE_MINUTES,
  maxWaitHours = DEFAULT_STORY_MAX_WAIT_HOURS,
): boolean {
  if (!firstMemberAt || !lastMemberAt) return false;
  const idleMs = idleMinutes * 60_000;
  const maxWaitMs = maxWaitHours * 3_600_000;
  const idleDelta = now.getTime() - lastMemberAt.getTime();
  const totalDelta = now.getTime() - firstMemberAt.getTime();
  return idleDelta >= idleMs || totalDelta >= maxWaitMs;
}
