-- Retroactive re-redact worker support (issue #253).
--
-- The original cursor design in 0021 (last_processed_aice_id /
-- last_processed_event_key) cannot uniquely identify rows in tables
-- whose PK exceeds (aice_id, event_key) — baseline_event (per
-- baseline_version), story_member (per story_version), policy_event
-- (per run_id), and event_analysis_result (per lang/model variants).
-- Resume by (aice_id, event_key) would skip later rows sharing the
-- resolved key with the last-processed row. The materialized
-- candidate-items table sidesteps this by ordering processing on a
-- monotonic seq, independent of any natural key collision.
--
-- The cursor columns on redaction_jobs are left intact in this PR
-- (no-op writes) to avoid an irreversible drop on a merged schema;
-- a follow-up cleanup issue removes them once the worker has lived
-- in production for one release.

CREATE TABLE redaction_job_items (
  job_id             UUID           NOT NULL REFERENCES redaction_jobs(id) ON DELETE CASCADE,
  seq                BIGINT         NOT NULL,
  source_table       TEXT           NOT NULL
                     CHECK (source_table IN (
                       'detection_events','baseline_event','story_member',
                       'policy_event','event_analysis_result'
                     )),
  primary_key        JSONB          NOT NULL,
  resolved_aice_id   TEXT           NOT NULL,
  resolved_event_key NUMERIC(39, 0) NOT NULL,
  status             TEXT           NOT NULL DEFAULT 'pending'
                     CHECK (status IN ('pending','done','failed','skipped')),
  error_code         TEXT,
  processed_at       TIMESTAMPTZ,
  PRIMARY KEY (job_id, seq)
);

CREATE INDEX redaction_job_items_pending_idx
  ON redaction_job_items (job_id, seq)
  WHERE status = 'pending';

GRANT SELECT, INSERT, UPDATE, DELETE ON redaction_job_items TO aimer_auth;

-- range_snapshot is the durable copy of the customer's redaction
-- ranges (engine semver + sorted normalised CIDR list) frozen at the
-- moment the worker flips a job queued -> running. Required so that a
-- worker restart against a `running` job can reconstruct the exact
-- range set that was frozen at start — target_policy_version only
-- carries a one-way 12-hex SHA-256 short of the cidrs.
--
-- range_snapshot_ranges_hash stores just the 12-hex SHA-256 short
-- value (e.g. "a1b2c3d4e5f6"), not the "ranges:a1b2c3d4e5f6" form that
-- appears in target_policy_version. Recovery cross-checks the
-- recomputed hash against both the stored column AND
-- target_policy_version.split('|ranges:')[1], so independent tampering
-- of either field is caught.
--
-- running_started_at distinguishes the queue time (started_at, set on
-- INSERT) from the actual worker pickup time. duration_ms in the
-- retroactive_completed audit is completed_at - running_started_at.
--
-- cancelled_by / cancellation_reason capture the DELETE caller's
-- account_id and an optional free-text reason for the audit detail.
ALTER TABLE redaction_jobs
  ADD COLUMN running_started_at        TIMESTAMPTZ,
  ADD COLUMN cancelled_by              UUID,
  ADD COLUMN cancellation_reason       TEXT,
  ADD COLUMN range_snapshot            JSONB,
  ADD COLUMN range_snapshot_ranges_hash TEXT;
