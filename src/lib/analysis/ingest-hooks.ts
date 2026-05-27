// RFC 0002 Phase 0 (#294) — best-effort auth-DB hooks invoked by the
// Phase 2 route handlers after the customer-DB ingest commits.
//
// Hook failure response policy (issue #294, decision 2): the customer-
// DB commit is the source of truth; auth-DB writes here are best-effort.
// A failure is logged at `error` level and the ingest's normal success
// response is still returned to the sender. The reconcile scan in
// `analysis-reconcile-worker.ts` seeds and forward-patches any missing
// rows on its own cadence (default 15min). Returning 500 after a
// successful customer-DB commit would tell the sender to retry an
// ingest whose JTI is already consumed.

import "server-only";

import type { Pool } from "pg";
import {
  dirtyPeriodicStatesOverlapping,
  dirtyStoryStatesInRange,
  maybeArchiveStoryState,
  recordBaselineActivity,
  recordStoryMemberArrival,
  unarchiveStoryStateIfArchived,
} from "./state";

async function loadCustomerTimezone(
  pool: Pool,
  customerId: string,
): Promise<string | null> {
  const { rows } = await pool.query<{ timezone: string }>(
    "SELECT timezone FROM customers WHERE id = $1",
    [customerId],
  );
  return rows[0]?.timezone ?? null;
}

function logHookFailure(scope: string, customerId: string, err: unknown): void {
  const message = err instanceof Error ? err.message : String(err);
  console.error(
    `[analysis-hook] ${scope} failed for customer ${customerId}: ${message}`,
  );
}

// ---------------------------------------------------------------------------
// Baseline ingest hook
// ---------------------------------------------------------------------------

export interface BaselineIngestHookInput {
  customerId: string;
  /**
   * Every accepted event paired with its canonical customer-DB
   * `baseline_event.received_at` (RETURNING-ed at INSERT time). The
   * hook dirties every existing DAILY/WEEKLY/MONTHLY bucket whose
   * window contains at least one of these `event_time`s, and forward-
   * patches `last_event_received_at` per bucket using the per-bucket
   * max of these `received_at` values.
   *
   * The previous revision passed only `event_time`s and stamped
   * auth-DB `NOW()` for `last_event_received_at` (round-9 review item
   * 2). Under concurrent commits — ingest A's customer commit lands,
   * then B's customer commit lands, then A's auth-DB hook fires — A
   * could write a `last_event_received_at` later than B's customer-DB
   * `received_at`. If B's auth-DB hook then failed and B's event_time
   * was earlier than the bucket's current max, reconcile would see
   * neither column advance and leave the bucket ready forever. Sourcing
   * `received_at` from `baseline_event` keeps the hot path aligned with
   * the reconcile forward-patch path (`MAX(baseline_event.received_at)`),
   * so the comparison is always like-for-like.
   */
  acceptedEvents: Array<{ eventTime: Date; receivedAt: Date }>;
}

export async function applyBaselineIngestHook(
  authPool: Pool,
  input: BaselineIngestHookInput,
): Promise<void> {
  if (input.acceptedEvents.length === 0) return;
  try {
    const tz = await loadCustomerTimezone(authPool, input.customerId);
    if (!tz) return;
    const client = await authPool.connect();
    try {
      await recordBaselineActivity(
        client,
        input.customerId,
        tz,
        input.acceptedEvents,
      );
    } finally {
      client.release();
    }
  } catch (err) {
    logHookFailure("baseline_ingest", input.customerId, err);
  }
}

// ---------------------------------------------------------------------------
// Story ingest hook
// ---------------------------------------------------------------------------

export interface StoryArrival {
  storyId: string;
  arrivedAt: Date;
}

export interface StoryIngestHookInput {
  customerId: string;
  arrivals: StoryArrival[];
}

export async function applyStoryIngestHook(
  authPool: Pool,
  input: StoryIngestHookInput,
): Promise<void> {
  if (input.arrivals.length === 0) return;
  try {
    const client = await authPool.connect();
    try {
      for (const arrival of input.arrivals) {
        await recordStoryMemberArrival(
          client,
          input.customerId,
          arrival.storyId,
          arrival.arrivedAt,
        );
      }
    } finally {
      client.release();
    }
  } catch (err) {
    logHookFailure("story_ingest", input.customerId, err);
  }
}

// ---------------------------------------------------------------------------
// Window-replace / backfill hooks
// ---------------------------------------------------------------------------

