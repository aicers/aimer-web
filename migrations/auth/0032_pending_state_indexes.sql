-- RFC 0002 Phase 0 (#294) — round-15 review item 1.
--
-- The Phase 0 analysis worker polls pending state rows every 30s:
--
--   * `tickStoryStates` selects `story_analysis_state WHERE status =
--     'pending'` ordered by `(customer_id, story_id)` to promote
--     ready-eligible stories
--     (`src/lib/instrumentation/analysis-job-worker.ts`).
--
--   * `tickPeriodicStates` updates `periodic_report_state WHERE status
--     = 'pending'` for the LIVE seed and again for DAILY / WEEKLY /
--     MONTHLY settle/quiet-window promotion.
--
-- Migrations 0028 / 0029 only added partial status indexes for `status
-- IN ('ready', 'dirty')`, so the pending scans had no usable index and
-- would devolve into full table scans as state volume grew.
--
-- Round-14 also made pending part of the hot path: refresh-window /
-- backfill envelope hooks now forward-patch pending rows in place, so
-- pending is no longer a brief transient — it is a steady-state mix
-- alongside ready / dirty.
--
-- These partial indexes mirror the existing `status IN ('ready',
-- 'dirty')` partials. Index columns match the ORDER BY / lookup key
-- used by the pending scans (`(customer_id, story_id)` for story;
-- `(customer_id, period, bucket_date, tz)` for periodic) so the
-- planner can satisfy both the predicate and the ordering from the
-- index alone.

CREATE INDEX story_analysis_state_pending_idx
    ON story_analysis_state (customer_id, story_id)
    WHERE status = 'pending';

CREATE INDEX periodic_report_state_pending_idx
    ON periodic_report_state (customer_id, period, bucket_date, tz)
    WHERE status = 'pending';
