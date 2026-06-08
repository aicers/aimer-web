-- Baseline auto-analysis result provenance + non-human requester (#493).
--
-- The individual baseline-event auto-analysis path (RFC 0002 amendment
-- #489) writes `event_analysis_result` rows with no human requester. Two
-- changes support it:
--
--   1. `origin` — distinguishes auto-baseline rows from the manual
--      synchronous path. Defaults to `manual` so all existing rows (and
--      the unchanged manual flow) keep their meaning.
--   2. `requested_by` relaxed to NULLABLE — the auto path has no human
--      requester. This matches the `story_analysis_result.requested_by`
--      precedent (`0007`, already nullable for worker-generated rows)
--      rather than inventing a synthetic system principal; the worker is
--      attributed via the audit actor instead.

ALTER TABLE event_analysis_result
    ADD COLUMN origin TEXT NOT NULL DEFAULT 'manual'
        CHECK (origin IN ('manual', 'auto_baseline'));

ALTER TABLE event_analysis_result
    ALTER COLUMN requested_by DROP NOT NULL;
