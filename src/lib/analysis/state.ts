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
       SET last_member_at = GREATEST(
             story_analysis_state.last_member_at, EXCLUDED.last_member_at
           ),
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
           -- Archived → pending on re-insertion (unarchive in place per
           -- decision 1). Clear the timestamps so the next worker tick
           -- re-derives readiness from the new canonical version.
           first_member_at = CASE
             WHEN story_analysis_state.status = 'archived' THEN EXCLUDED.first_member_at
             ELSE story_analysis_state.first_member_at
           END,
           last_ready_at = CASE
             WHEN story_analysis_state.status = 'archived' THEN NULL
             ELSE story_analysis_state.last_ready_at
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
 * Record that a Phase 2 baseline batch landed for a customer. Phase 0
 * only seeds/forward-patches the LIVE bucket per the configured `tz`
 * — DAILY/WEEKLY/MONTHLY bucket seeding is handled by the reconcile
 * scan (decision 2) which the worker invokes on its own cadence.
 */
export async function recordBaselineActivity(
  client: PoolClient,
  customerId: string,
  tz: string,
  eventArrivedAt: Date,
): Promise<void> {
  await client.query(
    `INSERT INTO periodic_report_state
       (customer_id, period, bucket_date, tz, status, last_event_at)
     VALUES ($1, 'LIVE', $2::date, $3, 'ready', $4)
     ON CONFLICT (customer_id, period, bucket_date, tz) DO UPDATE
       SET last_event_at = GREATEST(
             periodic_report_state.last_event_at, EXCLUDED.last_event_at
           ),
           status = CASE
             WHEN periodic_report_state.status IN ('ready', 'archived')
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
           updated_at = NOW()`,
    [customerId, LIVE_BUCKET_DATE, tz, eventArrivedAt.toISOString()],
  );
}

/**
 * Dirty all periodic_report_state rows whose [bucket window] overlaps
 * the supplied [from, to) envelope. Phase 0's overlap is intentionally
 * coarse — it marks every row for the customer whose `last_event_at`
 * falls within the window OR whose `bucket_date` is within the window.
 * Phase 1/Phase 2 (#296/#297) will refine this once they consume the
 * dirty signal.
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
          (s.last_event_at IS NOT NULL
            AND s.last_event_at >= $2
            AND s.last_event_at <  $3)
          OR (s.bucket_date >= $2::date AND s.bucket_date < $3::date)
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
