CREATE TABLE aice_environments (
  id          SERIAL      PRIMARY KEY,
  aice_id     TEXT        NOT NULL UNIQUE,
  name        TEXT        NOT NULL,
  description TEXT,
  status      TEXT        NOT NULL DEFAULT 'active'
              CHECK (status IN ('active', 'suspended', 'disabled')),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
