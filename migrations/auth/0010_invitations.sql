CREATE TABLE invitations (
  id            UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  token_hash    TEXT        NOT NULL UNIQUE,
  customer_id   UUID        NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  invited_email TEXT        NOT NULL,
  role_id       INTEGER     NOT NULL REFERENCES roles(id),
  invited_by    UUID        NOT NULL REFERENCES accounts(id),
  status        TEXT        NOT NULL DEFAULT 'pending'
                CHECK (status IN ('pending', 'accepted', 'expired')),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at    TIMESTAMPTZ NOT NULL DEFAULT NOW() + INTERVAL '7 days'
);

-- One pending invitation per customer+email
CREATE UNIQUE INDEX idx_invitations_pending_unique
  ON invitations (customer_id, lower(invited_email))
  WHERE status = 'pending';

CREATE INDEX idx_invitations_token_hash
  ON invitations (token_hash)
  WHERE status = 'pending';

CREATE INDEX idx_invitations_expires
  ON invitations (expires_at)
  WHERE status = 'pending';

-- Enforce general-context roles only (function defined in 0005)
CREATE TRIGGER trg_invitation_role_check
  BEFORE INSERT OR UPDATE OF role_id ON invitations
  FOR EACH ROW EXECUTE FUNCTION check_invitation_role_auth_context();

-- Analyst invitations (separate flow from customer membership invitations)
CREATE TABLE analyst_invitations (
  id           UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  email        TEXT        NOT NULL,
  customer_ids UUID[],
  invited_by   UUID        NOT NULL REFERENCES accounts(id),
  token_hash   TEXT        NOT NULL UNIQUE,
  status       TEXT        NOT NULL DEFAULT 'pending'
               CHECK (status IN ('pending', 'accepted', 'expired')),
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at   TIMESTAMPTZ NOT NULL DEFAULT NOW() + INTERVAL '7 days'
);
