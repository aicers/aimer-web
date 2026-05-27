-- RFC 0002 Phase 0 (#294) — round-12 review item 1.
--
-- Story refresh-window / backfill envelopes can mutate the inputs of
-- an already-generated DAILY / WEEKLY / MONTHLY report without
-- touching any `baseline_event` row. The route handlers fire
-- `applyWindowReplaceEnvelopeHook` post-commit to dirty overlapping
-- periodic rows, but the hook is best-effort (decision 2): failure is
-- swallowed and reconcile must pick up the slack.
--
-- Reconcile's existing periodic dirty / forward-patch signals are
-- baseline-only (`baseline_event.event_time` + `baseline_event.received_at`
-- + `event_count`). On a story-only envelope whose hook failed, those
-- signals do not move, so a stale `ready` / `done` periodic report
-- could remain forever.
--
-- These two columns are the per-bucket story-side mirror of the
-- baseline pair:
--
--   * `last_story_received_at` — `MAX(story.received_at)` across
--     latest-version `story` rows whose `time_window_*` overlaps the
--     bucket. Advances every time a new story version lands inside
--     the bucket, regardless of `event_time`-style signals. Reconcile
--     uses it as the monotone "did the bucket receive a new story?"
--     trigger.
--
--   * `story_count` — `COUNT(DISTINCT story_id)` of latest-version
--     stories overlapping the bucket. Reconcile compares the stored
--     value against the current count: a delete-only / window-replace
--     envelope that REMOVES a story from the bucket without advancing
--     `received_at` still surfaces as `currentCount <> stored`, which
--     flips the row to `dirty` and re-syncs the stored count.
--
-- LIVE rows are intentionally excluded from the dirty trigger because
-- the LIVE window is a moving trailing-24h target — the analogous
-- baseline `event_count` rule already excludes LIVE for the same
-- reason. The columns exist on LIVE rows (DEFAULT 0 / NULL) but the
-- reconcile + envelope-hook logic only acts on DAILY / WEEKLY /
-- MONTHLY for these signals.

ALTER TABLE periodic_report_state
  ADD COLUMN last_story_received_at TIMESTAMPTZ;
ALTER TABLE periodic_report_state
  ADD COLUMN story_count BIGINT NOT NULL DEFAULT 0;
