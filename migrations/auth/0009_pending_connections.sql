CREATE TABLE pending_connections (
  connection_id UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  jti           TEXT        NOT NULL UNIQUE,
  issuer        TEXT        NOT NULL,
  aice_id       TEXT        NOT NULL,
  customer_ids  TEXT[]      NOT NULL,
  sub           TEXT,
  status        TEXT        NOT NULL DEFAULT 'pending'
                CHECK (status IN ('pending', 'consumed', 'denied', 'expired')),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at    TIMESTAMPTZ NOT NULL
);

CREATE INDEX idx_pending_connections_expires
  ON pending_connections (expires_at)
  WHERE status = 'pending';
