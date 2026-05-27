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
 *
 * Each input pair carries the canonical post-commit `MAX(story.received_at)`
 * across all surviving versions for the `story_id` (NULL when the
 * caller has no value to forward — e.g. a backwards-compatible call
 * site). When non-null, `last_member_at` is forward-patched via
 * `GREATEST(...)` in the same UPDATE that flips the status to `dirty`,
 * so a subsequent reconcile pass observes the canonical value already
 * stored and does not re-trigger a second dirty cycle on the same
 * mutation (round-11 review item 2). Idempotent: a second call with
 * the same value is a no-op because `GREATEST(stored, stored) = stored`
 * and the row is already `dirty`.
 *
 * Mutated story_ids with no surviving version are tolerated here:
 * `status IN ('ready', 'dirty')` filters them out (archive runs
 * separately via `maybeArchiveStoryState`).
 */
export interface DirtyStoryStateInput {
  storyId: string;
  /**
   * Canonical post-commit `MAX(story.received_at)` for the story.
   * NULL when no surviving version (caller will archive) or when the
   * caller has no canonical value to forward. NULL skips the forward-
   * patch but still flips the status.
   */
  lastMemberAt: Date | null;
}

export async function dirtyStoryStatesInRange(
  client: PoolClient,
  customerId: string,
  inputs: readonly DirtyStoryStateInput[],
): Promise<void> {
  if (inputs.length === 0) return;
  const storyIds = inputs.map((i) => i.storyId);
  // Two parallel arrays for the unnest in the UPDATE join below:
  // story_id → canonical last_member_at. `null::timestamptz` entries
  // leave the existing column unchanged via the COALESCE in GREATEST.
  const lastMemberAts = inputs.map((i) =>
    i.lastMemberAt ? i.lastMemberAt.toISOString() : null,
  );
  await client.query(
    `WITH forward(story_id, last_member_at) AS (
       SELECT id::bigint, ts::timestamptz
         FROM unnest($2::bigint[], $3::timestamptz[]) AS u(id, ts)
     )
     UPDATE story_analysis_state s
        SET status         = 'dirty',
            last_member_at = CASE
              WHEN f.last_member_at IS NULL THEN s.last_member_at
              ELSE GREATEST(
                COALESCE(s.last_member_at, f.last_member_at),
                f.last_member_at
              )
            END,
            updated_at = NOW()
       FROM forward f
      WHERE s.customer_id = $1
        AND s.story_id    = f.story_id
        AND s.status IN ('ready', 'dirty')
        AND EXISTS (
          SELECT 1 FROM story_analysis_job j
           WHERE j.customer_id = s.customer_id
             AND j.story_id    = s.story_id
             AND j.status IN ('processing', 'done')
        )`,
    [customerId, storyIds, lastMemberAts],
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
 * `acceptedEvents` must be the full list of accepted events for the
 * batch, each paired with its canonical customer-DB
 * `baseline_event.received_at`. Passing only the most-recent event
 * would miss any earlier event that landed in a different done
 * bucket; the route handler therefore captures every accepted event
 * and forwards them unchanged to this hook. The per-bucket
 * `last_event_received_at` forward-patch uses
 * `MAX(receivedAt)` over the events inside the bucket — NOT auth-DB
 * `NOW()` — so concurrent commits cannot stamp a value ahead of a
 * still-pending customer-DB `received_at` (round-9 review item 2).
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
  acceptedEvents: ReadonlyArray<{ eventTime: Date; receivedAt: Date }>,
): Promise<void> {
  if (acceptedEvents.length === 0) return;
  const isoEventTimes = acceptedEvents.map((e) => e.eventTime.toISOString());
  const isoReceivedAts = acceptedEvents.map((e) => e.receivedAt.toISOString());

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
  // (round-7 review item 2 / round-9 review item 2): it advances
  // every time the bucket receives a new event regardless of whether
  // `event_time` advances, so a hook failure followed by reconcile
  // catches up even when the new event lands earlier than the
  // current max. The value sourced here is the customer-DB
  // `baseline_event.received_at` returned at INSERT — NOT auth-DB
  // `NOW()`. The reconcile forward-patch path compares against
  // `MAX(baseline_event.received_at)`; under concurrent commits
  // (ingest A commits, ingest B commits, then A's hook fires), an
  // auth-DB `NOW()` value could get ahead of B's customer-DB
  // `received_at` and, if B's hook then failed and B's event_time
  // was earlier than the bucket max, leave the bucket ready forever.
  // Sourcing from the canonical customer-DB column keeps the hot
  // path and reconcile comparable like-for-like.
  await client.query(
    `WITH events(t, rcv) AS (
       SELECT t, rcv
         FROM unnest($4::timestamptz[], $5::timestamptz[]) AS u(t, rcv)
     ),
     in_window AS (
       SELECT MAX(t) AS max_t, MAX(rcv) AS max_rcv
         FROM events
        WHERE t >= NOW() - INTERVAL '24 hours'
     )
     INSERT INTO periodic_report_state
       (customer_id, period, bucket_date, tz, status,
        last_event_at, last_event_received_at)
     SELECT $1, 'LIVE', $2::date, $3, 'ready',
            in_window.max_t, in_window.max_rcv
       FROM in_window
      WHERE in_window.max_t IS NOT NULL
     ON CONFLICT (customer_id, period, bucket_date, tz) DO UPDATE
       SET last_event_at = GREATEST(
             periodic_report_state.last_event_at, EXCLUDED.last_event_at
           ),
           last_event_received_at = GREATEST(
             periodic_report_state.last_event_received_at,
             EXCLUDED.last_event_received_at
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
    [customerId, LIVE_BUCKET_DATE, tz, isoEventTimes, isoReceivedAts],
  );

  // DAILY/WEEKLY/MONTHLY: forward-patch + dirty every existing row
  // whose bucket window contains at least one accepted event_time.
  // The CTE collapses the input tuples to (period, bucket_date,
  // max-event-time-inside-the-bucket, max-received-at-inside-the-
  // bucket) so a single UPDATE can touch all affected rows. Each
  // row's `last_event_at` picks up the latest event THAT FELL INSIDE
  // THE BUCKET — not the global batch max — and
  // `last_event_received_at` picks up the latest customer-DB
  // received_at among those same events (round-9 review item 2).
  // Existing-only — seeding is reconcile's job. Archived rows are
  // skipped so they stay terminal.
  await client.query(
    `WITH events(t, rcv) AS (
       SELECT t, rcv
         FROM unnest($3::timestamptz[], $4::timestamptz[]) AS u(t, rcv)
     ),
     buckets(period, bucket_date, max_t, max_rcv) AS (
       SELECT 'DAILY'::text,
              (date_trunc('day',   t AT TIME ZONE $2))::date,
              MAX(t), MAX(rcv)
         FROM events
        GROUP BY 1, 2
       UNION ALL
       SELECT 'WEEKLY'::text,
              (date_trunc('week',  t AT TIME ZONE $2))::date,
              MAX(t), MAX(rcv)
         FROM events
        GROUP BY 1, 2
       UNION ALL
       SELECT 'MONTHLY'::text,
              (date_trunc('month', t AT TIME ZONE $2))::date,
              MAX(t), MAX(rcv)
         FROM events
        GROUP BY 1, 2
     )
     UPDATE periodic_report_state s
        SET last_event_at = GREATEST(s.last_event_at, b.max_t),
            last_event_received_at = GREATEST(
              s.last_event_received_at, b.max_rcv
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
    [customerId, tz, isoEventTimes, isoReceivedAts],
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
 *
 * `eventCountByBucket`, when supplied, maps `"<PERIOD>|<bucket_date>"`
 * (DAILY/WEEKLY/MONTHLY only — LIVE is excluded because reconcile's
 * deletion-detection rule skips LIVE) to the post-commit `COUNT(*)` of
 * `baseline_event` rows inside the bucket. Forwarded by
 * `applyWindowReplaceEnvelopeHook` so the dirty UPDATE re-syncs
 * `event_count` in the same statement — eliminating the second
 * spurious dirty cycle reconcile would otherwise produce on a delete-
 * only envelope (round-11 review item 2). Without this, the stored
 * `event_count` stays at the pre-delete value; after the worker
 * processes the dirty row, reconcile sees `currentCount < stored` and
 * re-dirties the same bucket. Idempotent: replaying with the same map
 * is a no-op (status already `dirty`, count unchanged).
 *
 * `storyAggregateByBucket`, when supplied, mirrors `eventCountByBucket`
 * for the story side (round-12 review item 1). The map carries the
 * post-commit `MAX(story.received_at)` (`maxReceivedAt`, null if no
 * stories overlap) and `COUNT(DISTINCT story_id)` (`count`) for every
 * DAILY / WEEKLY / MONTHLY bucket that overlaps the envelope. The
 * dirty UPDATE forwards both columns in the same statement that flips
 * the status, so reconcile's story-side dirty trigger
 * (`last_story_received_at` advance OR `story_count` change) cannot
 * fire a second time on the same mutation once the worker handles the
 * first dirty cycle. LIVE rows skip these columns for the same reason
 * they skip `event_count`: the trailing-24h window is not a fixed
 * bucket and deletion detection is unreliable there.
 */
export interface PeriodicEnvelopeStoryAggregate {
  maxReceivedAt: Date | null;
  count: number;
}

export async function dirtyPeriodicStatesOverlapping(
  client: PoolClient,
  customerId: string,
  from: Date,
  to: Date,
  eventCountByBucket?: ReadonlyMap<string, number>,
  storyAggregateByBucket?: ReadonlyMap<string, PeriodicEnvelopeStoryAggregate>,
): Promise<void> {
  const periodArr: string[] = [];
  const dateArr: string[] = [];
  const countArr: string[] = [];
  if (eventCountByBucket) {
    for (const [key, cnt] of eventCountByBucket) {
      const sep = key.indexOf("|");
      if (sep < 0) continue;
      periodArr.push(key.slice(0, sep));
      dateArr.push(key.slice(sep + 1));
      countArr.push(String(cnt));
    }
  }
  const storyPeriodArr: string[] = [];
  const storyDateArr: string[] = [];
  const storyMaxArr: (string | null)[] = [];
  const storyCountArr: string[] = [];
  if (storyAggregateByBucket) {
    for (const [key, agg] of storyAggregateByBucket) {
      const sep = key.indexOf("|");
      if (sep < 0) continue;
      storyPeriodArr.push(key.slice(0, sep));
      storyDateArr.push(key.slice(sep + 1));
      storyMaxArr.push(
        agg.maxReceivedAt ? agg.maxReceivedAt.toISOString() : null,
      );
      storyCountArr.push(String(agg.count));
    }
  }
  await client.query(
    `WITH cnt(period, bucket_date, event_count) AS (
       SELECT p, d::date, c::bigint
         FROM unnest($4::text[], $5::date[], $6::bigint[]) AS u(p, d, c)
     ),
     story_agg(period, bucket_date, max_rcv, story_count) AS (
       SELECT p, d::date, r::timestamptz, c::bigint
         FROM unnest(
                $7::text[], $8::date[], $9::timestamptz[], $10::bigint[]
              ) AS u(p, d, r, c)
     )
     UPDATE periodic_report_state s
        SET status = 'dirty',
            event_count = COALESCE(
              (SELECT c.event_count
                 FROM cnt c
                WHERE c.period = s.period
                  AND c.bucket_date = s.bucket_date),
              s.event_count
            ),
            last_story_received_at = GREATEST(
              s.last_story_received_at,
              (SELECT sa.max_rcv
                 FROM story_agg sa
                WHERE sa.period = s.period
                  AND sa.bucket_date = s.bucket_date)
            ),
            story_count = COALESCE(
              (SELECT sa.story_count
                 FROM story_agg sa
                WHERE sa.period = s.period
                  AND sa.bucket_date = s.bucket_date),
              s.story_count
            ),
            updated_at = NOW()
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
    [
      customerId,
      from.toISOString(),
      to.toISOString(),
      periodArr,
      dateArr,
      countArr,
      storyPeriodArr,
      storyDateArr,
      storyMaxArr,
      storyCountArr,
    ],
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
