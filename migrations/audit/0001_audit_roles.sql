-- Grant table-level privileges to audit_db roles.
-- Role creation is handled by infra/postgres/init-audit-db.sql
-- (Docker entrypoint). This migration only assigns grants after
-- the audit_logs table exists.

-- Owner: full access for migrations and anonymization
GRANT ALL ON ALL TABLES IN SCHEMA public TO aimer_audit_owner;
GRANT ALL ON ALL SEQUENCES IN SCHEMA public TO aimer_audit_owner;

-- Runtime: INSERT/SELECT only (no UPDATE/DELETE — tamper resistance)
GRANT SELECT, INSERT ON audit_logs TO aimer_audit;
GRANT USAGE, SELECT ON SEQUENCE audit_logs_id_seq TO aimer_audit;
