-- audit_db first-version schema (#535).
--
-- Single collapsed schema file for the shared audit database. aimer-web
-- is pre-release: dev databases are reset on schema changes, so this
-- file is edited in place until the first release. Post-release changes
-- append numbered migrations starting at 0001 (see migrations/README.md).
--
-- Role creation is handled by infra/postgres/init-databases.sql (Docker
-- entrypoint); this file only assigns grants. The runtime role
-- (aimer_audit) is INSERT/SELECT only — no UPDATE/DELETE — for tamper
-- resistance.

-- ---------------------------------------------------------------
-- audit_logs
-- ---------------------------------------------------------------
CREATE TABLE audit_logs (
  id             BIGSERIAL   PRIMARY KEY,
  timestamp      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  actor_id       TEXT        NOT NULL,
  auth_context   TEXT        CHECK (auth_context IN ('general', 'admin')),
  action         TEXT        NOT NULL,
  target_type    TEXT        NOT NULL,
  target_id      TEXT,
  details        JSONB,
  ip_address     TEXT,
  sid            UUID,
  customer_id    UUID,
  aice_id        TEXT,
  correlation_id UUID
);

CREATE INDEX idx_audit_logs_timestamp      ON audit_logs (timestamp);
CREATE INDEX idx_audit_logs_actor_id       ON audit_logs (actor_id);
CREATE INDEX idx_audit_logs_action         ON audit_logs (action);
CREATE INDEX idx_audit_logs_customer_id    ON audit_logs (customer_id)    WHERE customer_id IS NOT NULL;
CREATE INDEX idx_audit_logs_aice_id        ON audit_logs (aice_id)        WHERE aice_id IS NOT NULL;
CREATE INDEX idx_audit_logs_auth_context   ON audit_logs (auth_context)   WHERE auth_context IS NOT NULL;
CREATE INDEX idx_audit_logs_sid            ON audit_logs (sid)            WHERE sid IS NOT NULL;
CREATE INDEX idx_audit_logs_correlation_id ON audit_logs (correlation_id) WHERE correlation_id IS NOT NULL;

-- Owner: full access for migrations and anonymization. Deliberately
-- placed BEFORE suspicious_activity_alerts is created: the blanket
-- grants cover only `_migrations` (created by the runner) and
-- `audit_logs`, matching the historical grant state — later tables are
-- created by the owner itself, whose privileges are implicit.
GRANT ALL ON ALL TABLES IN SCHEMA public TO aimer_audit_owner;
GRANT ALL ON ALL SEQUENCES IN SCHEMA public TO aimer_audit_owner;

-- Runtime: INSERT/SELECT only (no UPDATE/DELETE — tamper resistance)
GRANT SELECT, INSERT ON audit_logs TO aimer_audit;
GRANT USAGE, SELECT ON SEQUENCE audit_logs_id_seq TO aimer_audit;

-- ---------------------------------------------------------------
-- suspicious_activity_alerts
-- ---------------------------------------------------------------
-- Suspicious activity alerts detected from audit log analysis.
-- Immutable records: INSERT/SELECT only for the runtime role, matching
-- the tamper-resistance model of audit_logs.
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

GRANT SELECT, INSERT ON suspicious_activity_alerts TO aimer_audit;
GRANT USAGE, SELECT ON SEQUENCE suspicious_activity_alerts_id_seq TO aimer_audit;
