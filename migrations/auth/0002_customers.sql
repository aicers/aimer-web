CREATE TABLE customers (
  id              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  external_key    TEXT        NOT NULL UNIQUE,
  name            TEXT        NOT NULL,
  description     TEXT,
  status          TEXT        NOT NULL DEFAULT 'active'
                  CHECK (status IN ('active', 'suspended', 'disabled')),
  database_status TEXT        NOT NULL DEFAULT 'provisioning'
                  CHECK (database_status IN ('provisioning', 'active', 'failed')),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
