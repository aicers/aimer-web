-- Add 'revoked' as a valid invitation status for soft-delete revocation.
-- Preserves audit trail: who invited whom and when (#83).

ALTER TABLE invitations
  DROP CONSTRAINT invitations_status_check,
  ADD  CONSTRAINT invitations_status_check
       CHECK (status IN ('pending', 'accepted', 'expired', 'revoked'));
