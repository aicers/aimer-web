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
  type BaselineSeedCandidate,
  seedBaselineEventJobs,
} from "./event-analysis-worker";
import {
  type CursorQuality,
  dirtyPeriodicStatesOverlapping,
  dirtyStoryStatesInRange,
  maybeArchiveStoryState,
  type PeriodicEnvelopeLiveActivity,
  type PeriodicEnvelopeStoryAggregate,
  recordBaselineActivity,
  recordCursorWatermark,
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
// Cursor watermark hook (RFC 0002 Phase 0.5 — issue #295)
// ---------------------------------------------------------------------------

export interface CursorWatermarkHookInput {
  customerId: string;
  cursorEventTime: Date;
  cursorQuality: CursorQuality;
}

/**
 * Forward-only customer-wide cursor watermark write. Throws on
 * failure: callers in the handler treat watermark loss as a
 * reconcile-critical event and need to react (log + still return 200,
 * per issue #295 decision 9). The other ingest hooks in this file are
 * fire-and-forget because they have a reconcile recovery path keyed on
 * customer-DB state; the cursor watermark's only recovery source is
 * the `phase2.ingest` audit row, so we must NOT swallow the underlying
 * write failure here.
 */
export async function applyCursorWatermarkHook(
  authPool: Pool,
  input: CursorWatermarkHookInput,
): Promise<void> {
  const client = await authPool.connect();
  try {
    await recordCursorWatermark(
      client,
      input.customerId,
      input.cursorEventTime,
      input.cursorQuality,
    );
  } finally {
    client.release();
  }
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
   *
   * Each event additionally carries its identity
   * `(baselineVersion, sourceAiceId, eventKey)` so the #493 auto-analysis
   * seeder can seed `event_analysis_job` rows for loose events without
   * re-querying the customer DB.
   */
  acceptedEvents: Array<{
    eventTime: Date;
    receivedAt: Date;
    baselineVersion: string;
    sourceAiceId: string;
    eventKey: string;
  }>;
}

/**
 * Best-effort auth-DB hook fired after a baseline batch's customer-DB commit
 * returns. Dirties the periodic report state (`recordBaselineActivity`) AND
 * seeds individual baseline-event auto-analysis jobs for loose events (#493).
 * Needs `customerPool` for the seeder's loose-membership / dedup reads. Any
 * failure is logged and swallowed (decision 2) — never blocks ingest.
 */
export async function applyBaselineIngestHook(
  authPool: Pool,
  customerPool: Pool,
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
      const candidates: BaselineSeedCandidate[] = input.acceptedEvents.map(
        (e) => ({
          baselineVersion: e.baselineVersion,
          sourceAiceId: e.sourceAiceId,
          eventKey: e.eventKey,
        }),
      );
      await seedBaselineEventJobs(
        { authClient: client, customerPool },
        { customerId: input.customerId, tz, candidates },
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
  /**
   * Round-19 review item 1: pre-mutation source-time-aligned LIVE
   * overlap flags captured inside `executeWindowReplace`'s
   * transaction. `priorLiveBaselineOverlap` is true when the DELETE
   * removed at least one `baseline_event` whose `event_time` lay in
   * BOTH the envelope AND the rolling LIVE window at delete time;
   * `priorLiveStoryOverlap` is true when the DELETE removed at least
   * one `story` whose `[time_window_start, time_window_end]`
   * overlapped BOTH the envelope AND the rolling LIVE window.
   *
   * These flags are required because a delete-only refresh-window /
   * backfill leaves no post-commit row for `computeLiveEnvelopeActivity`'s
   * source-time `baselineTouched` / `storyTouched` EXISTS predicates
   * to find, but the LIVE periodic state's input HAS changed and the
   * stale `ready` / `done` row must be flipped to `dirty`. Reconcile
   * cannot recover this class either: LIVE has no per-bucket count
   * for deletion-detection (the rolling 24h is a moving window, not
   * a fixed bucket) and `deriveAllBuckets` stops paging LIVE once
   * the trailing 24h holds no source row.
   *
   * Optional for backwards compatibility with call sites that fire
   * the envelope hook without a window-replace mutation (e.g. only
   * the periodic dirty path); those callers leave both flags
   * defaulting to false.
   */
  priorLiveBaselineOverlap?: boolean;
  priorLiveStoryOverlap?: boolean;
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
      const storyAggregateByBucket =
        await computeOverlappingBucketStoryAggregates(
          authClient,
          customerPool,
          input.customerId,
          tz,
        );
      // Round-18 review item 1: source-time-aligned LIVE signals.
      // The envelope is source-time, so the LIVE branch can no longer
      // use commit-time `last_story_received_at` for envelope
      // matching. The hook now queries the customer DB post-commit
      // for: (a) does any baseline event with `event_time` in BOTH
      // the rolling LIVE window AND the envelope exist, and (b) does
      // any latest-version story whose `[time_window_start,
      // time_window_end]` overlaps BOTH the rolling LIVE window AND
      // the envelope exist. These booleans, plus trailing-24h
      // post-commit aggregates for the LIVE forward-patch columns,
      // are forwarded to `dirtyPeriodicStatesOverlapping`.
      const liveActivity = await computeLiveEnvelopeActivity(
        customerPool,
        input.from,
        input.to,
      );
      // Round-19 review item 1: OR the post-commit `touched` flags
      // with the pre-mutation `priorLive*Overlap` flags captured
      // during the window-replace transaction. The post-commit
      // EXISTS predicates miss delete-only envelopes that cleared
      // the only LIVE-contributing source rows; the pre-mutation
      // flags catch exactly that class. Forward-patch columns stay
      // sourced from the post-commit aggregates (they're already
      // GREATEST-merged in `dirtyPeriodicStatesOverlapping`, so a
      // NULL aggregate from an emptied window leaves stored values
      // unchanged — no roll-back).
      const liveActivityWithPrior: PeriodicEnvelopeLiveActivity = {
        baselineTouched:
          liveActivity.baselineTouched ||
          (input.priorLiveBaselineOverlap ?? false),
        storyTouched:
          liveActivity.storyTouched || (input.priorLiveStoryOverlap ?? false),
        baselineMaxEventAt: liveActivity.baselineMaxEventAt,
        baselineMaxReceivedAt: liveActivity.baselineMaxReceivedAt,
        storyMaxReceivedAt: liveActivity.storyMaxReceivedAt,
      };
      await dirtyPeriodicStatesOverlapping(
        authClient,
        input.customerId,
        input.from,
        input.to,
        eventCountByBucket,
        storyAggregateByBucket,
        liveActivityWithPrior,
      );
    } finally {
      authClient.release();
    }
  } catch (err) {
    logHookFailure("refresh_window_envelope", input.customerId, err);
  }
}

