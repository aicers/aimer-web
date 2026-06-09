-- RFC 0002 amendment (#489 / #495) — long-tail analyzed-event aggregates.
--
-- The periodic report now folds the larger non-story-covered
-- analyzed-in-window universe into the prompt as `analyzedEventAggregates`
-- (counts, technique leaderboard, tier distribution, uncited rollup) plus a
-- handful of technique-clustered long-tail exemplars. Two new columns on
-- `periodic_report_result` persist what the English native generation sent so
-- the non-English paths reproduce it without recomputing a universe that may
-- have drifted:
--
--   * `input_exemplar_refs` — the distinct representative leaves of the kept
--     exemplars, each `{ aice_id, event_key, generation, model_name, model }`.
--     `generation` pins the exact immutable leaf so replay/restore re-resolves
--     the exemplar `<<REDACTED_*_R{j}_*>>` token to the same plaintext (mirrors
--     `input_event_refs`). Replayed at the English canonical language.
--   * `input_analyzed_event_aggregates` — the exact `analyzedEventAggregates`
--     object sent (counts / rollups / tier distribution / exemplars). The
--     native-pinned non-English path reuses it verbatim; the translation path
--     copies it onto its own row for parity. NULL when the section was omitted
--     (empty universe), keeping `computeInputHash` byte-identical to pre-change.
--
-- Both are nullable with no default: under the pre-release dev-DB reset policy
-- no backfill is needed, and a NULL (rather than a `'[]'` default) on a legacy
-- row is read as "no long-tail persisted". Forward-only; never edit an applied
-- migration (checksum-guarded — migrations/README.md).

ALTER TABLE periodic_report_result
    ADD COLUMN input_exemplar_refs              JSONB,
    ADD COLUMN input_analyzed_event_aggregates  JSONB;
