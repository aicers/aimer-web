-- Permission seeds for customer owned-domain administration (RFC 0001
-- Amendment A.2). Parallel to the redaction-range seeds in
-- 0022_redaction_permissions.sql: read access extends to User /
-- Analyst / Manager / System Administrator, write access to Manager /
-- System Administrator.
--
-- A dedicated key (`customer-owned-domains:*`) is introduced rather
-- than reusing `customer-settings:*` for the same reason 0022 did:
-- read access must reach User and Analyst, which the Manager-only
-- `customer-settings:*` grant does not. Seeded as a NEW migration
-- (not an edit to the already-applied 0022) so migration history stays
-- append-only and deterministic for AgentCoop.
--
-- System Administrator's role row has auth_context = 'admin' and
-- therefore routes through authorizeAdmin without a customer
-- membership check. The grant is seeded here so a future admin-context
-- management surface can rely on the same permission keys without
-- another seed migration.

INSERT INTO role_permissions (role_id, permission)
SELECT r.id, p.permission
FROM roles r,
LATERAL (VALUES
  ('customer-owned-domains:read')
) AS p(permission)
WHERE r.name IN ('User', 'Analyst', 'Manager', 'System Administrator');

INSERT INTO role_permissions (role_id, permission)
SELECT r.id, p.permission
FROM roles r,
LATERAL (VALUES
  ('customer-owned-domains:write')
) AS p(permission)
WHERE r.name IN ('Manager', 'System Administrator');
