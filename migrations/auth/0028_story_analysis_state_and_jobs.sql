-- RFC 0002 Phase 0 (#294) — story analysis state + per-variant jobs.
--
-- Source-side readiness lives on `story_analysis_state` (one row per
-- `(customer_id, story_id)`). Per-variant work (lang/model_name/model)
-- lives on `story_analysis_job` — RFC 0002 §"Data model additions".
--
-- The Phase 0 worker writes job rows with `dry_run=TRUE` instead of
-- calling the LLM (see issue #294, decision 3). The `dry_run` column
-- is added here so Phase 1 (#296) only needs to delete leftover
-- dry-run rows and start writing `dry_run=FALSE` rows — no schema
-- change at the phase boundary.
--
-- `status='archived'` (decision 1) terminates the lifecycle when every
-- `story_version` of a `story_id` has been deleted from the customer
-- DB; unarchive-in-place is allowed if the same `story_id` re-appears
-- via a later window-replace.

CREATE TABLE story_analysis_state (
    customer_id      UUID         NOT NULL
                     REFERENCES customers(id) ON DELETE CASCADE,
    story_id         BIGINT       NOT NULL,
    status           TEXT         NOT NULL
                     CHECK (status IN ('pending', 'ready', 'dirty', 'archived')),
    created_at       TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    first_member_at  TIMESTAMPTZ,
    last_member_at   TIMESTAMPTZ,
    last_ready_at    TIMESTAMPTZ,
    updated_at       TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    PRIMARY KEY (customer_id, story_id)
);

CREATE INDEX story_analysis_state_status_idx
    ON story_analysis_state (status)
    WHERE status IN ('ready', 'dirty');

CREATE INDEX story_analysis_state_customer_idx
    ON story_analysis_state (customer_id);

CREATE TABLE story_analysis_job (
    customer_id           UUID         NOT NULL,
    story_id              BIGINT       NOT NULL,
    lang                  TEXT         NOT NULL,
    model_name            TEXT         NOT NULL,
    model                 TEXT         NOT NULL,
    status                TEXT         NOT NULL
                          CHECK (status IN ('queued', 'processing', 'done', 'failed')),
    generation            INT          NOT NULL DEFAULT 1,
    dry_run               BOOLEAN      NOT NULL DEFAULT FALSE,
    created_at            TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    processing_started_at TIMESTAMPTZ,
    last_generated_at     TIMESTAMPTZ,
    force_requested_at    TIMESTAMPTZ,
    force_requested_by    UUID,
    attempts              INT          NOT NULL DEFAULT 0,
    last_error            TEXT,
    updated_at            TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    PRIMARY KEY (customer_id, story_id, lang, model_name, model),
    FOREIGN KEY (customer_id, story_id)
        REFERENCES story_analysis_state(customer_id, story_id)
        ON DELETE CASCADE
);

CREATE INDEX story_analysis_job_queued_idx
    ON story_analysis_job (customer_id, story_id)
    WHERE status = 'queued';

CREATE INDEX story_analysis_job_dry_run_idx
    ON story_analysis_job (customer_id)
    WHERE dry_run = TRUE;

GRANT SELECT, INSERT, UPDATE, DELETE ON story_analysis_state TO aimer_auth;
GRANT SELECT, INSERT, UPDATE, DELETE ON story_analysis_job TO aimer_auth;
