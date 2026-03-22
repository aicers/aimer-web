CREATE TABLE sessions (
  sid                 UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id          UUID        NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  auth_context        TEXT        NOT NULL DEFAULT 'general'
                      CHECK (auth_context IN ('general', 'admin')),
  bridge_aice_id      TEXT,
  bridge_customer_ids UUID[],
  ip_address          TEXT        NOT NULL,
  user_agent          TEXT        NOT NULL,
  browser_fingerprint TEXT        NOT NULL DEFAULT '',
  needs_reauth        BOOLEAN     NOT NULL DEFAULT false,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_active_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  revoked             BOOLEAN     NOT NULL DEFAULT false,

  -- Admin sessions cannot have bridge context
  CHECK (auth_context != 'admin'
         OR (bridge_aice_id IS NULL AND bridge_customer_ids IS NULL)),

  -- Bridge fields must be both NULL or both NOT NULL
  CHECK (
    (bridge_aice_id IS NULL AND bridge_customer_ids IS NULL)
    OR (bridge_aice_id IS NOT NULL AND bridge_customer_ids IS NOT NULL)
  )
);

CREATE INDEX idx_sessions_account_id ON sessions (account_id);
