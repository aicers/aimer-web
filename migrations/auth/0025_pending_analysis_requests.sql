-- Wrapping endpoint for cross-site analyze flow (issue #274).
--
-- Stores the per-connection "I'm waiting for OIDC + analyze to
-- complete" state independently from `staged_event_payloads`. The
-- analyze flow's payload lifecycle (verified → consumed by
-- /continue → 302 to view_url) is distinct from the Phase 1 ingest
-- approval queue, so reuse would conflate two lifecycles and force
-- every approval-queue reader to filter analyze-pending rows out.
--
-- Payload ciphertext is inline (`payload` BYTEA + `wrapped_dek`) so
-- it reuses the same AES-256-GCM + OpenBao Transit envelope as
-- `staged_event_payloads`. `connection_id` is UNIQUE so two analyze
-- intents cannot share a `pending_connections` row (defence-in-depth
-- against duplicate POST replays that race past the `jti` UNIQUE on
-- `pending_connections`).
--
-- `idx_par_cleanup` is a partial index on `expires_at WHERE status =
-- 'pending'` matching the predicate of `cleanupExpiredAnalyzeRequests`'s
-- expire-pass UPDATE.

CREATE TABLE pending_analysis_requests (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  connection_id   UUID NOT NULL UNIQUE
                  REFERENCES pending_connections(connection_id),

  -- Verified context (post-JWS, cached for /continue re-authorize)
  aice_id         TEXT NOT NULL,
  external_key    TEXT NOT NULL,

  -- Verified analyze params (post-analyze_params_token JWS)
  event_key       TEXT NOT NULL,
  lang            TEXT NOT NULL,
  model_name      TEXT NOT NULL,
  model           TEXT NOT NULL,
  force           BOOLEAN NOT NULL,

  -- Encrypted event_data (reuses crypto/envelope.ts helpers)
  payload         BYTEA NOT NULL,
  wrapped_dek     TEXT NOT NULL,
  payload_hash    TEXT NOT NULL,

  -- Lifecycle
  status          TEXT NOT NULL DEFAULT 'pending'
                  CHECK (status IN ('pending', 'consumed', 'expired', 'failed')),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at      TIMESTAMPTZ NOT NULL,
  consumed_at     TIMESTAMPTZ,
  view_url        TEXT,
  failure_code    TEXT,
  failure_at      TIMESTAMPTZ
);

CREATE INDEX idx_par_cleanup ON pending_analysis_requests(expires_at)
  WHERE status = 'pending';

GRANT SELECT, INSERT, UPDATE, DELETE ON pending_analysis_requests TO aimer_auth;