export interface WindowReplaceEnvelopeHookInput {
  customerId: string;
  from: Date;
  to: Date;
}

/**
 * Dirty `periodic_report_state` rows whose bucket window overlaps the
 * refresh-window / backfill envelope `[from, to)`. Fired for BOTH
 * baseline AND story envelopes (round-9 review item 1): a story
 * window-replace that mutates the inputs of an already-generated
 * DAILY/WEEKLY/MONTHLY report must flip that periodic row to `dirty`.
 * Reconcile's periodic dirty signals are baseline-only
 * (`baseline_event` aggregates), so without firing this on story
 * envelopes too a story-only refresh would leave the stale periodic
 * report ready/done indefinitely.
 *
 * Requires `customerPool` so the hook can compute the post-commit
 * `COUNT(*)` of `baseline_event` rows inside each overlapping
 * DAILY/WEEKLY/MONTHLY bucket and forward those counts to
 * `dirtyPeriodicStatesOverlapping` (round-11 review item 2). Without
 * this, a delete-only envelope would leave the stored `event_count`
 * at the pre-delete value; reconcile would then observe
 * `currentCount < stored` after the worker handled the first dirty
 * cycle and re-dirty the same bucket. Computing the counts here
 * keeps the dirty flip + count resync in one auth-DB UPDATE, so the
 * mutation that already drove the first dirty cycle cannot drive a
 * second one.
 *
 * Renamed from `applyWindowReplaceBaselineHook` — the original name
 * implied baseline-envelope-only semantics; the function is and was
 * envelope-agnostic.
 */
export async function applyWindowReplaceEnvelopeHook(
  authPool: Pool,
  customerPool: Pool,
  input: WindowReplaceEnvelopeHookInput,
): Promise<void> {
  try {
    const tz = await loadCustomerTimezone(authPool, input.customerId);
    if (!tz) return;
    const authClient = await authPool.connect();
    try {
      const eventCountByBucket = await computeOverlappingBucketCounts(
        authClient,
        customerPool,
        input.customerId,
        tz,
        input.from,
        input.to,
      );
      await dirtyPeriodicStatesOverlapping(
        authClient,
        input.customerId,
        input.from,
        input.to,
        eventCountByBucket,
      );
    } finally {
      authClient.release();
    }
  } catch (err) {
    logHookFailure("refresh_window_envelope", input.customerId, err);
  }
}

/**
 * Post-commit `COUNT(*)` of `baseline_event` rows for every
 * DAILY/WEEKLY/MONTHLY bucket in the customer's tz that overlaps the
 * envelope `[from, to)`. Returned as a map keyed by
 * `"<PERIOD>|<bucket_date>"` for direct use by
 * `dirtyPeriodicStatesOverlapping`'s `unnest` join.
 *
 * Bucket enumeration comes from the auth-DB `periodic_report_state`
 * rather than the customer-DB `baseline_event` group-by, because a
 * delete-only envelope can leave the bucket with zero events — those
 * buckets would not appear in a customer-DB `GROUP BY event_time`,
 * yet they are exactly the ones whose stored count needs to be reset
 * to zero. LIVE is excluded: reconcile's deletion-detection rule
 * already excludes LIVE because the trailing-24h window is a moving
 * target, not a fixed bucket.
 */
