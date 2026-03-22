CREATE TABLE trust_registry (
  id          SERIAL      PRIMARY KEY,
  aice_id     TEXT        NOT NULL REFERENCES aice_environments(aice_id),
  issuer      TEXT        NOT NULL,
  kid         TEXT        NOT NULL,
  public_key  JSONB       NOT NULL,
  description TEXT,
  enabled     BOOLEAN     NOT NULL DEFAULT true,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (aice_id, issuer, kid)
);
