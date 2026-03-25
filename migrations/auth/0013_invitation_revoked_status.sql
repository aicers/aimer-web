-- Add 'revoked' as a valid invitation status for soft-delete revocation (#83).
-- The check constraint is replaced (not altered) because PostgreSQL does not
-- support ADD VALUE on plain CHECK constraints.

ALTER TABLE invitations
  DROP CONSTRAINT invitations_status_check,
  ADD CONSTRAINT invitations_status_check
    CHECK (status IN ('pending', 'accepted', 'expired', 'revoked'));
