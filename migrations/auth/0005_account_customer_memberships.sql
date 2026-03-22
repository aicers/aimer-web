CREATE TABLE account_customer_memberships (
  account_id  UUID    NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  customer_id UUID    NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  role_id     INTEGER NOT NULL REFERENCES roles(id),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (account_id, customer_id)
);

-- Enforce that role_id references only general-context roles.
-- Admin role in a membership would project admin permissions into the
-- general JWT, breaking auth context separation.
CREATE OR REPLACE FUNCTION check_membership_role_auth_context()
RETURNS TRIGGER AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM roles WHERE id = NEW.role_id AND auth_context = 'general'
  ) THEN
    RAISE EXCEPTION 'account_customer_memberships.role_id must reference a role with auth_context=general';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_membership_role_check
  BEFORE INSERT OR UPDATE OF role_id ON account_customer_memberships
  FOR EACH ROW EXECUTE FUNCTION check_membership_role_auth_context();

-- Trigger function for invitations (defined here, trigger created in 0010).
CREATE OR REPLACE FUNCTION check_invitation_role_auth_context()
RETURNS TRIGGER AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM roles WHERE id = NEW.role_id AND auth_context = 'general'
  ) THEN
    RAISE EXCEPTION 'invitations.role_id must reference a role with auth_context=general';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Guard against auth_context bypass: prevent changing a role to 'admin'
-- when existing memberships or invitations reference it. Without this,
-- an attacker could create a general membership and then flip the role
-- to admin, projecting admin permissions into the general JWT.
CREATE OR REPLACE FUNCTION check_roles_auth_context_change()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW.auth_context = 'admin' AND OLD.auth_context = 'general' THEN
    IF EXISTS (
      SELECT 1 FROM account_customer_memberships WHERE role_id = NEW.id
    ) THEN
      RAISE EXCEPTION 'Cannot change auth_context to admin: role is referenced by account_customer_memberships';
    END IF;
    -- invitations table does not exist yet at this point in the migration
    -- sequence, so the check is deferred to 0010_invitations.sql where
    -- we replace this function with a version that checks both tables.
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_roles_auth_context_guard
  BEFORE UPDATE OF auth_context ON roles
  FOR EACH ROW EXECUTE FUNCTION check_roles_auth_context_change();