async function computeOverlappingBucketCounts(
  authClient: import("pg").PoolClient,
  customerPool: Pool,
  customerId: string,
  tz: string,
  from: Date,
  to: Date,
): Promise<Map<string, number>> {
  const { rows: keys } = await authClient.query<{
    period: string;
    bucket_date: string;
  }>(
    `SELECT period, bucket_date::text AS bucket_date
       FROM periodic_report_state
      WHERE customer_id = $1
        AND tz          = $2
        AND status IN ('ready', 'dirty')
        AND period IN ('DAILY', 'WEEKLY', 'MONTHLY')
        AND ((bucket_date::timestamp) AT TIME ZONE tz) < $4::timestamptz
        AND ((CASE period
                WHEN 'DAILY'   THEN bucket_date::timestamp + INTERVAL '1 day'
                WHEN 'WEEKLY'  THEN bucket_date::timestamp + INTERVAL '1 week'
                WHEN 'MONTHLY' THEN bucket_date::timestamp + INTERVAL '1 month'
              END) AT TIME ZONE tz) > $3::timestamptz`,
    [customerId, tz, from.toISOString(), to.toISOString()],
  );
  if (keys.length === 0) return new Map();
  const periods = keys.map((k) => k.period);
  const dates = keys.map((k) => k.bucket_date);
  const { rows: counts } = await customerPool.query<{
    period: string;
    bucket_date: string;
    cnt: string;
  }>(
    `WITH targets(period, bucket_date, bucket_start, bucket_end) AS (
       SELECT p, d::date,
              (d::date::timestamp) AT TIME ZONE $1,
              (CASE p
                 WHEN 'DAILY'   THEN d::date::timestamp + INTERVAL '1 day'
                 WHEN 'WEEKLY'  THEN d::date::timestamp + INTERVAL '1 week'
                 WHEN 'MONTHLY' THEN d::date::timestamp + INTERVAL '1 month'
               END) AT TIME ZONE $1
         FROM unnest($2::text[], $3::date[]) AS u(p, d)
     )
     SELECT t.period,
            t.bucket_date::text AS bucket_date,
            COUNT(b.*)::text   AS cnt
       FROM targets t
       LEFT JOIN baseline_event b
         ON b.event_time >= t.bucket_start
        AND b.event_time <  t.bucket_end
      GROUP BY t.period, t.bucket_date`,
    [tz, periods, dates],
  );
  const out = new Map<string, number>();
  for (const r of counts) {
    out.set(`${r.period}|${r.bucket_date}`, Number(r.cnt));
  }
  return out;
}

export interface WindowReplaceStoryHookInput {
  customerId: string;
  /** Stories whose member set was mutated by the window replace. */
  mutatedStoryIds: string[];
  /**
   * Survivor counts per `story_id` paired with the canonical post-
   * commit `MAX(story.received_at)` across all surviving versions.
   * `surviving === 0` archives the state row (issue #294 decision 1);
   * a non-null `lastReceivedAt` is forwarded to `dirtyStoryStatesInRange`
   * so the dirty flip also forward-patches `last_member_at` in the same
   * UPDATE (round-11 review item 2). Without this synchronization, a
   * subsequent reconcile pass observes the newer customer-DB
   * `received_at`, advances `last_member_at`, and re-triggers the
   * dirty transition for a mutation the worker has already handled.
   */
  storyVersionSurvivors: Array<{
    storyId: string;
    surviving: number;
    lastReceivedAt: Date | null;
  }>;
}

export async function applyWindowReplaceStoryHook(
  authPool: Pool,
  input: WindowReplaceStoryHookInput,
): Promise<void> {
  try {
    const client = await authPool.connect();
    try {
      // Dirty mutated stories first; then per-survivor, either archive
      // (surviving=0) or unarchive (surviving>0 against an archived
      // row, per decision 1). Ordering matters: `dirtyStoryStatesInRange`
      // skips archived rows, and unarchive resets to pending — running
      // dirty first leaves any already-non-archived ready/dirty rows in
      // dirty before we evaluate per-survivor archive/unarchive. The
      // dirty UPDATE also forward-patches `last_member_at` from the
      // canonical post-commit `MAX(story.received_at)` so reconcile
      // does not re-trigger a second dirty cycle (round-11 review
      // item 2).
      if (input.mutatedStoryIds.length > 0) {
        const lastByStoryId = new Map<string, Date | null>();
        for (const survivor of input.storyVersionSurvivors) {
          lastByStoryId.set(survivor.storyId, survivor.lastReceivedAt);
        }
        await dirtyStoryStatesInRange(
          client,
          input.customerId,
          input.mutatedStoryIds.map((storyId) => ({
            storyId,
            lastMemberAt: lastByStoryId.get(storyId) ?? null,
          })),
        );
      }
      for (const { storyId, surviving } of input.storyVersionSurvivors) {
        if (surviving === 0) {
          await maybeArchiveStoryState(
            client,
            input.customerId,
            storyId,
            surviving,
          );
        } else {
          // Reinsertion of a previously-archived story: unarchive in
          // place (decision 1) — pending status + fresh timestamps +
          // stale jobs purged. No-op when the row is already non-
          // archived or absent.
          await unarchiveStoryStateIfArchived(
            client,
            input.customerId,
            storyId,
          );
        }
      }
    } finally {
      client.release();
    }
  } catch (err) {
    logHookFailure("refresh_window_story", input.customerId, err);
  }
}
