CREATE TABLE roles (
  id           SERIAL      PRIMARY KEY,
  name         TEXT        NOT NULL UNIQUE,
  auth_context TEXT        NOT NULL CHECK (auth_context IN ('general', 'admin')),
  description  TEXT,
  is_builtin   BOOLEAN     NOT NULL DEFAULT false,
  mfa_required BOOLEAN     NOT NULL DEFAULT false,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE role_permissions (
  role_id    INTEGER NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
  permission TEXT    NOT NULL,
  PRIMARY KEY (role_id, permission)
);

-- Seed built-in roles
INSERT INTO roles (name, auth_context, description, is_builtin, mfa_required) VALUES
  ('System Administrator', 'admin',   'System-wide management: accounts, environments, trust registry, settings', true, true),
  ('User',                 'general', 'Basic AI analysis access within assigned customers',                        true, false),
  ('Manager',              'general', 'Customer settings and user management within assigned customers',            true, false),
  ('Analyst',              'general', 'Advanced AI analysis for internal analysts',                                 true, false);

-- System Administrator permissions (admin context)
INSERT INTO role_permissions (role_id, permission)
SELECT r.id, p.permission
FROM roles r,
LATERAL (VALUES
  ('accounts:read'), ('accounts:write'), ('accounts:delete'),
  ('customers:read'), ('customers:write'),
  ('aice-environments:read'), ('aice-environments:write'),
  ('aice-environments:access-all'),
  ('trust-registry:read'), ('trust-registry:write'),
  ('analysts:read'), ('analysts:write'),
  ('audit-logs:read'),
  ('system-settings:read'), ('system-settings:write')
) AS p(permission)
WHERE r.name = 'System Administrator';

-- User permissions (general context)
INSERT INTO role_permissions (role_id, permission)
SELECT r.id, p.permission
FROM roles r,
LATERAL (VALUES
  ('workspace:read'), ('workspace:select'),
  ('analyses:read'), ('analyses:create'),
  ('reports:read'), ('reports:export'),
  ('dashboard:read')
) AS p(permission)
WHERE r.name = 'User';

-- Manager permissions (general context, includes User base)
INSERT INTO role_permissions (role_id, permission)
SELECT r.id, p.permission
FROM roles r,
LATERAL (VALUES
  ('workspace:read'), ('workspace:select'),
  ('analyses:read'), ('analyses:create'),
  ('reports:read'), ('reports:export'),
  ('dashboard:read'),
  ('customer-settings:read'), ('customer-settings:write'),
  ('customer-members:read'), ('customer-members:write')
) AS p(permission)
WHERE r.name = 'Manager';

-- Analyst permissions (general context, includes User base)
INSERT INTO role_permissions (role_id, permission)
SELECT r.id, p.permission
FROM roles r,
LATERAL (VALUES
  ('workspace:read'), ('workspace:select'),
  ('analyses:read'), ('analyses:create'),
  ('reports:read'), ('reports:export'),
  ('dashboard:read'),
  ('analyses:export'), ('analyses:configure'),
  ('reports:create'), ('reports:schedule'),
  ('dashboard:customize')
) AS p(permission)
WHERE r.name = 'Analyst';
