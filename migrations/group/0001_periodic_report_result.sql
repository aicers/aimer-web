-- RFC 0004 (#507) — group results-only schema, v1.
--
-- A group's dedicated data DB holds GENERATED RESULTS ONLY; it never
-- holds raw member events. That guarantee is STRUCTURAL, not a
-- convention: this curated migration set creates exactly the
-- `subject_id`-keyed periodic-report result family and nothing else.
--
-- v1 is `periodic_report_result` only. It was re-keyed from `customer_id`
-- to `subject_id` in migrations/customer/0015 (RFC 0004 / #503), so for a
-- group the natural key is the group's `subject_id` (== group id) — it
-- carries no customer-id assumption and drops into a group DB unchanged.
-- The column shape is identical to the customer table (post-rekey); only
-- the key column name differs (`subject_id`).
--
-- EXPLICITLY EXCLUDED from v1 (deferred to #508, real table names):
--   * raw-event / ingestion family — detection_events, baseline_event,
--     story, story_member, policy_run, policy_event
--   * customer_id-keyed result / redaction tables — event_analysis_result,
--     story_analysis_result, event_redaction_map
-- If #508 needs group-owned story/event summary tables it adds them here
-- with the appropriate `subject_id` re-key — that re-key is #508's call.
--
-- The runtime role reuses the shared subject-DB runtime role
-- `aimer_customer` (see provision-group.ts for the role/env decision);
-- grants below mirror migrations/customer/0007.

CREATE TABLE periodic_report_result (
    subject_id                  UUID             NOT NULL,
    period                      TEXT             NOT NULL,
    bucket_date                 DATE             NOT NULL,
    tz                          TEXT             NOT NULL,
    lang                        TEXT             NOT NULL,
    -- Language whose cited leaves the page loader replays to restore the
    -- report-scope <<REDACTED_*_R{j}_*>> tokens to plaintext. NULL means
    -- "replay leaves at this row's own `lang`" (the native path). A
    -- translated row pins it to the English canonical's language because
    -- it copies the canonical's input_*_refs verbatim and the cited
    -- leaves only exist under that language (#389 PR #3 / #412).
    restoration_lang            TEXT,
    model_name                  TEXT             NOT NULL,
    model                       TEXT             NOT NULL,
    model_actual_version        TEXT             NOT NULL,
    prompt_version              TEXT             NOT NULL,
    generation                  INT              NOT NULL,
    aggregate_severity_score    DOUBLE PRECISION NOT NULL,
    aggregate_likelihood_score  DOUBLE PRECISION NOT NULL,
    aggregate_ttp_tags          JSONB            NOT NULL DEFAULT '[]',
    priority_tier               TEXT             NOT NULL
        CHECK (priority_tier IN ('CRITICAL', 'HIGH', 'MEDIUM', 'LOW')),
    sections_jsonb              JSONB            NOT NULL,
    input_event_refs            JSONB            NOT NULL,
    input_story_refs            JSONB            NOT NULL,
    input_hash                  TEXT             NOT NULL,
    input_watermark             TIMESTAMPTZ,
    redaction_policy_version    TEXT             NOT NULL,
    requested_by                UUID,
    requested_at                TIMESTAMPTZ      NOT NULL DEFAULT NOW(),
    superseded_at               TIMESTAMPTZ,
    PRIMARY KEY (subject_id, period, bucket_date, tz, lang, model_name, model, generation)
);

CREATE INDEX periodic_report_result_requested_at_idx
    ON periodic_report_result (requested_at DESC);

CREATE INDEX periodic_report_result_bucket_idx
    ON periodic_report_result (subject_id, period, bucket_date, tz);

-- GIN indexes for the reverse-citation lookup (mirror customer 0009);
-- jsonb_path_ops is the operator class tuned for the `@>` containment
-- queries the Sources panel issues against these ref columns.
CREATE INDEX periodic_report_result_input_event_refs_gin
    ON periodic_report_result
    USING GIN (input_event_refs jsonb_path_ops);

CREATE INDEX periodic_report_result_input_story_refs_gin
    ON periodic_report_result
    USING GIN (input_story_refs jsonb_path_ops);

GRANT SELECT, INSERT, UPDATE, DELETE ON periodic_report_result TO aimer_customer;
