-- aimer#480 (#474) — event provenance NOT NULL parity with story.
--
-- `event_analysis_result.model_actual_version` / `prompt_version` were
-- created nullable in 0003_redaction_foundation because aimer's event
-- result type did not yet expose them, so #463 left them always null.
-- aimer#480 now returns both as `String!` (always populated, mirroring
-- `StoryAnalysisResult`), and the BFF write path binds them on every
-- insert, so the columns can match `story_analysis_result`'s NOT NULL.
--
-- No backfill for legacy null rows: this relies on the pre-release
-- dev-DB reset policy (no production data predates the populated path).

ALTER TABLE event_analysis_result
    ALTER COLUMN model_actual_version SET NOT NULL;
ALTER TABLE event_analysis_result
    ALTER COLUMN prompt_version SET NOT NULL;
