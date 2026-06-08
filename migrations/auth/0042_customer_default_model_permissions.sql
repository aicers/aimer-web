-- Permission seeds for per-customer default-analysis-model
-- administration (#473).
--
-- Unlike the redaction-range / retention / owned-domain surfaces
-- (0022, 0040), whose read access extends to User and Manager, the
-- per-customer default model is an analyst-facing control. The #473
-- permission matrix is:
--
--   per-customer override change → System Administrator (any customer)
--                                  + Analyst (assigned customers only)
--   Manager and User             → denied
--
-- So `customer-default-model:read` / `:write` are seeded ONLY to
-- Analyst and System Administrator. Manager/User receive neither key
-- and therefore cannot view or change the per-customer default.
--
-- System Administrator's role row has auth_context = 'admin' and routes
-- through authorizeAdmin without a customer membership check; Analyst's
-- grant flows through the general-context analyst-assignment union in
-- authorizeGeneral. The SAME permission key works in both contexts, so
-- the admin route (ctx 'admin') and the customer route (ctx 'general')
-- can call the same underlying guard / service.
--
-- The admin-set GLOBAL default lives in `system_settings` under key
-- `analysis_default_model` and reuses the existing
-- `system-settings:read` / `system-settings:write` keys (System
-- Administrator only) — no new key is seeded for it here.

INSERT INTO role_permissions (role_id, permission)
SELECT r.id, p.permission
FROM roles r,
LATERAL (VALUES
  ('customer-default-model:read'),
  ('customer-default-model:write')
) AS p(permission)
WHERE r.name IN ('Analyst', 'System Administrator');
