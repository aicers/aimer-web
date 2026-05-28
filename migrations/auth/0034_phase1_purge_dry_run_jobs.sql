-- RFC 0002 Phase 1 (#296) — purge Phase 0 dry-run jobs.
--
-- Phase 0 (#294) wrote `story_analysis_job` rows as `dry_run=TRUE,
-- status='done'` to exercise state transitions without calling the LLM.
-- Phase 1 enables real LLM calls; the dispatcher keys on
-- `NOT EXISTS (default-variant job)` and would otherwise see the
-- Phase 0 `done` rows and skip the real first generation.
--
-- This migration runs before the worker enables real LLM calls. State
-- rows are untouched — the next worker tick re-enqueues a real
-- (non-dry-run) job for every `ready`/`dirty` state row.

DELETE FROM story_analysis_job WHERE dry_run = TRUE;

-- Belt-and-braces sweep of any stale jobs whose parent state archived
-- after Phase 0 (state archival doesn't cascade-delete jobs).
DELETE FROM story_analysis_job j
  USING story_analysis_state s
  WHERE j.customer_id = s.customer_id
    AND j.story_id = s.story_id
    AND s.status = 'archived';
