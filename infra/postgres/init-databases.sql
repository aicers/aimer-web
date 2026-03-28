-- Bootstrap databases and application roles.
-- This script runs automatically on first PostgreSQL startup
-- via the docker-entrypoint-initdb.d mechanism.
--
-- auth_db is created by POSTGRES_DB env var; audit_db and keycloak_db
-- need explicit creation here.

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

-- ---------------------------------------------------------------
-- keycloak_db (used by production Keycloak with PostgreSQL backend)
-- ---------------------------------------------------------------
CREATE DATABASE keycloak_db;

DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'keycloak') THEN
    CREATE ROLE keycloak WITH LOGIN PASSWORD 'changeme';
  END IF;
END
$$;

GRANT ALL ON DATABASE keycloak_db TO keycloak;

\connect keycloak_db

GRANT ALL ON SCHEMA public TO keycloak;

-- ---------------------------------------------------------------
-- customer_db roles (owner + runtime, shared across all customer DBs)
-- ---------------------------------------------------------------
\connect auth_db

DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'aimer_customer_owner') THEN
    CREATE ROLE aimer_customer_owner WITH LOGIN PASSWORD 'changeme';
  END IF;
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'aimer_customer') THEN
    CREATE ROLE aimer_customer WITH LOGIN PASSWORD 'changeme';
  END IF;
END
$$;

-- Database-level grants are applied dynamically when each customer DB
-- is provisioned. Table-level grants are applied by customer migrations.
