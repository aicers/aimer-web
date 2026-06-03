-- WS3 (#392) — denormalize the canonical variant's priority onto
-- `story_analysis_state` so the customer-scoped Threat Stories list can
-- order priority-first and paginate with a stable server-side keyset in a
-- single auth-DB query.
--
-- Discovery + lifecycle (`status`, recency timestamps) already live here in
-- the auth DB, while priority/scores live in the customer DB
-- (`story_analysis_result`). The two DBs cannot be JOINed, so without these
-- mirror columns priority could not be an ordering or pagination key (the
-- report-index loader caps by recency in auth and enriches from the
-- customer DB only afterward). Denormalizing the canonical
-- (default lang/model, latest generation, not superseded) variant's
-- `priority_tier` + scores keeps both ordering and the keyset cursor inside
-- one query, and keeps the `status` lifecycle filter available alongside.
--
-- Lifecycle of these columns (written by the story worker / state hooks):
--   * `pending` (no result yet) — NULL; the list loader excludes NULLs.
--   * `ready`/`dirty` — last-known canonical values; `dirty` keeps the prior
--     generation's values until the refresh finalizes.
--   * unarchive → `pending` — cleared back to NULL (the prior narrative is
--     gone; a fresh result will repopulate them).
--   * `archived` — excluded from the default list regardless of value.
--
-- The worker only writes these at story-job finalization, after the
-- customer-DB result INSERT, and only for the canonical default variant.
-- Source-lifecycle transitions that fire before a result exists must not
-- invent scores. Pre-release: no backfill (see #386 conventions).

ALTER TABLE story_analysis_state
  ADD COLUMN priority_tier    TEXT
    CHECK (priority_tier IN ('CRITICAL', 'HIGH', 'MEDIUM', 'LOW'));
ALTER TABLE story_analysis_state
  ADD COLUMN severity_score   DOUBLE PRECISION;
ALTER TABLE story_analysis_state
  ADD COLUMN likelihood_score DOUBLE PRECISION;

-- Supports the Threat Stories list's default scan: the loader filters
-- non-archived rows that have a denormalized result (`priority_tier IS NOT
-- NULL`) and orders priority-first. The list scope is always a single
-- customer, so `customer_id` leads the index.
CREATE INDEX story_analysis_state_priority_idx
    ON story_analysis_state (customer_id)
    WHERE status <> 'archived' AND priority_tier IS NOT NULL;
