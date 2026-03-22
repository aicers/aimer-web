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
