-- RFC 0002 Phase 0 (#294) — periodic-report state + per-variant jobs.
--
-- One row per `(customer_id, period, bucket_date, tz)` tracks source-
-- side readiness; per-variant work (lang/model_name/model) lives on
-- `periodic_report_job`. `tz` participates in the PK so a customer
-- timezone change creates a new row rather than mutating the existing
-- one (RFC 0002 §"Customer-level timezone"); old-tz rows are moved
-- to `status='archived'`.
--
-- LIVE rows use a synthetic `bucket_date = '1970-01-01'` (decision 4)
-- and rely on the per-variant `next_due_at` on the job row for
-- cadence. `next_due_at` lives on the job table because it is
-- per-variant — each variant ticks independently.
--
-- `dry_run` is set on Phase 0 job inserts; Phase 2 (#297) deletes
-- leftover dry-run rows in a migration before writing real ones.

-- `last_event_at` tracks the maximum source `event_time` observed
-- for events in this bucket. `last_event_received_at` tracks the
-- maximum customer-DB `baseline_event.received_at` value observed
-- for events in this bucket: it is the reconcile safety net's
-- monotone signal for "the bucket received a new event" even when
-- the new event's `event_time` is earlier than the current
-- `last_event_at` (round-7 review item 2). Without this column,
-- reconcile would skip a hook failure where a late-arriving event
-- lands inside a closed bucket but does not advance the bucket's
-- max `event_time`.
CREATE TABLE periodic_report_state (
    customer_id            UUID         NOT NULL
                           REFERENCES customers(id) ON DELETE CASCADE,
    period                 TEXT         NOT NULL
                           CHECK (period IN ('LIVE', 'DAILY', 'WEEKLY', 'MONTHLY')),
    bucket_date            DATE         NOT NULL,
    tz                     TEXT         NOT NULL,
    status                 TEXT         NOT NULL
                           CHECK (status IN ('pending', 'ready', 'dirty', 'archived')),
    created_at             TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    last_event_at          TIMESTAMPTZ,
    last_event_received_at TIMESTAMPTZ,
    cursor_watermark       TIMESTAMPTZ,
    last_ready_at          TIMESTAMPTZ,
    updated_at             TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    PRIMARY KEY (customer_id, period, bucket_date, tz)
);

CREATE INDEX periodic_report_state_status_idx
    ON periodic_report_state (status)
    WHERE status IN ('ready', 'dirty');

CREATE INDEX periodic_report_state_customer_idx
    ON periodic_report_state (customer_id);

CREATE TABLE periodic_report_job (
    customer_id           UUID         NOT NULL,
    period                TEXT         NOT NULL,
    bucket_date           DATE         NOT NULL,
    tz                    TEXT         NOT NULL,
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
    next_due_at           TIMESTAMPTZ,
    force_requested_at    TIMESTAMPTZ,
    force_requested_by    UUID,
    attempts              INT          NOT NULL DEFAULT 0,
    last_error            TEXT,
    updated_at            TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    PRIMARY KEY (customer_id, period, bucket_date, tz, lang, model_name, model),
    FOREIGN KEY (customer_id, period, bucket_date, tz)
        REFERENCES periodic_report_state(customer_id, period, bucket_date, tz)
        ON DELETE CASCADE
);

CREATE INDEX periodic_report_job_queued_idx
    ON periodic_report_job (customer_id, period, bucket_date, tz)
    WHERE status = 'queued';

CREATE INDEX periodic_report_job_dry_run_idx
    ON periodic_report_job (customer_id)
    WHERE dry_run = TRUE;

GRANT SELECT, INSERT, UPDATE, DELETE ON periodic_report_state TO aimer_auth;
GRANT SELECT, INSERT, UPDATE, DELETE ON periodic_report_job TO aimer_auth;
