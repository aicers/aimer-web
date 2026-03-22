CREATE TABLE accounts (
  id               UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  oidc_issuer      TEXT        NOT NULL,
  oidc_subject     TEXT        NOT NULL,
  username         TEXT        NOT NULL,
  display_name     TEXT        NOT NULL,
  email            TEXT,
  analyst_eligible BOOLEAN     NOT NULL DEFAULT false,
  admin_eligible   BOOLEAN     NOT NULL DEFAULT false,
  status           TEXT        NOT NULL DEFAULT 'active'
                   CHECK (status IN ('active', 'suspended', 'disabled')),
  token_version    INTEGER     NOT NULL DEFAULT 0,
  locale           TEXT,
  timezone         TEXT,
  last_sign_in_at  TIMESTAMPTZ,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (oidc_issuer, oidc_subject)
);