/**
 * Round-18 review item 1: post-commit, source-time-aligned LIVE
 * activity for the envelope. Returns:
 *   - `baselineTouched` — true iff at least one `baseline_event`
 *     row has `event_time` in BOTH the rolling LIVE window
 *     (`[NOW()-24h, NOW())`) AND the envelope `[from, to)`.
 *   - `storyTouched` — true iff at least one latest-version `story`
 *     has `[time_window_start, time_window_end]` overlapping BOTH
 *     the rolling LIVE window AND the envelope.
 *   - `baselineMaxEventAt` / `baselineMaxReceivedAt` — trailing-24h
 *     post-commit aggregates (mirrors `loadLatestBaselineActivity`)
 *     so the LIVE row's source columns advance in lockstep with
 *     reconcile.
 *   - `storyMaxReceivedAt` — trailing-24h post-commit aggregate
 *     mirroring `loadLatestStoryActivity`.
 *
 * The trailing-24h filter on each side mirrors the hot ingest path
 * (`recordBaselineActivity`'s `event_time >= NOW() - 24h` predicate)
 * and reconcile's `loadLatestBaselineActivity` / `loadLatestStoryActivity`
 * loader trim, so a historical refresh-window / backfill that does
 * not touch the rolling LIVE window cannot dirty LIVE through either
 * the hot path or reconcile.
 */
