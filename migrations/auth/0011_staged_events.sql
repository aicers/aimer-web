CREATE TABLE staged_event_payloads (
  id             UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  connection_id  UUID        REFERENCES pending_connections(connection_id),
  session_id     UUID        REFERENCES sessions(sid),
  aice_id        TEXT        NOT NULL,
  payload_hash   TEXT        NOT NULL,
  payload        BYTEA       NOT NULL,
  event_count    INTEGER     NOT NULL,
  schema_version TEXT        NOT NULL,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at     TIMESTAMPTZ NOT NULL
);

CREATE TABLE staged_event_customers (
  id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  payload_id  UUID        NOT NULL REFERENCES staged_event_payloads(id) ON DELETE CASCADE,
  customer_id UUID        NOT NULL REFERENCES customers(id),
  status      TEXT        NOT NULL DEFAULT 'pending'
              CHECK (status IN ('pending', 'approved', 'rejected', 'expired')),
  approved_at TIMESTAMPTZ,
  UNIQUE (payload_id, customer_id)
);

CREATE INDEX idx_staged_event_payloads_session
  ON staged_event_payloads (session_id);

CREATE INDEX idx_staged_event_payloads_expires
  ON staged_event_payloads (expires_at);

CREATE INDEX idx_staged_event_customers_status
  ON staged_event_customers (payload_id)
  WHERE status = 'pending';
