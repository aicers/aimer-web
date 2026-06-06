-- RFC 0002 Phase 0 (#294) — analysis result storage (customer DB).
--
-- Phase 0 lands the result tables with their full round-10 + round-11
-- column shapes so Phase 1 (#296) and Phase 2 (#297) only need to
-- populate them — no later schema rewrite. The Phase 0 worker writes
-- nothing here: it only persists dry-run job rows in the auth DB to
-- exercise state transitions.
--
-- See RFC 0002 §"Data model additions" for the column shapes,
-- §"Priority tiering" for the matrix-derivation of `priority_tier`,
-- §"Score factor articulation" for the factor columns, and §"MITRE
-- ATT&CK TTP tagging" for the tag columns.

CREATE TABLE story_analysis_result (
    customer_id              UUID             NOT NULL,
    story_id                 BIGINT           NOT NULL,
    lang                     TEXT             NOT NULL,
    model_name               TEXT             NOT NULL,
    model                    TEXT             NOT NULL,
    model_actual_version     TEXT             NOT NULL,
    prompt_version           TEXT             NOT NULL,
    generation               INT              NOT NULL,
    severity_score           DOUBLE PRECISION NOT NULL,
    likelihood_score         DOUBLE PRECISION NOT NULL,
    severity_factors         JSONB            NOT NULL DEFAULT '[]',
    likelihood_factors       JSONB            NOT NULL DEFAULT '[]',
    ttp_tags                 JSONB            NOT NULL DEFAULT '[]',
    priority_tier            TEXT             NOT NULL
        CHECK (priority_tier IN ('CRITICAL', 'HIGH', 'MEDIUM', 'LOW')),
    analysis_text            TEXT             NOT NULL,
    input_event_refs         JSONB            NOT NULL,
    -- RFC 0003 C1 (#440) — ordered `k -> fact_id` mapping for the
    -- `<<REDACTED_*_F{k}_*>>` fact-scope tokens carried by the redacted
    -- `enrichmentFacts` sent to aimer. Parallel to `input_event_refs`:
    -- the renderer reads it to resolve each `F{k}` back to its
    -- `story_enrichment_fact` row (and that fact's `enrichment_redaction_map`).
    -- Written for every result row alongside `input_event_refs` (`[]` when
    -- the story carried no enrichment facts); no compat default, so an
    -- omitted write fails loudly rather than silently producing a row that
    -- cannot demap `F{k}` tokens (pre-release stance, parallel to
    -- `input_event_refs`).
    input_fact_refs          JSONB            NOT NULL,
    input_hash               TEXT             NOT NULL,
    redaction_policy_version TEXT             NOT NULL,
    requested_by             UUID,
    requested_at             TIMESTAMPTZ      NOT NULL DEFAULT NOW(),
    superseded_at            TIMESTAMPTZ,
    PRIMARY KEY (customer_id, story_id, lang, model_name, model, generation)
);

CREATE INDEX story_analysis_result_requested_at_idx
    ON story_analysis_result (requested_at DESC);

CREATE INDEX story_analysis_result_story_idx
    ON story_analysis_result (customer_id, story_id);

CREATE TABLE periodic_report_result (
    customer_id                 UUID             NOT NULL,
    period                      TEXT             NOT NULL,
    bucket_date                 DATE             NOT NULL,
    tz                          TEXT             NOT NULL,
    lang                        TEXT             NOT NULL,
    -- Language whose cited leaves the page loader replays to restore the
    -- report-scope `<<REDACTED_*_R{j}_*>>` tokens to plaintext. NULL means
    -- "replay leaves at this row's own `lang`" (the native path). A
    -- translated row pins it to the English canonical's language (e.g.
    -- ENGLISH) because it copies the canonical's `input_*_refs` verbatim and
    -- the cited leaves only exist under that language (#389 PR #3 / #412).
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
    PRIMARY KEY (customer_id, period, bucket_date, tz, lang, model_name, model, generation)
);

CREATE INDEX periodic_report_result_requested_at_idx
    ON periodic_report_result (requested_at DESC);

CREATE INDEX periodic_report_result_bucket_idx
    ON periodic_report_result (customer_id, period, bucket_date, tz);

GRANT SELECT, INSERT, UPDATE, DELETE ON story_analysis_result TO aimer_customer;
GRANT SELECT, INSERT, UPDATE, DELETE ON periodic_report_result TO aimer_customer;
