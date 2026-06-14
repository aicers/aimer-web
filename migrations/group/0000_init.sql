-- group_db first-version schema (#535).
--
-- Single collapsed schema file applied to every group data DB (RFC 0004
-- / #507). aimer-web is pre-release: dev databases are reset on schema
-- changes, so this file is edited in place until the first release.
-- Post-release changes append numbered migrations starting at 0001 (see
-- migrations/README.md).
--
-- A group's dedicated data DB holds GENERATED RESULTS ONLY; it never
-- holds raw member events. That guarantee is STRUCTURAL, not a
-- convention: this file creates exactly the `subject_id`-keyed
-- periodic-report result family and nothing else.
--
-- EXPLICITLY EXCLUDED (deferred to #508, real table names):
--   * raw-event / ingestion family — detection_events, baseline_event,
--     story, story_member, policy_run, policy_event
--   * customer_id-keyed result / redaction tables —
--     event_analysis_result, story_analysis_result, event_redaction_map
-- If #508 needs group-owned story/event summary tables it adds them
-- here with the appropriate `subject_id` re-key — that re-key is #508's
-- call.

-- pgcrypto is the minimal extension dependency carried into every
-- subject data DB so the group result schema lands on the same baseline
-- as a customer DB.
CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- ---------------------------------------------------------------
-- periodic_report_result
-- ---------------------------------------------------------------
-- Column shape is identical to the customer table
-- (migrations/customer/0000_init.sql); the natural key is the group's
-- `subject_id` (== group id) — it carries no customer-id assumption.
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
    aggregate_cve_refs          JSONB            NOT NULL DEFAULT '[]',   -- RFC 0005 — dedup'd sorted union of leaf cve_refs across the bundle (the aggregate_ttp_tags analogue)
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
    -- Long-tail analyzed-event aggregates (#489 / #495), at parity with
    -- the customer result schema (`writeResultRow` names both columns
    -- unconditionally in its INSERT):
    --   * `input_exemplar_refs` — the distinct representative leaves of
    --     the kept long-tail exemplars, each `{ aice_id, event_key,
    --     generation, model_name, model }` (and, for a group, a member
    --     `customer_id`); `generation` pins the exact immutable leaf.
    --   * `input_analyzed_event_aggregates` — the exact
    --     `analyzedEventAggregates` object sent. NULL when the section
    --     was omitted (empty universe). Nullable with no default: NULL
    --     (rather than `'[]'`) is read as "no long-tail persisted".
    input_exemplar_refs             JSONB,
    input_analyzed_event_aggregates JSONB,
    PRIMARY KEY (subject_id, period, bucket_date, tz, lang, model_name, model, generation)
);

CREATE INDEX periodic_report_result_requested_at_idx
    ON periodic_report_result (requested_at DESC);

CREATE INDEX periodic_report_result_bucket_idx
    ON periodic_report_result (subject_id, period, bucket_date, tz);

-- GIN indexes for the reverse-citation lookup (mirror the customer
-- schema); jsonb_path_ops is the operator class tuned for the `@>`
-- containment queries the Sources panel issues against these columns.
CREATE INDEX periodic_report_result_input_event_refs_gin
    ON periodic_report_result
    USING GIN (input_event_refs jsonb_path_ops);

CREATE INDEX periodic_report_result_input_story_refs_gin
    ON periodic_report_result
    USING GIN (input_story_refs jsonb_path_ops);

-- ===================================================================
-- Runtime-role grants
-- ===================================================================
-- The runtime role reuses the shared subject-DB runtime role
-- `aimer_customer` (see provision-group.ts for the role/env decision);
-- the grants mirror the customer result-table grants.
GRANT SELECT, INSERT, UPDATE, DELETE ON periodic_report_result TO aimer_customer;
