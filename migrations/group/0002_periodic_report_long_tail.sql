-- RFC 0004 (#523) — group result-schema parity: long-tail columns.
--
-- Brings the group `periodic_report_result` schema to parity with the
-- latest customer result schema. The customer table gained these two
-- columns in migrations/customer/0016_periodic_report_long_tail.sql; the
-- group table (migrations/group/0001_periodic_report_result.sql) was cut
-- from the pre-0016 customer shape and so lacks exactly these two columns
-- — that delta is the entire current parity gap.
--
--   * `input_exemplar_refs` — the distinct representative leaves of the kept
--     long-tail exemplars, each `{ aice_id, event_key, generation,
--     model_name, model }` (and, for a group, a member `customer_id`).
--     `generation` pins the exact immutable leaf so replay/restore
--     re-resolves the exemplar `<<REDACTED_*_R{j}_*>>` token to the same
--     plaintext (mirrors `input_event_refs`).
--   * `input_analyzed_event_aggregates` — the exact `analyzedEventAggregates`
--     object sent (counts / rollups / tier distribution / exemplars). NULL
--     when the section was omitted (empty universe), keeping
--     `computeInputHash` byte-identical to a pre-long-tail report.
--
-- `writeResultRow` names BOTH columns unconditionally in its INSERT, so a
-- group write fails on the missing column regardless of content — this
-- migration is what lets a group result row be written at all.
--
-- Both are nullable with no default, mirroring customer 0016: under the
-- pre-release dev-DB reset policy no backfill is needed, and a NULL (rather
-- than a `'[]'` default) on a legacy row is read as "no long-tail
-- persisted". Forward-only: the applied 0001 is left untouched (the runner
-- checksum-guards applied migrations — migrations/README.md), exactly as
-- the customer set added these via a separate 0016 rather than editing
-- customer 0001.

ALTER TABLE periodic_report_result
    ADD COLUMN input_exemplar_refs              JSONB,
    ADD COLUMN input_analyzed_event_aggregates  JSONB;
