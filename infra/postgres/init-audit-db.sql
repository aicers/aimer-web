-- Bootstrap databases and application roles.
-- This script runs automatically on first PostgreSQL startup
-- via the docker-entrypoint-initdb.d mechanism.
--
-- auth_db is created by POSTGRES_DB env var; only audit_db needs
-- explicit creation here.

-- ---------------------------------------------------------------
-- audit_db
-- ---------------------------------------------------------------
CREATE DATABASE audit_db;

-- ---------------------------------------------------------------
-- auth_db roles (owner + runtime)
-- ---------------------------------------------------------------
DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'aimer_auth_owner') THEN
    CREATE ROLE aimer_auth_owner WITH LOGIN PASSWORD 'changeme';
  END IF;
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'aimer_auth') THEN
    CREATE ROLE aimer_auth WITH LOGIN PASSWORD 'changeme';
  END IF;
END
$$;

-- Owner needs full access to auth_db for running migrations.
-- auth_db is the current database (set by POSTGRES_DB=auth_db).
GRANT ALL ON DATABASE auth_db TO aimer_auth_owner;
GRANT ALL ON SCHEMA public TO aimer_auth_owner;

-- Runtime needs CONNECT; table-level grants are applied by migration 0012.
GRANT CONNECT ON DATABASE auth_db TO aimer_auth;

-- ---------------------------------------------------------------
-- audit_db roles (owner + runtime)
-- ---------------------------------------------------------------
DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'aimer_audit_owner') THEN
    CREATE ROLE aimer_audit_owner WITH LOGIN PASSWORD 'changeme';
  END IF;
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'aimer_audit') THEN
    CREATE ROLE aimer_audit WITH LOGIN PASSWORD 'changeme';
  END IF;
END
$$;

GRANT ALL ON DATABASE audit_db TO aimer_audit_owner;
GRANT CONNECT ON DATABASE audit_db TO aimer_audit;

-- Switch to audit_db to grant schema-level privileges for the owner role.
\connect audit_db

GRANT ALL ON SCHEMA public TO aimer_audit_owner;
-- Runtime table-level grants are applied by migration 0001_audit_roles.sql.
GRANT USAGE ON SCHEMA public TO aimer_audit;
