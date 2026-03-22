-- Create the audit_db database and audit_writer role.
-- This script runs automatically on first PostgreSQL startup
-- via the docker-entrypoint-initdb.d mechanism.

CREATE DATABASE audit_db;

DO $$
BEGIN
    IF NOT EXISTS (SELECT FROM pg_catalog.pg_roles WHERE rolname = 'audit_writer') THEN
        CREATE ROLE audit_writer WITH LOGIN PASSWORD 'changeme';
    END IF;
END
$$;

GRANT CONNECT ON DATABASE audit_db TO audit_writer;

-- Switch to audit_db to grant schema-level privileges
\connect audit_db

GRANT USAGE ON SCHEMA public TO audit_writer;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
    GRANT SELECT, INSERT ON TABLES TO audit_writer;
