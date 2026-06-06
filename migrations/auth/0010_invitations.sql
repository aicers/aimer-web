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

-- Now that the invitations table exists, replace the auth_context guard
-- function to also check invitations when a role changes to admin.
CREATE OR REPLACE FUNCTION check_roles_auth_context_change()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW.auth_context = 'admin' AND OLD.auth_context = 'general' THEN
    IF EXISTS (
      SELECT 1 FROM account_customer_memberships WHERE role_id = NEW.id
    ) THEN
      RAISE EXCEPTION 'Cannot change auth_context to admin: role is referenced by account_customer_memberships';
    END IF;
    IF EXISTS (
      SELECT 1 FROM invitations WHERE role_id = NEW.id
    ) THEN
      RAISE EXCEPTION 'Cannot change auth_context to admin: role is referenced by invitations';
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Analyst invitations (separate flow from customer membership invitations).
-- Kept at parity with the final state of `invitations` (incl. the 'revoked'
-- status that `invitations` itself only gains in 0013). Unlike member
-- invitations, analyst invitations are not per-customer: an empty
-- customer_ids array ('{}') is valid for an as-yet-unassigned analyst, and
-- the pending-uniqueness key is the email alone.
CREATE TABLE analyst_invitations (
  id           UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  email        TEXT        NOT NULL,
  customer_ids UUID[]      NOT NULL,
  invited_by   UUID        NOT NULL REFERENCES accounts(id),
  token_hash   TEXT        NOT NULL UNIQUE,
  status       TEXT        NOT NULL DEFAULT 'pending'
               CHECK (status IN ('pending', 'accepted', 'expired', 'revoked')),
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at   TIMESTAMPTZ NOT NULL DEFAULT NOW() + INTERVAL '7 days'
);

-- One pending analyst invitation per email (not per customer+email)
CREATE UNIQUE INDEX idx_analyst_invitations_pending_unique
  ON analyst_invitations (lower(email))
  WHERE status = 'pending';

-- token_hash is already NOT NULL UNIQUE; this partial index is redundant
-- but kept for parity with `invitations`' idx_invitations_token_hash.
CREATE INDEX idx_analyst_invitations_token_hash
  ON analyst_invitations (token_hash)
  WHERE status = 'pending';

CREATE INDEX idx_analyst_invitations_expires
  ON analyst_invitations (expires_at)
  WHERE status = 'pending';
