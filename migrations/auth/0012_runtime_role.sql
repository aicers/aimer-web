-- no-transaction
-- Runtime role for application queries (least-privilege).
-- DDL cannot run inside a transaction when combined with role creation
-- in some PostgreSQL configurations, so this uses no-transaction mode.

DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'aimer_auth') THEN
    CREATE ROLE aimer_auth WITH LOGIN PASSWORD 'changeme';
  END IF;
END
$$;

GRANT USAGE ON SCHEMA public TO aimer_auth;

-- Full CRUD on application tables
GRANT SELECT, INSERT, UPDATE, DELETE ON
  system_settings,
  customers,
  roles,
  role_permissions,
  accounts,
  account_customer_memberships,
  analyst_customer_assignments,
  sessions,
  aice_environments,
  aice_environment_customers,
  trust_registry,
  pending_connections,
  invitations,
  analyst_invitations,
  staged_event_payloads,
  staged_event_customers
TO aimer_auth;

-- Sequence access for SERIAL/BIGSERIAL columns
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO aimer_auth;
