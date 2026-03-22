-- no-transaction
-- Audit database roles: owner for migrations/anonymization, runtime for INSERT/SELECT only.

DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'aimer_audit_owner') THEN
    CREATE ROLE aimer_audit_owner WITH LOGIN PASSWORD 'changeme';
  END IF;
END
$$;

GRANT ALL ON SCHEMA public TO aimer_audit_owner;
GRANT ALL ON ALL TABLES IN SCHEMA public TO aimer_audit_owner;
GRANT ALL ON ALL SEQUENCES IN SCHEMA public TO aimer_audit_owner;

DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'aimer_audit') THEN
    CREATE ROLE aimer_audit WITH LOGIN PASSWORD 'changeme';
  END IF;
END
$$;

GRANT USAGE ON SCHEMA public TO aimer_audit;
GRANT SELECT, INSERT ON audit_logs TO aimer_audit;
GRANT USAGE, SELECT ON SEQUENCE audit_logs_id_seq TO aimer_audit;
