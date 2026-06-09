// RFC 0004 (#524 scope 5) — group periodic-report readiness tick + recompute.
//
// A group has no events of its own, so the per-customer ingest hook
// (`recordBaselineActivity`) never promotes its `periodic_report_state` rows
// — those rows key on the group `subject_id` but no ingest writes them. This
// is the SEPARATE group readiness tick (deliberately NOT hung off member
// ingest): it derives the group's bucket set by unioning the MEMBER DBs in the
// GROUP tz, seeds + recomputes the group's `periodic_report_state`, and lets
// the existing kind-agnostic machinery (`tickPeriodicStates` promotion,
// `seedRealReportJobs`, `requeueLiveReportJobs`) carry those rows forward into
// real LLM jobs across all four periods (LIVE / DAILY / WEEKLY / MONTHLY).
//
//   - SEED: a missing group bucket is inserted (`pending`, or `ready` for
//     LIVE) with the summed/maxed member aggregates. Non-retroactive — a
//     bucket whose date precedes the group's creation bucket (in the group tz)
//     is never seeded.
//   - RECOMPUTE: when member data changes AFTER a group bucket was generated,
//     the existing `ready` row is flipped to `dirty` (the group analogue of
//     `recordBaselineActivity`'s per-customer dirtying) so the requeue path
//     regenerates it. The advance signal is the summed `event_count` /
//     `story_count` or an advanced `last_event_at` / `last_event_received_at`
//     / `last_story_received_at` watermark.
//
// Per-member source derivation reuses the reconcile loaders (passing the GROUP
// tz + the MEMBER connection) so the bucketing math stays in lockstep with the
// per-customer reconcile path.

import "server-only";

import type { Pool, PoolClient } from "pg";
import { getCustomerRuntimePool } from "../db/customer-runtime-pool";
import { getCurrentTimestamp } from "../instrumentation/time";
import {
  type CustomerConnection,
  loadLatestBaselineActivity,
  loadLatestStoryActivity,
  loadPerBucketMaxEventTimes,
  loadPerBucketStoryAggregates,
} from "./reconcile";
import { LIVE_BUCKET_DATE } from "./state";

export interface GroupReadinessDeps {
  authPool: Pool;
  /** Member-pool connector, overridable for tests. */
  connectMember?: (customerId: string) => CustomerConnection;
}

export interface GroupReadinessOutcome {
  groups: number;
  statesSeeded: number;
  statesDirtied: number;
  statesPatched: number;
}

interface ActiveGroup {
  id: string;
  tz: string;
  createdAt: Date;
  memberIds: string[];
}

/** Later of two nullable dates (NULLs ignored). */
function maxDate(a: Date | null, b: Date | null): Date | null {
  if (a === null) return b;
  if (b === null) return a;
  return a.getTime() >= b.getTime() ? a : b;
}

/** Whether `next` strictly advances past `stored` (a NULL stored advances). */
function advances(stored: Date | null, next: Date | null): boolean {
  return (
    next !== null && (stored === null || next.getTime() > stored.getTime())
  );
}

/** Wrap a runtime `Pool` as the read-only `CustomerConnection` the loaders want. */
function poolConnection(pool: Pool): CustomerConnection {
  return {
    query: pool.query.bind(pool) as PoolClient["query"],
    end: async () => {},
  };
}

async function loadActiveGroups(authPool: Pool): Promise<ActiveGroup[]> {
  const { rows } = await authPool.query<{
    id: string;
    tz: string;
    created_at: Date;
    member_ids: string[];
  }>(
    `SELECT g.id::text AS id, g.tz, g.created_at,
            COALESCE(
              array_agg(m.customer_id::text) FILTER (WHERE m.customer_id IS NOT NULL),
              '{}'
            ) AS member_ids
       FROM customer_groups g
       LEFT JOIN customer_group_members m ON m.group_id = g.id
      WHERE g.database_status = 'active'
      GROUP BY g.id, g.tz, g.created_at
      ORDER BY g.id`,
  );
  return rows.map((r) => ({
    id: r.id,
    tz: r.tz,
    createdAt: r.created_at,
    memberIds: r.member_ids,
  }));
}

/**
 * The earliest seedable `bucket_date` per non-LIVE period: the bucket
 * containing the group's creation instant, truncated in the group tz. A bucket
 * strictly before this is pre-creation and never seeded (#524 non-retroactive).
 */
