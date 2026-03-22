-- Grant table-level privileges to auth_db runtime role.
-- Role creation is handled by infra/postgres/init-audit-db.sql
-- (Docker entrypoint). This migration only assigns grants after
-- all application tables exist.

GRANT USAGE ON SCHEMA public TO aimer_auth;

-- Full CRUD on most application tables
GRANT SELECT, INSERT, UPDATE, DELETE ON
  system_settings,
  customers,
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

-- Roles and permissions: read-only at runtime.
-- Mutations go through the owner role (admin operations).
-- This prevents auth_context bypass via role UPDATE.
GRANT SELECT ON roles, role_permissions TO aimer_auth;

-- Sequence access for SERIAL/BIGSERIAL columns
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO aimer_auth;
