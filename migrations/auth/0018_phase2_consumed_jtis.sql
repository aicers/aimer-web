-- Phase 2 jti replay store (RFC 0002 §4).
--
-- Single-use semantics: once a context-token jti has been observed by
-- any Phase 2 ingest or mutation route, a second arrival of the same
-- jti is rejected with `409 Conflict` / `code = "context_jti_replay"`.
--
-- Lives in the auth DB (not per-customer) because:
--   (1) Phase 1's analogous replay protection uses the auth-DB
--       `pending_connections.jti` UNIQUE constraint, so operational
--       cleanup tooling already targets the auth DB; and
--   (2) a jti is bound to context-token issuance, not to any one
--       customer — locating it per-customer would force the route to
--       verify the envelope and resolve the customer DB *before* the
--       replay check, narrowing the window in which a duplicate could
--       slip through both verifications concurrently.
--
-- Consumption mechanism: a single
--   INSERT INTO phase2_consumed_jtis (jti) VALUES ($1)
-- after successful envelope verification and before opening the
-- per-customer DB transaction. The PRIMARY KEY violation is the
-- replay signal — caught and translated to `context_jti_replay`.
--
-- Retention sweeps remove rows older than the context-token freshness
-- window. The sweep itself is out of scope for #218; this migration
-- ships the table with the index a sweep needs.

CREATE TABLE phase2_consumed_jtis (
  jti         TEXT        PRIMARY KEY,
  consumed_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX phase2_consumed_jtis_consumed_at_idx
  ON phase2_consumed_jtis (consumed_at);

GRANT SELECT, INSERT, DELETE ON phase2_consumed_jtis TO aimer_auth;
