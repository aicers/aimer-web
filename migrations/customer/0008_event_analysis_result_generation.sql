-- RFC 0002 Phase 2 (#297, round-14 item 1) — generation provenance on
-- event_analysis_result.
--
-- Round-13 specified `input_event_refs = [{aice_id, event_key,
-- generation}, ...]` for periodic reports, but the RFC 0001
-- event-analysis table had no `generation` column — force=true
-- re-analysis OVERWROTE on the full PK (0003_redaction_foundation.sql).
-- That left periodic-report citations pointing at a row whose content
-- could silently change under them.
--
-- We are still in pre-release dev (no production data to backfill), so
-- the fix is to extend the schema to match `story_analysis_result`'s
-- generation-stamped shape rather than carry an asymmetric provenance:
--
--   * add `generation INT NOT NULL DEFAULT 1`
--   * add `superseded_at TIMESTAMPTZ`
--   * extend the PK to `(aice_id, event_key, lang, model_name, model,
--     generation)`
--
-- The RFC 0001 event-analysis write path (`run-analyze-flow.ts`) is
-- updated in the same PR to stamp `superseded_at = NOW()` on the prior
-- generation and INSERT a fresh `generation = N+1` row on `force=true`
-- (and `generation = 1` on first analyses), and both read paths now
-- select the latest non-superseded row for the variant.

ALTER TABLE event_analysis_result
    ADD COLUMN generation INT NOT NULL DEFAULT 1;

ALTER TABLE event_analysis_result
    ADD COLUMN superseded_at TIMESTAMPTZ;

-- Extend the PK to carry `generation`, matching `story_analysis_result`.
-- The DEFAULT 1 on the new column means any rows present in a dev DB
-- collapse to generation 1, which is unique per pre-existing PK tuple,
-- so the new PK is satisfiable without a backfill step.
ALTER TABLE event_analysis_result
    DROP CONSTRAINT event_analysis_result_pkey;

ALTER TABLE event_analysis_result
    ADD PRIMARY KEY (aice_id, event_key, lang, model_name, model, generation);

-- The grant comment in 0003_redaction_foundation.sql described
-- event_analysis_result as "mutated by force=true re-analysis". That is
-- no longer the pattern: re-analysis now stamps `superseded_at` on the
-- prior generation and INSERTs a fresh generation row, so UPDATE is used
-- only to set `superseded_at`, never to overwrite content. The existing
-- SELECT/INSERT/UPDATE/DELETE grant already covers the new pattern; this
-- migration only documents the shift.
COMMENT ON COLUMN event_analysis_result.generation IS
    'Forensic generation counter. force=true re-analysis stamps superseded_at on the prior generation and INSERTs generation = N+1 (RFC 0002 #297 round-14 item 1).';
COMMENT ON COLUMN event_analysis_result.superseded_at IS
    'Set when a newer generation supersedes this row; latest live row is superseded_at IS NULL.';