async function creationFloors(
  authPool: Pool,
  createdAt: Date,
  tz: string,
): Promise<{ DAILY: string; WEEKLY: string; MONTHLY: string }> {
  const { rows } = await authPool.query<{
    daily: string;
    weekly: string;
    monthly: string;
  }>(
    `SELECT date_trunc('day',   $1::timestamptz AT TIME ZONE $2)::date::text AS daily,
            date_trunc('week',  $1::timestamptz AT TIME ZONE $2)::date::text AS weekly,
            date_trunc('month', $1::timestamptz AT TIME ZONE $2)::date::text AS monthly`,
    [createdAt.toISOString(), tz],
  );
  const r = rows[0];
  return { DAILY: r.daily, WEEKLY: r.weekly, MONTHLY: r.monthly };
}

interface NonLiveAgg {
  eventCount: number;
  maxEventAt: Date | null;
  maxReceivedAt: Date | null;
  storyCount: number;
  maxStoryReceivedAt: Date | null;
}

interface ExistingState {
  status: string;
  last_event_at: Date | null;
  last_event_received_at: Date | null;
  event_count: string;
  last_story_received_at: Date | null;
  story_count: string;
}

/**
 * Run the group readiness tick over every active group. Returns aggregate
 * seed / dirty / patch counts (for the worker log + tests).
 */
export async function tickGroupReadiness(
  deps: GroupReadinessDeps,
  nowIso: string = getCurrentTimestamp().toISOString(),
): Promise<GroupReadinessOutcome> {
  const connectMember =
    deps.connectMember ??
    ((customerId: string) =>
      poolConnection(getCustomerRuntimePool(customerId)));
  const groups = await loadActiveGroups(deps.authPool);
  let statesSeeded = 0;
  let statesDirtied = 0;
  let statesPatched = 0;
  for (const g of groups) {
    const out = await reconcileGroup(deps.authPool, g, connectMember, nowIso);
    statesSeeded += out.seeded;
    statesDirtied += out.dirtied;
    statesPatched += out.patched;
  }
  return { groups: groups.length, statesSeeded, statesDirtied, statesPatched };
}

