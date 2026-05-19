-- Permission seeds for redaction-range and retention administration
-- (RFC 0001 §"Permissions" sub-sections under both surfaces).
--
-- The existing seed in 0003_roles.sql grants `customer-settings:*`
-- to Manager only. Read access on these two surfaces must extend to
-- User and Analyst as well, which is why dedicated keys are
-- introduced instead of reusing `customer-settings:*`.
--
-- System Administrator's role row has auth_context = 'admin' and
-- therefore routes through authorizeAdmin without a customer
-- membership check. General-context Manager/User/Analyst routes
-- will not match the System Administrator grant — the grant is
-- seeded here so a future admin-context management surface can rely
-- on the same permission keys without another seed migration.

INSERT INTO role_permissions (role_id, permission)
SELECT r.id, p.permission
FROM roles r,
LATERAL (VALUES
  ('customer-redaction-ranges:read'),
  ('customer-retention:read')
) AS p(permission)
WHERE r.name IN ('User', 'Analyst', 'Manager', 'System Administrator');

INSERT INTO role_permissions (role_id, permission)
SELECT r.id, p.permission
FROM roles r,
LATERAL (VALUES
  ('customer-redaction-ranges:write'),
  ('customer-retention:write')
) AS p(permission)
WHERE r.name IN ('Manager', 'System Administrator');