async function computeLiveEnvelopeActivity(
  customerPool: Pool,
  from: Date,
  to: Date,
): Promise<PeriodicEnvelopeLiveActivity> {
  const { rows } = await customerPool.query<{
    baseline_touched: boolean;
    story_touched: boolean;
    baseline_max_event_at: Date | null;
    baseline_max_received_at: Date | null;
    story_max_received_at: Date | null;
  }>(
    // Round-19 review item 2: deterministic "latest version per
    // story_id" under received_at ties. story.received_at defaults to
    // NOW(), which is transaction-stable -- two story_versions for the
    // same story_id accepted in one window-replace payload share the
    // same received_at value, and the previous JOIN-on-MAX shape
    // returned every tied version, letting a superseded version's
    // time_window_* feed periodic-bucket aggregates. DISTINCT ON
    // (story_id) plus ORDER BY (received_at DESC, story_version DESC)
    // picks exactly one canonical version per story_id -- the most
    // recent received_at, with a deterministic story_version
    // tiebreaker keyed on the table's PRIMARY KEY column so the choice
    // is stable across queries.
    `WITH latest_versions AS (
       SELECT DISTINCT ON (story_id)
              story_id, story_version, time_window_start, time_window_end,
              received_at
         FROM story
        ORDER BY story_id, received_at DESC, story_version DESC
     ),
     live_baseline AS (
       -- Round-20 review item 1: half-open LIVE window
       -- event_time in NOW()-24h .. NOW(). The outer WHERE bounds the
       -- LIVE maxima forwarded to dirtyPeriodicStatesOverlapping, and
       -- the inner EXISTS bounds baselineTouched; without
       -- event_time < NOW() a future-dated baseline_event inside the
       -- envelope (or globally) would dirty / forward-patch LIVE on
       -- input that is not actually in the rolling LIVE window. The
       -- delete-flag CTE in executeWindowReplace already uses the
       -- half-open form; this is the post-commit counterpart.
       SELECT MAX(event_time)  AS max_event_at,
              MAX(received_at) AS max_received_at,
              EXISTS (
                SELECT 1 FROM baseline_event
                 WHERE event_time >= NOW() - INTERVAL '24 hours'
                   AND event_time <  NOW()
                   AND event_time >= $1::timestamptz
                   AND event_time <  $2::timestamptz
              ) AS touched
         FROM baseline_event
        WHERE event_time >= NOW() - INTERVAL '24 hours'
          AND event_time <  NOW()
     ),
     live_story AS (
       SELECT MAX(received_at) AS max_received_at,
              EXISTS (
                SELECT 1 FROM latest_versions
                 WHERE time_window_start <  NOW()
                   AND time_window_end   >= NOW() - INTERVAL '24 hours'
                   AND time_window_start <  $2::timestamptz
                   AND time_window_end   >  $1::timestamptz
              ) AS touched
         FROM latest_versions
        WHERE time_window_start <  NOW()
          AND time_window_end   >= NOW() - INTERVAL '24 hours'
     )
     SELECT
       (SELECT touched          FROM live_baseline) AS baseline_touched,
       (SELECT touched          FROM live_story)    AS story_touched,
       (SELECT max_event_at     FROM live_baseline) AS baseline_max_event_at,
       (SELECT max_received_at  FROM live_baseline) AS baseline_max_received_at,
       (SELECT max_received_at  FROM live_story)    AS story_max_received_at`,
    [from.toISOString(), to.toISOString()],
  );
  const row = rows[0];
  if (!row) {
    return {
      baselineTouched: false,
      storyTouched: false,
      baselineMaxEventAt: null,
      baselineMaxReceivedAt: null,
      storyMaxReceivedAt: null,
    };
  }
  return {
    baselineTouched: row.baseline_touched ?? false,
    storyTouched: row.story_touched ?? false,
    baselineMaxEventAt: row.baseline_max_event_at,
    baselineMaxReceivedAt: row.baseline_max_received_at,
    storyMaxReceivedAt: row.story_max_received_at,
  };
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
        AND status IN ('pending', 'ready', 'dirty')
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

/**
 * Round-12 review item 1: per-bucket post-commit story aggregates for
 * every DAILY / WEEKLY / MONTHLY `periodic_report_state` row in the
 * customer's tz (NOT scoped to the envelope range — the dirty UPDATE
 * uses its own overlap predicate). Bucket enumeration comes from the
 * auth-DB state rows, the same way `computeOverlappingBucketCounts`
 * enumerates buckets, so a story-side delete-only envelope that leaves
 * a bucket with zero overlapping stories still reaches the
 * `story_count = 0` reset.
 *
 * Latest-version semantics match `loadPerBucketStoryAggregates` in
 * reconcile: only each `(story_id)`'s `MAX(received_at)` version
 * participates, so superseded versions do not double-count or skew
 * the max.
 */
async function computeOverlappingBucketStoryAggregates(
  authClient: import("pg").PoolClient,
  customerPool: Pool,
  customerId: string,
  tz: string,
): Promise<Map<string, PeriodicEnvelopeStoryAggregate>> {
  const { rows: keys } = await authClient.query<{
    period: string;
    bucket_date: string;
  }>(
    `SELECT period, bucket_date::text AS bucket_date
       FROM periodic_report_state
      WHERE customer_id = $1
        AND tz          = $2
        AND status IN ('pending', 'ready', 'dirty')
        AND period IN ('DAILY', 'WEEKLY', 'MONTHLY')`,
    [customerId, tz],
  );
  if (keys.length === 0) return new Map();
  const periods = keys.map((k) => k.period);
  const dates = keys.map((k) => k.bucket_date);
  const { rows } = await customerPool.query<{
    period: string;
    bucket_date: string;
    max_rcv: Date | null;
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
     ),
     -- Round-19 review item 2: deterministic "latest version per
     -- story_id" — see computeLiveEnvelopeActivity above; same shape.
     latest_versions AS (
       SELECT DISTINCT ON (story_id)
              story_id, story_version, time_window_start, time_window_end,
              received_at
         FROM story
        ORDER BY story_id, received_at DESC, story_version DESC
     )
     SELECT t.period,
            t.bucket_date::text AS bucket_date,
            MAX(lv.received_at)         AS max_rcv,
            COUNT(DISTINCT lv.story_id)::text AS cnt
       FROM targets t
       LEFT JOIN latest_versions lv
         ON lv.time_window_start < t.bucket_end
        AND lv.time_window_end   > t.bucket_start
      GROUP BY t.period, t.bucket_date`,
    [tz, periods, dates],
  );
  const out = new Map<string, PeriodicEnvelopeStoryAggregate>();
  for (const r of rows) {
    out.set(`${r.period}|${r.bucket_date}`, {
      maxReceivedAt: r.max_rcv,
      count: Number(r.cnt),
    });
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