async function reconcileGroup(
  authPool: Pool,
  g: ActiveGroup,
  connectMember: (customerId: string) => CustomerConnection,
  nowIso: string,
): Promise<{ seeded: number; dirtied: number; patched: number }> {
  const floors = await creationFloors(authPool, g.createdAt, g.tz);

  // --- Accumulate the union of member source aggregates in the group tz ---
  const nonLive = new Map<string, NonLiveAgg>(); // key `period|bucket_date`
  let liveActive = false;
  let liveMaxEventAt: Date | null = null;
  let liveMaxReceivedAt: Date | null = null;
  let liveMaxStoryReceivedAt: Date | null = null;

  const ensure = (key: string): NonLiveAgg => {
    const cur = nonLive.get(key);
    if (cur) return cur;
    const fresh: NonLiveAgg = {
      eventCount: 0,
      maxEventAt: null,
      maxReceivedAt: null,
      storyCount: 0,
      maxStoryReceivedAt: null,
    };
    nonLive.set(key, fresh);
    return fresh;
  };

  for (const memberId of g.memberIds) {
    const conn = connectMember(memberId);
    try {
      const bMax = await loadPerBucketMaxEventTimes(conn, g.tz);
      const sMax = await loadPerBucketStoryAggregates(conn, g.tz);
      const liveB = await loadLatestBaselineActivity(conn);
      const liveS = await loadLatestStoryActivity(conn);
      for (const [k, agg] of bMax) {
        // k = `period|bucket_date|tz`
        const [period, bd] = k.split("|");
        const cur = ensure(`${period}|${bd}`);
        cur.eventCount += agg.eventCount;
        cur.maxEventAt = maxDate(cur.maxEventAt, agg.maxEventAt);
        cur.maxReceivedAt = maxDate(cur.maxReceivedAt, agg.maxReceivedAt);
      }
      for (const [k, agg] of sMax) {
        const [period, bd] = k.split("|");
        const cur = ensure(`${period}|${bd}`);
        cur.storyCount += agg.storyCount;
        cur.maxStoryReceivedAt = maxDate(
          cur.maxStoryReceivedAt,
          agg.maxStoryReceivedAt,
        );
      }
      if (liveB) {
        liveActive = liveActive || liveB.liveActive;
        liveMaxEventAt = maxDate(liveMaxEventAt, liveB.maxEventAt);
        liveMaxReceivedAt = maxDate(liveMaxReceivedAt, liveB.maxReceivedAt);
      }
      if (liveS) {
        liveActive = true;
        liveMaxStoryReceivedAt = maxDate(
          liveMaxStoryReceivedAt,
          liveS.maxReceivedAt,
        );
      }
    } finally {
      conn.end().catch(() => {});
    }
  }

  // --- Existing group state rows for the current tz ---
  const existing = await loadExistingGroupStates(authPool, g.id, g.tz);

  let seeded = 0;
  let dirtied = 0;
  let patched = 0;

  // --- Non-LIVE buckets (DAILY/WEEKLY/MONTHLY) ---
  // Candidate keys are the UNION of the current member aggregates AND every
  // existing non-archived non-LIVE bucket. Merging in existing buckets covers
  // the zero-current-data case (member data for an already-generated bucket
  // was deleted or window-replaced down to zero rows): no aggregate key is
  // produced, but the stale `event_count`/`story_count` must still resync to
  // 0 and an already-generated bucket flip to `dirty`. Without this, that
  // member-data change would never dirty the group bucket — the per-customer
  // reconcile path merges existing buckets the same way.
  const zeroAgg: NonLiveAgg = {
    eventCount: 0,
    maxEventAt: null,
    maxReceivedAt: null,
    storyCount: 0,
    maxStoryReceivedAt: null,
  };
  const nonLiveKeys = new Set<string>(nonLive.keys());
  for (const [key, ex] of existing) {
    const [period] = key.split("|");
    if (
      ex.status !== "archived" &&
      (period === "DAILY" || period === "WEEKLY" || period === "MONTHLY")
    ) {
      nonLiveKeys.add(key);
    }
  }

  for (const key of nonLiveKeys) {
    const [period, bd] = key.split("|");
    if (period !== "DAILY" && period !== "WEEKLY" && period !== "MONTHLY") {
      continue;
    }
    // Non-retroactive: skip buckets before the group's creation bucket.
    if (bd < floors[period]) continue;

    // No current aggregate → zero counts / null watermarks, so an existing
    // bucket whose member data vanished resyncs to 0 and dirties.
    const agg = nonLive.get(key) ?? zeroAgg;
    const ex = existing.get(key);
    if (ex === undefined) {
      const res = await authPool.query(
        `INSERT INTO periodic_report_state
           (subject_id, period, bucket_date, tz, status,
            last_event_at, last_event_received_at, event_count,
            last_story_received_at, story_count)
         VALUES ($1, $2, $3::date, $4, 'pending', $5, $6, $7, $8, $9)
         ON CONFLICT (subject_id, period, bucket_date, tz) DO NOTHING`,
        [
          g.id,
          period,
          bd,
          g.tz,
          agg.maxEventAt?.toISOString() ?? null,
          agg.maxReceivedAt?.toISOString() ?? null,
          agg.eventCount,
          agg.maxStoryReceivedAt?.toISOString() ?? null,
          agg.storyCount,
        ],
      );
      seeded += res.rowCount ?? 0;
      continue;
    }
    if (ex.status === "archived") continue;

    // Recompute: only touch the row when a summed count or a watermark moved.
    const advanced =
      agg.eventCount !== Number(ex.event_count) ||
      agg.storyCount !== Number(ex.story_count) ||
      advances(ex.last_event_at, agg.maxEventAt) ||
      advances(ex.last_event_received_at, agg.maxReceivedAt) ||
      advances(ex.last_story_received_at, agg.maxStoryReceivedAt);
    if (!advanced) continue;

    const res = await authPool.query<{ dirtied: boolean }>(
      // Forward-patch watermarks (monotone via GREATEST, which ignores NULLs)
      // and resync the summed counts. Flip `ready` → `dirty` only when an
      // already-generated bucket (a processing/done job exists) advanced —
      // the group analogue of `recordBaselineActivity`'s dirty trigger.
      `UPDATE periodic_report_state
          SET last_event_at          = GREATEST(last_event_at, $5::timestamptz),
              last_event_received_at = GREATEST(last_event_received_at, $6::timestamptz),
              event_count            = $7,
              last_story_received_at = GREATEST(last_story_received_at, $8::timestamptz),
              story_count            = $9,
              status = CASE
                WHEN status = 'ready'
                  AND EXISTS (
                    SELECT 1 FROM periodic_report_job j
                     WHERE j.subject_id = $1 AND j.period = $2
                       AND j.bucket_date = $3::date AND j.tz = $4
                       AND j.status IN ('processing', 'done')
                  )
                THEN 'dirty'
                ELSE status
              END,
              updated_at = $10::timestamptz
        WHERE subject_id = $1 AND period = $2
          AND bucket_date = $3::date AND tz = $4
          AND status <> 'archived'
        RETURNING (status = 'dirty') AS dirtied`,
      [
        g.id,
        period,
        bd,
        g.tz,
        agg.maxEventAt?.toISOString() ?? null,
        agg.maxReceivedAt?.toISOString() ?? null,
        agg.eventCount,
        agg.maxStoryReceivedAt?.toISOString() ?? null,
        agg.storyCount,
        nowIso,
      ],
    );
    if (res.rows[0]?.dirtied) dirtied += 1;
    else patched += 1;
  }

  // --- LIVE bucket ---
  // A LIVE row should exist whenever any member has trailing-24h source data
  // (baseline event_time or overlapping story). LIVE is current, so it is not
  // bounded by the creation floor.
  if (liveActive) {
    const ex = existing.get(`LIVE|${LIVE_BUCKET_DATE}`);
    if (ex === undefined) {
      const res = await authPool.query(
        `INSERT INTO periodic_report_state
           (subject_id, period, bucket_date, tz, status,
            last_event_at, last_event_received_at, last_story_received_at,
            last_ready_at)
         VALUES ($1, 'LIVE', $2::date, $3, 'ready', $4, $5, $6, $7::timestamptz)
         ON CONFLICT (subject_id, period, bucket_date, tz) DO NOTHING`,
        [
          g.id,
          LIVE_BUCKET_DATE,
          g.tz,
          liveMaxEventAt?.toISOString() ?? null,
          liveMaxReceivedAt?.toISOString() ?? null,
          liveMaxStoryReceivedAt?.toISOString() ?? null,
          nowIso,
        ],
      );
      seeded += res.rowCount ?? 0;
    } else if (ex.status !== "archived") {
      const advanced =
        advances(ex.last_event_at, liveMaxEventAt) ||
        advances(ex.last_event_received_at, liveMaxReceivedAt) ||
        advances(ex.last_story_received_at, liveMaxStoryReceivedAt);
      if (advanced) {
        const res = await authPool.query<{ dirtied: boolean }>(
          `UPDATE periodic_report_state
              SET last_event_at          = GREATEST(last_event_at, $4::timestamptz),
                  last_event_received_at = GREATEST(last_event_received_at, $5::timestamptz),
                  last_story_received_at = GREATEST(last_story_received_at, $6::timestamptz),
                  status = CASE
                    WHEN status = 'ready'
                      AND EXISTS (
                        SELECT 1 FROM periodic_report_job j
                         WHERE j.subject_id = $1 AND j.period = 'LIVE'
                           AND j.bucket_date = $2::date AND j.tz = $3
                           AND j.status IN ('processing', 'done')
                      )
                    THEN 'dirty'
                    ELSE status
                  END,
                  updated_at = $7::timestamptz
            WHERE subject_id = $1 AND period = 'LIVE'
              AND bucket_date = $2::date AND tz = $3
              AND status <> 'archived'
            RETURNING (status = 'dirty') AS dirtied`,
          [
            g.id,
            LIVE_BUCKET_DATE,
            g.tz,
            liveMaxEventAt?.toISOString() ?? null,
            liveMaxReceivedAt?.toISOString() ?? null,
            liveMaxStoryReceivedAt?.toISOString() ?? null,
            nowIso,
          ],
        );
        if (res.rows[0]?.dirtied) dirtied += 1;
        else patched += 1;
      }
    }
  }

  return { seeded, dirtied, patched };
}

async function loadExistingGroupStates(
  authPool: Pool,
  groupId: string,
  tz: string,
): Promise<Map<string, ExistingState>> {
  const { rows } = await authPool.query<
    ExistingState & { period: string; bucket_date: string }
  >(
    `SELECT period, bucket_date::text AS bucket_date, status,
            last_event_at, last_event_received_at,
            event_count::text AS event_count,
            last_story_received_at,
            story_count::text AS story_count
       FROM periodic_report_state
      WHERE subject_id = $1 AND tz = $2`,
    [groupId, tz],
  );
  const out = new Map<string, ExistingState>();
  for (const r of rows) {
    out.set(`${r.period}|${r.bucket_date}`, r);
  }
  return out;
}
