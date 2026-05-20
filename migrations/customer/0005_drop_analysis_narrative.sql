-- Drop `analysis_narrative` (RFC 0001 §"analysis_narrative retirement").
--
-- This is the moment described in #250's deferral note: `event_analysis_result`
-- is now the live cache path for per-event AI analysis, so the legacy
-- `analysis_narrative` table can be retired. The migration is unconditional
-- (no data migration) because the project is greenfield — the table is empty
-- per RFC 0001 §"Acceptance / status".
--
-- The retroactive re-redact job and sweeper never wrote to this table, so
-- nothing on the runtime side outlives the drop.

DROP INDEX IF EXISTS analysis_narrative_target_kind_generated_at_idx;
DROP TABLE IF EXISTS analysis_narrative;
