-- RFC 0002 Phase 2 (#297) — purge Phase 0 dry-run periodic report jobs.
--
-- Phase 0 (#294) wrote `periodic_report_job` rows as `dry_run=TRUE,
-- status='done'` to exercise LIVE/DAILY state transitions without
-- calling the LLM. Phase 2 enables real `generatePeriodicSecurityReport`
-- calls; the dispatcher keys on `NOT EXISTS (default-variant job)` and
-- would otherwise see the Phase 0 `done` rows and skip the real first
-- generation. #294 decision 3 also locked that dry-run rows are not
-- counted against `ANALYSIS_MAX_GENERATION` and must not survive into
-- the phase that writes real results.
--
-- This migration runs before the worker enables real LLM calls. State
-- rows are untouched — the next worker tick re-enqueues a real
-- (non-dry-run) job for every `ready`/`dirty` LIVE/DAILY state row.

DELETE FROM periodic_report_job WHERE dry_run = TRUE;

-- Belt-and-braces sweep of stale jobs whose parent state archived after
-- Phase 0 (state archival doesn't cascade-delete jobs).
DELETE FROM periodic_report_job j
  USING periodic_report_state s
  WHERE j.customer_id = s.customer_id
    AND j.period      = s.period
    AND j.bucket_date = s.bucket_date
    AND j.tz          = s.tz
    AND s.status      = 'archived';
