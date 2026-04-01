-- Suspicious activity alerts detected from audit log analysis.
-- Immutable records: INSERT/SELECT only for the runtime role,
-- matching the tamper-resistance model of audit_logs.

CREATE TABLE suspicious_activity_alerts (
  id             BIGSERIAL   PRIMARY KEY,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  indicator      TEXT        NOT NULL,
  severity       TEXT        NOT NULL CHECK (severity IN ('severe', 'warning')),
  actor_id       TEXT,
  ip_address     TEXT,
  summary        JSONB       NOT NULL,
  audit_log_ids  BIGINT[]    NOT NULL DEFAULT '{}',
  correlation_id UUID
);

CREATE INDEX idx_alerts_created_at ON suspicious_activity_alerts (created_at);
CREATE INDEX idx_alerts_indicator  ON suspicious_activity_alerts (indicator);
CREATE INDEX idx_alerts_severity   ON suspicious_activity_alerts (severity);
CREATE INDEX idx_alerts_actor_id   ON suspicious_activity_alerts (actor_id)
  WHERE actor_id IS NOT NULL;

-- Owner: full access (inherits from schema-level ALL grant in 0001)
-- Runtime: INSERT/SELECT only
GRANT SELECT, INSERT ON suspicious_activity_alerts TO aimer_audit;
GRANT USAGE, SELECT ON SEQUENCE suspicious_activity_alerts_id_seq TO aimer_audit;
