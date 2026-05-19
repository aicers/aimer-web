-- Retroactive re-redact job state (RFC 0001 §"redaction_jobs schema").
--
-- The worker implementation lands in #253; this PR ships only the
-- table so the schema is in place before downstream sub-issues
-- reference it.

CREATE TABLE redaction_jobs (
  id                          UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id                 UUID         NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  status                      TEXT         NOT NULL
                              CHECK (status IN ('queued', 'running', 'completed', 'failed', 'cancelled')),
  target_policy_version       TEXT         NOT NULL,
  total_rows                  BIGINT,
  processed_rows              BIGINT       NOT NULL DEFAULT 0,
  failed_rows                 BIGINT       NOT NULL DEFAULT 0,
  last_processed_aice_id      TEXT,
  last_processed_event_key    NUMERIC(39, 0),
  last_progress_at            TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  started_at                  TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  completed_at                TIMESTAMPTZ,
  error_message               TEXT,
  triggered_by                UUID         NOT NULL
);

-- At most one active job per customer; re-clicking the button in #252
-- must return the existing one rather than queue a duplicate.
CREATE UNIQUE INDEX redaction_jobs_one_active_per_customer
  ON redaction_jobs (customer_id)
  WHERE status IN ('queued', 'running');

CREATE INDEX redaction_jobs_customer_id_idx
  ON redaction_jobs (customer_id);

GRANT SELECT, INSERT, UPDATE, DELETE ON redaction_jobs TO aimer_auth;
