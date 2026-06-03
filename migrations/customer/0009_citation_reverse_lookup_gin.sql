-- T2 (#396) — GIN indexes for the reverse-citation lookup.
--
-- T1 (#395) wired the forward report → cited-leaf direction (the Sources
-- panel reads `input_story_refs` / `input_event_refs` off the already-
-- resolved report row). T2 adds the reverse trail: from a leaf (event or
-- story) detail page back up to the report(s) that cited it, and from an
-- event up to the story that includes it. Those lookups are JSONB
-- containment (`@>`) scans against the same ref columns:
--
--   * citing reports for an event:
--       periodic_report_result.input_event_refs @> '[{"aice_id":…,"event_key":…}]'
--   * citing reports for a story:
--       periodic_report_result.input_story_refs @> '[{"story_id":…}]'
--   * parent story for an event:
--       story_analysis_result.input_event_refs @> '[{"aiceId":…,"eventKey":…}]'
--
-- Migration 0007 only shipped btree indexes (requested_at / story /
-- bucket); without a GIN index every `@>` would seq-scan the table. The
-- precedent for this follow-up is noted in 0002_phase2_tables.sql
-- ("add … USING GIN … in a follow-up if needed"). We use `jsonb_path_ops`,
-- the operator class tuned for `@>` containment — smaller and faster than
-- the default `jsonb_ops`; it only supports containment, which is exactly
-- the query shape here.
--
-- These are plain (non-CONCURRENTLY) index builds so the migration stays
-- atomic inside the runner's per-migration transaction. aimer-web is still
-- pre-release (see 0008's note: "no production data to backfill"), so the
-- brief build-time lock on a freshly-provisioned customer table is a
-- non-issue; a CONCURRENTLY rebuild can be a follow-up if a live table
-- ever needs it. `IF NOT EXISTS` keeps the migration idempotent.

CREATE INDEX IF NOT EXISTS
    periodic_report_result_input_event_refs_gin
    ON periodic_report_result
    USING GIN (input_event_refs jsonb_path_ops);

CREATE INDEX IF NOT EXISTS
    periodic_report_result_input_story_refs_gin
    ON periodic_report_result
    USING GIN (input_story_refs jsonb_path_ops);

CREATE INDEX IF NOT EXISTS
    story_analysis_result_input_event_refs_gin
    ON story_analysis_result
    USING GIN (input_event_refs jsonb_path_ops);
