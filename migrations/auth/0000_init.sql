-- auth_db first-version schema (#535).
--
-- Single collapsed schema file for the shared auth database. aimer-web is
-- pre-release: dev databases are reset on schema changes, so this file is
-- edited in place until the first release. Post-release changes append
-- numbered migrations starting at 0001 (see migrations/README.md).
--
-- Organization: extensions → tables (with their indexes, in FK dependency
-- order) → trigger functions + triggers → runtime-role grants → seeds.

CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- ---------------------------------------------------------------
-- system_settings — admin-scoped key/value settings
-- ---------------------------------------------------------------
CREATE TABLE system_settings (
  key        TEXT        PRIMARY KEY,
  value      JSONB       NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ---------------------------------------------------------------
-- subjects — supertype identity for customers and groups (RFC 0004)
-- ---------------------------------------------------------------
-- A subject is the first-class identity that customers and customer
-- groups extend. A subtype row shares the SAME UUID as its subject row.
-- UNIQUE (id, kind) is redundant for uniqueness (id is the PK); it
-- exists solely as the composite-FK target that lets the group subtype
-- prove it attaches to a group-kind subject.
CREATE TABLE subjects (
    id         UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
    kind       TEXT         NOT NULL
               CHECK (kind IN ('customer', 'group')),
    created_at TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    CONSTRAINT subjects_id_kind_key UNIQUE (id, kind)
);

-- ---------------------------------------------------------------
-- customers — the customer subtype of subjects
-- ---------------------------------------------------------------
-- `customers.id` is also a FK carrying the same value as the subject
-- row; deleting the subject cascades to the customer subtype.
-- `timezone` drives day/week/month report-bucket boundaries (RFC 0002
-- §"Customer-level timezone"); account-level `accounts.timezone` stays
-- UI-display-only. `wrapped_dek` is the OpenBao Transit-wrapped
-- per-customer DEK, populated during provisioning.
CREATE TABLE customers (
  id              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  external_key    TEXT        NOT NULL UNIQUE,
  name            TEXT        NOT NULL,
  description     TEXT,
  status          TEXT        NOT NULL DEFAULT 'active'
                  CHECK (status IN ('active', 'suspended', 'disabled')),
  database_status TEXT        NOT NULL DEFAULT 'provisioning'
                  CHECK (database_status IN ('provisioning', 'active', 'failed')),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  wrapped_dek     TEXT,
  timezone        TEXT        NOT NULL DEFAULT 'Asia/Seoul',
  CONSTRAINT customers_id_subject_fkey
      FOREIGN KEY (id) REFERENCES subjects(id) ON DELETE CASCADE
);

-- ---------------------------------------------------------------
-- roles / role_permissions
-- ---------------------------------------------------------------
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

-- ---------------------------------------------------------------
-- accounts
-- ---------------------------------------------------------------
-- `locale` is constrained to the supported app locales so a bad write
-- cannot poison locale resolution; NULL means "no saved preference".
-- `timezone` is deliberately unconstrained at the DB level — the IANA
-- zone set is large and runtime-dependent, so it is validated in the
-- application layer (`isValidTimeZone`) instead.
--
-- The four `time_format_*` columns are the per-account date/time DISPLAY
-- format preference (#556). They are intentionally nullable with no SQL
-- `DEFAULT`, so `NULL` uniformly means "use the app default" and stays
-- distinguishable from any explicit choice:
--   * `time_format_locale`     — NULL = follow the browser locale; the
--     literal sentinel `'app'` = follow the active app locale; any other
--     value = an explicit BCP-47 tag from the curated list (the curated
--     set is validated in the application layer, like `timezone`).
--   * `time_format_hour_cycle` — NULL = follow the locale's default; the
--     CHECK pins explicit values to `'h12'` (12-hour) / `'h23'` (24-hour).
--   * `time_format_seconds`    — NULL = default (show seconds).
--   * `time_format_tz_label`   — NULL = default (hide the timezone label).
CREATE TABLE accounts (
  id               UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  oidc_issuer      TEXT        NOT NULL,
  oidc_subject     TEXT        NOT NULL,
  username         TEXT        NOT NULL,
  display_name     TEXT        NOT NULL,
  email            TEXT,
  analyst_eligible BOOLEAN     NOT NULL DEFAULT false,
  admin_eligible   BOOLEAN     NOT NULL DEFAULT false,
  status           TEXT        NOT NULL DEFAULT 'active'
                   CHECK (status IN ('active', 'suspended', 'disabled')),
  token_version    INTEGER     NOT NULL DEFAULT 0,
  locale           TEXT,
  timezone         TEXT,
  time_format_locale     TEXT,
  time_format_hour_cycle TEXT,
  time_format_seconds    BOOLEAN,
  time_format_tz_label   BOOLEAN,
  last_sign_in_at  TIMESTAMPTZ,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  admin_eligible_at TIMESTAMPTZ,
  UNIQUE (oidc_issuer, oidc_subject),
  CONSTRAINT accounts_locale_check
      CHECK (locale IS NULL OR locale IN ('en', 'ko')),
  CONSTRAINT accounts_time_format_hour_cycle_check
      CHECK (time_format_hour_cycle IS NULL
             OR time_format_hour_cycle IN ('h12', 'h23'))
);

-- ---------------------------------------------------------------
-- account_customer_memberships
-- ---------------------------------------------------------------
-- role_id may reference only general-context roles (enforced by
-- trg_membership_role_check below). An admin role in a membership
-- would project admin permissions into the general JWT, breaking auth
-- context separation.
CREATE TABLE account_customer_memberships (
  account_id  UUID    NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  customer_id UUID    NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  role_id     INTEGER NOT NULL REFERENCES roles(id),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (account_id, customer_id)
);

-- ---------------------------------------------------------------
-- analyst_customer_assignments
-- ---------------------------------------------------------------
CREATE TABLE analyst_customer_assignments (
  account_id  UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  customer_id UUID NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  assigned_by UUID NOT NULL REFERENCES accounts(id),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (account_id, customer_id)
);

-- ---------------------------------------------------------------
-- sessions
-- ---------------------------------------------------------------
CREATE TABLE sessions (
  sid                 UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id          UUID        NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  auth_context        TEXT        NOT NULL DEFAULT 'general'
                      CHECK (auth_context IN ('general', 'admin')),
  bridge_aice_id      TEXT,
  bridge_customer_ids UUID[],
  ip_address          TEXT        NOT NULL,
  user_agent          TEXT        NOT NULL,
  browser_fingerprint TEXT        NOT NULL DEFAULT '',
  needs_reauth        BOOLEAN     NOT NULL DEFAULT false,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_active_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  revoked             BOOLEAN     NOT NULL DEFAULT false,

  -- Admin sessions cannot have bridge context
  CHECK (auth_context != 'admin'
         OR (bridge_aice_id IS NULL AND bridge_customer_ids IS NULL)),

  -- Bridge fields must be both NULL or both NOT NULL
  CHECK (
    (bridge_aice_id IS NULL AND bridge_customer_ids IS NULL)
    OR (bridge_aice_id IS NOT NULL AND bridge_customer_ids IS NOT NULL)
  )
);

CREATE INDEX idx_sessions_account_id ON sessions (account_id);

-- ---------------------------------------------------------------
-- aice_environments / aice_environment_customers
-- ---------------------------------------------------------------
CREATE TABLE aice_environments (
  id          SERIAL      PRIMARY KEY,
  aice_id     TEXT        NOT NULL UNIQUE,
  name        TEXT        NOT NULL,
  description TEXT,
  status      TEXT        NOT NULL DEFAULT 'active'
              CHECK (status IN ('active', 'suspended', 'disabled')),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE aice_environment_customers (
  aice_id     TEXT NOT NULL REFERENCES aice_environments(aice_id) ON DELETE CASCADE,
  customer_id UUID NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (aice_id, customer_id)
);

-- ---------------------------------------------------------------
-- trust_registry
-- ---------------------------------------------------------------
CREATE TABLE trust_registry (
  id          SERIAL      PRIMARY KEY,
  aice_id     TEXT        NOT NULL REFERENCES aice_environments(aice_id),
  issuer      TEXT        NOT NULL,
  kid         TEXT        NOT NULL,
  public_key  JSONB       NOT NULL,
  description TEXT,
  enabled     BOOLEAN     NOT NULL DEFAULT true,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at  TIMESTAMPTZ NULL,
  UNIQUE (aice_id, issuer, kid)
);

-- ---------------------------------------------------------------
-- pending_connections
-- ---------------------------------------------------------------
CREATE TABLE pending_connections (
  connection_id UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  jti           TEXT        NOT NULL UNIQUE,
  issuer        TEXT        NOT NULL,
  aice_id       TEXT        NOT NULL,
  customer_ids  TEXT[]      NOT NULL,
  sub           TEXT,
  status        TEXT        NOT NULL DEFAULT 'pending'
                CHECK (status IN ('pending', 'consumed', 'denied', 'expired')),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at    TIMESTAMPTZ NOT NULL
);

CREATE INDEX idx_pending_connections_expires
  ON pending_connections (expires_at)
  WHERE status = 'pending';

-- ---------------------------------------------------------------
-- invitations
-- ---------------------------------------------------------------
-- 'revoked' is the soft-delete status, preserving the audit trail of
-- who invited whom and when (#83).
CREATE TABLE invitations (
  id            UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  token_hash    TEXT        NOT NULL UNIQUE,
  customer_id   UUID        NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  invited_email TEXT        NOT NULL,
  role_id       INTEGER     NOT NULL REFERENCES roles(id),
  invited_by    UUID        NOT NULL REFERENCES accounts(id),
  status        TEXT        NOT NULL DEFAULT 'pending'
                CHECK (status IN ('pending', 'accepted', 'expired', 'revoked')),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at    TIMESTAMPTZ NOT NULL DEFAULT NOW() + INTERVAL '7 days'
);

-- One pending invitation per customer+email
CREATE UNIQUE INDEX idx_invitations_pending_unique
  ON invitations (customer_id, lower(invited_email))
  WHERE status = 'pending';

CREATE INDEX idx_invitations_token_hash
  ON invitations (token_hash)
  WHERE status = 'pending';

CREATE INDEX idx_invitations_expires
  ON invitations (expires_at)
  WHERE status = 'pending';

-- ---------------------------------------------------------------
-- analyst_invitations
-- ---------------------------------------------------------------
-- Analyst invitations (separate flow from customer membership
-- invitations). Unlike member invitations, analyst invitations are not
-- per-customer: an empty customer_ids array ('{}') is valid for an
-- as-yet-unassigned analyst, and the pending-uniqueness key is the
-- email alone.
CREATE TABLE analyst_invitations (
  id           UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  email        TEXT        NOT NULL,
  customer_ids UUID[]      NOT NULL,
  invited_by   UUID        NOT NULL REFERENCES accounts(id),
  token_hash   TEXT        NOT NULL UNIQUE,
  status       TEXT        NOT NULL DEFAULT 'pending'
               CHECK (status IN ('pending', 'accepted', 'expired', 'revoked')),
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at   TIMESTAMPTZ NOT NULL DEFAULT NOW() + INTERVAL '7 days'
);

-- One pending analyst invitation per email (not per customer+email)
CREATE UNIQUE INDEX idx_analyst_invitations_pending_unique
  ON analyst_invitations (lower(email))
  WHERE status = 'pending';

-- token_hash is already NOT NULL UNIQUE; this partial index is redundant
-- but kept for parity with `invitations`' idx_invitations_token_hash.
CREATE INDEX idx_analyst_invitations_token_hash
  ON analyst_invitations (token_hash)
  WHERE status = 'pending';

CREATE INDEX idx_analyst_invitations_expires
  ON analyst_invitations (expires_at)
  WHERE status = 'pending';

-- ---------------------------------------------------------------
-- staged_event_payloads / staged_event_customers
-- ---------------------------------------------------------------
-- `payload` stores AES-256-GCM ciphertext; `wrapped_dek` is the OpenBao
-- Transit envelope key.
CREATE TABLE staged_event_payloads (
  id             UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  connection_id  UUID        REFERENCES pending_connections(connection_id),
  session_id     UUID        REFERENCES sessions(sid),
  aice_id        TEXT        NOT NULL,
  payload_hash   TEXT        NOT NULL,
  payload        BYTEA       NOT NULL,
  event_count    INTEGER     NOT NULL,
  schema_version TEXT        NOT NULL,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at     TIMESTAMPTZ NOT NULL,
  wrapped_dek    TEXT        NOT NULL
);

CREATE TABLE staged_event_customers (
  id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  payload_id  UUID        NOT NULL REFERENCES staged_event_payloads(id) ON DELETE CASCADE,
  customer_id UUID        NOT NULL REFERENCES customers(id),
  status      TEXT        NOT NULL DEFAULT 'pending'
              CHECK (status IN ('pending', 'approved', 'rejected', 'expired')),
  approved_at TIMESTAMPTZ,
  UNIQUE (payload_id, customer_id)
);

CREATE INDEX idx_staged_event_payloads_session
  ON staged_event_payloads (session_id);

CREATE INDEX idx_staged_event_payloads_expires
  ON staged_event_payloads (expires_at);

CREATE INDEX idx_staged_event_customers_status
  ON staged_event_customers (payload_id)
  WHERE status = 'pending';

-- ---------------------------------------------------------------
-- phase2_consumed_jtis — Phase 2 jti replay store (RFC 0002 §4)
-- ---------------------------------------------------------------
-- Single-use semantics: once a context-token jti has been observed by
-- any Phase 2 ingest or mutation route, a second arrival of the same
-- jti is rejected with `409 Conflict` / `code = "context_jti_replay"`.
-- The PRIMARY KEY violation on INSERT is the replay signal. Retention
-- sweeps remove rows older than the context-token freshness window.
CREATE TABLE phase2_consumed_jtis (
  jti         TEXT        PRIMARY KEY,
  consumed_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX phase2_consumed_jtis_consumed_at_idx
  ON phase2_consumed_jtis (consumed_at);

-- ---------------------------------------------------------------
-- customer_redaction_ranges (RFC 0001)
-- ---------------------------------------------------------------
-- Customer-registered public IP ranges used by the redaction engine.
-- Live in auth_db so the ranges are looked up by `customer_id` before
-- any per-customer DB is opened.
CREATE TABLE customer_redaction_ranges (
  id          UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id UUID         NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  cidr        CIDR         NOT NULL,
  ip_version  SMALLINT     NOT NULL CHECK (ip_version IN (4, 6)),
  created_at  TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  created_by  UUID         NOT NULL,
  UNIQUE (customer_id, cidr)
);

CREATE INDEX customer_redaction_ranges_customer_id_idx
  ON customer_redaction_ranges (customer_id);

-- ---------------------------------------------------------------
-- customer_retention_policy (RFC 0001)
-- ---------------------------------------------------------------
-- One row per customer, inserted by the createCustomer transaction
-- (`src/lib/auth/customers.ts`) at provisioning time. The schema-level
-- default on `ingestion_days` keeps the row well-formed even if some
-- future call path forgets to supply it; `analysis_days` is
-- intentionally nullable (NULL means "no expiry" per RFC 0001
-- §"Retention") and the provisioning insert supplies 1095 explicitly —
-- defaulting NULL would silently change the retention policy from
-- "36 months" to "forever".
CREATE TABLE customer_retention_policy (
  customer_id     UUID         PRIMARY KEY REFERENCES customers(id) ON DELETE CASCADE,
  ingestion_days  INTEGER      NOT NULL DEFAULT 365 CHECK (ingestion_days >= 30),
  analysis_days   INTEGER      CHECK (analysis_days IS NULL OR analysis_days >= 30),
  updated_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  updated_by      UUID         NOT NULL
);

-- ---------------------------------------------------------------
-- redaction_jobs / redaction_job_items (RFC 0001, #253)
-- ---------------------------------------------------------------
-- Retroactive re-redact job state. `range_snapshot` is the durable copy
-- of the customer's redaction ranges (engine semver + sorted normalised
-- CIDR list) frozen when the worker flips a job queued -> running;
-- `range_snapshot_ranges_hash` stores just the 12-hex SHA-256 short
-- value, cross-checked against `target_policy_version` on recovery.
-- `running_started_at` distinguishes queue time (`started_at`) from
-- worker pickup time. The (aice_id, event_key) cursor columns are
-- superseded by `redaction_job_items.seq` ordering but remain part of
-- the row shape.
CREATE TABLE redaction_jobs (
  id                          UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id                 UUID         NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  status                      TEXT         NOT NULL
                              CHECK (status IN ('queued', 'running', 'completed', 'failed', 'cancelled')),
  target_policy_version       TEXT         NOT NULL,
  total_rows                  BIGINT,
  processed_rows              BIGINT       NOT NULL DEFAULT 0,
  failed_rows                 BIGINT       NOT NULL DEFAULT 0,
  last_processed_aice_id      TEXT,
  last_processed_event_key    NUMERIC(39, 0),
  last_progress_at            TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  started_at                  TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  completed_at                TIMESTAMPTZ,
  error_message               TEXT,
  triggered_by                UUID         NOT NULL,
  running_started_at          TIMESTAMPTZ,
  cancelled_by                UUID,
  cancellation_reason         TEXT,
  range_snapshot              JSONB,
  range_snapshot_ranges_hash  TEXT
);

-- At most one active job per customer; re-clicking the trigger button
-- must return the existing job rather than queue a duplicate.
CREATE UNIQUE INDEX redaction_jobs_one_active_per_customer
  ON redaction_jobs (customer_id)
  WHERE status IN ('queued', 'running');

CREATE INDEX redaction_jobs_customer_id_idx
  ON redaction_jobs (customer_id);

-- Materialized candidate items, ordered by a monotonic `seq`
-- independent of any natural-key collision (tables whose PK exceeds
-- (aice_id, event_key) could not be resumed on that cursor alone).
CREATE TABLE redaction_job_items (
  job_id             UUID           NOT NULL REFERENCES redaction_jobs(id) ON DELETE CASCADE,
  seq                BIGINT         NOT NULL,
  source_table       TEXT           NOT NULL
                     CHECK (source_table IN (
                       'detection_events','baseline_event','story_member',
                       'policy_event','event_analysis_result'
                     )),
  primary_key        JSONB          NOT NULL,
  resolved_aice_id   TEXT           NOT NULL,
  resolved_event_key NUMERIC(39, 0) NOT NULL,
  status             TEXT           NOT NULL DEFAULT 'pending'
                     CHECK (status IN ('pending','done','failed','skipped')),
  error_code         TEXT,
  processed_at       TIMESTAMPTZ,
  PRIMARY KEY (job_id, seq)
);

CREATE INDEX redaction_job_items_pending_idx
  ON redaction_job_items (job_id, seq)
  WHERE status = 'pending';

-- ---------------------------------------------------------------
-- pending_analysis_requests (#274)
-- ---------------------------------------------------------------
-- Wrapping endpoint for the cross-site analyze flow. Stores the
-- per-connection "waiting for OIDC + analyze to complete" state.
-- Payload ciphertext is inline (`payload` BYTEA + `wrapped_dek`),
-- reusing the AES-256-GCM + OpenBao Transit envelope. `connection_id`
-- is UNIQUE so two analyze intents cannot share a `pending_connections`
-- row. `status='processing'` is the in-flight claim `/continue` takes
-- (CAS UPDATE pending → processing) so concurrent GETs cannot both
-- invoke the aimer call. `lang` is nullable: aimer's `Mutation.analyzeEvent`
-- declares `lang: Language` (nullable) and the BFF preserves
-- caller-supplied absence end-to-end (#281).
CREATE TABLE pending_analysis_requests (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  connection_id   UUID NOT NULL UNIQUE
                  REFERENCES pending_connections(connection_id),

  -- Verified context (post-JWS, cached for /continue re-authorize)
  aice_id         TEXT NOT NULL,
  external_key    TEXT NOT NULL,

  -- Verified analyze params (post-analyze_params_token JWS)
  event_key       TEXT NOT NULL,
  lang            TEXT,
  model_name      TEXT NOT NULL,
  model           TEXT NOT NULL,
  force           BOOLEAN NOT NULL,

  -- Encrypted event_data (reuses crypto/envelope.ts helpers)
  payload         BYTEA NOT NULL,
  wrapped_dek     TEXT NOT NULL,
  payload_hash    TEXT NOT NULL,

  -- Lifecycle
  status          TEXT NOT NULL DEFAULT 'pending'
                  CHECK (status IN ('pending', 'processing',
                                    'consumed', 'expired', 'failed')),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at      TIMESTAMPTZ NOT NULL,
  consumed_at     TIMESTAMPTZ,
  view_url        TEXT,
  failure_code    TEXT,
  failure_at      TIMESTAMPTZ
);

-- Partial index matching the predicate of
-- `cleanupExpiredAnalyzeRequests`'s expire-pass UPDATE.
CREATE INDEX idx_par_cleanup ON pending_analysis_requests(expires_at)
  WHERE status IN ('pending', 'processing');

-- ---------------------------------------------------------------
-- story_analysis_state / story_analysis_job (RFC 0002)
-- ---------------------------------------------------------------
-- Source-side readiness lives on `story_analysis_state` (one row per
-- `(customer_id, story_id)`); per-variant work (lang/model_name/model)
-- lives on `story_analysis_job`. `status='archived'` terminates the
-- lifecycle when every `story_version` of a `story_id` has been deleted
-- from the customer DB; unarchive-in-place is allowed if the same
-- `story_id` re-appears via a later window-replace.
--
-- `priority_tier` / `severity_score` / `likelihood_score` denormalize
-- the canonical variant's result (customer DB) onto this auth-DB row so
-- the Threat Stories list can order priority-first and keyset-paginate
-- in a single query (#392). NULL until a canonical result exists; the
-- worker writes them only at story-job finalization.
CREATE TABLE story_analysis_state (
    customer_id      UUID         NOT NULL
                     REFERENCES customers(id) ON DELETE CASCADE,
    story_id         BIGINT       NOT NULL,
    status           TEXT         NOT NULL
                     CHECK (status IN ('pending', 'ready', 'dirty', 'archived')),
    created_at       TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    first_member_at  TIMESTAMPTZ,
    last_member_at   TIMESTAMPTZ,
    last_ready_at    TIMESTAMPTZ,
    updated_at       TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    priority_tier    TEXT
                     CHECK (priority_tier IN ('CRITICAL', 'HIGH', 'MEDIUM', 'LOW')),
    severity_score   DOUBLE PRECISION,
    likelihood_score DOUBLE PRECISION,
    PRIMARY KEY (customer_id, story_id)
);

CREATE INDEX story_analysis_state_status_idx
    ON story_analysis_state (status)
    WHERE status IN ('ready', 'dirty');

CREATE INDEX story_analysis_state_customer_idx
    ON story_analysis_state (customer_id);

-- Worker per-tick pending promotion scan; the index columns match the
-- scan's ORDER BY / lookup key so the planner satisfies both predicate
-- and ordering from the index alone.
CREATE INDEX story_analysis_state_pending_idx
    ON story_analysis_state (customer_id, story_id)
    WHERE status = 'pending';

-- Threat Stories list default scan: non-archived rows that have a
-- denormalized result, ordered priority-first within one customer.
CREATE INDEX story_analysis_state_priority_idx
    ON story_analysis_state (customer_id)
    WHERE status <> 'archived' AND priority_tier IS NOT NULL;

CREATE TABLE story_analysis_job (
    customer_id           UUID         NOT NULL,
    story_id              BIGINT       NOT NULL,
    lang                  TEXT         NOT NULL,
    model_name            TEXT         NOT NULL,
    model                 TEXT         NOT NULL,
    status                TEXT         NOT NULL
                          CHECK (status IN ('queued', 'processing', 'done', 'failed')),
    generation            INT          NOT NULL DEFAULT 1,
    dry_run               BOOLEAN      NOT NULL DEFAULT FALSE,
    created_at            TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    processing_started_at TIMESTAMPTZ,
    last_generated_at     TIMESTAMPTZ,
    force_requested_at    TIMESTAMPTZ,
    force_requested_by    UUID,
    attempts              INT          NOT NULL DEFAULT 0,
    last_error            TEXT,
    updated_at            TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    PRIMARY KEY (customer_id, story_id, lang, model_name, model),
    FOREIGN KEY (customer_id, story_id)
        REFERENCES story_analysis_state(customer_id, story_id)
        ON DELETE CASCADE
);

CREATE INDEX story_analysis_job_queued_idx
    ON story_analysis_job (customer_id, story_id)
    WHERE status = 'queued';

CREATE INDEX story_analysis_job_dry_run_idx
    ON story_analysis_job (customer_id)
    WHERE dry_run = TRUE;

-- ---------------------------------------------------------------
-- periodic_report_state / periodic_report_job (RFC 0002, RFC 0004)
-- ---------------------------------------------------------------
-- One row per `(subject_id, period, bucket_date, tz)` tracks source-
-- side readiness; per-variant work lives on `periodic_report_job`.
-- Keyed on subject identity (RFC 0004 / #503): customers AND customer
-- groups record their periodic-report state here. `tz` participates in
-- the PK so a timezone change creates a new row rather than mutating
-- the existing one; old-tz rows are archived by the
-- trg_archive_periodic_states_on_tz_change trigger below. LIVE rows use
-- a synthetic `bucket_date = '1970-01-01'` and rely on the per-variant
-- `next_due_at` on the job row for cadence.
--
-- Reconcile safety-net signals (all per bucket):
--   * `last_event_at` — max source `event_time` observed.
--   * `last_event_received_at` — max customer-DB
--     `baseline_event.received_at` observed; monotone "bucket received
--     a new event" even when the event's `event_time` does not advance
--     the bucket max.
--   * `event_count` — last observed `baseline_event` row count; a lower
--     recomputed value means a window-replace / backfill envelope
--     deleted events without advancing either max.
--   * `last_story_received_at` / `story_count` — the story-side mirror
--     of the baseline pair, for story-only envelopes whose best-effort
--     dirty hook failed. LIVE rows are excluded from these dirty
--     triggers (the LIVE window is a moving trailing-24h target).
--   * `cursor_watermark` + `cursor_watermark_quality` — ingest-hook
--     watermark; only a `strict` watermark covering the bucket end may
--     shorten DAILY settle. On equal timestamps, `strict` wins.
--
-- The named NOT NULL constraint on `subject_id` (here and on
-- `periodic_report_job`, plus the job FK below) keeps its pre-rename
-- name: the #503 subject re-key renamed the column under the
-- constraint, which Postgres does not rename, and the collapsed schema
-- reproduces the historical chain's final state exactly.
CREATE TABLE periodic_report_state (
    subject_id             UUID         CONSTRAINT periodic_report_state_customer_id_not_null NOT NULL,
    period                 TEXT         NOT NULL
                           CHECK (period IN ('LIVE', 'DAILY', 'WEEKLY', 'MONTHLY')),
    bucket_date            DATE         NOT NULL,
    tz                     TEXT         NOT NULL,
    status                 TEXT         NOT NULL
                           CHECK (status IN ('pending', 'ready', 'dirty', 'archived')),
    created_at             TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    last_event_at          TIMESTAMPTZ,
    last_event_received_at TIMESTAMPTZ,
    cursor_watermark       TIMESTAMPTZ,
    last_ready_at          TIMESTAMPTZ,
    updated_at             TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    event_count            BIGINT       NOT NULL DEFAULT 0,
    last_story_received_at TIMESTAMPTZ,
    story_count            BIGINT       NOT NULL DEFAULT 0,
    cursor_watermark_quality TEXT NULL
        CHECK (cursor_watermark_quality IN ('strict', 'soft')),
    PRIMARY KEY (subject_id, period, bucket_date, tz),
    CONSTRAINT periodic_report_state_subject_id_fkey
        FOREIGN KEY (subject_id) REFERENCES subjects(id) ON DELETE CASCADE
);

CREATE INDEX periodic_report_state_status_idx
    ON periodic_report_state (status)
    WHERE status IN ('ready', 'dirty');

CREATE INDEX periodic_report_state_subject_idx
    ON periodic_report_state (subject_id);

CREATE INDEX periodic_report_state_pending_idx
    ON periodic_report_state (subject_id, period, bucket_date, tz)
    WHERE status = 'pending';

-- `next_due_at` lives on the job table because it is per-variant — each
-- variant ticks independently. The `translation_*` columns are the
-- audit trail for a translate-path variant (#412): the translated
-- result row carries the English canonical's model/prompt provenance so
-- the variant key stays self-consistent; the model/prompt actually used
-- to translate are recorded here instead. NULL for native jobs.
CREATE TABLE periodic_report_job (
    subject_id            UUID         CONSTRAINT periodic_report_job_customer_id_not_null NOT NULL,
    period                TEXT         NOT NULL,
    bucket_date           DATE         NOT NULL,
    tz                    TEXT         NOT NULL,
    lang                  TEXT         NOT NULL,
    model_name            TEXT         NOT NULL,
    model                 TEXT         NOT NULL,
    status                TEXT         NOT NULL
                          CHECK (status IN ('queued', 'processing', 'done', 'failed')),
    generation            INT          NOT NULL DEFAULT 1,
    dry_run               BOOLEAN      NOT NULL DEFAULT FALSE,
    created_at            TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    processing_started_at TIMESTAMPTZ,
    last_generated_at     TIMESTAMPTZ,
    next_due_at           TIMESTAMPTZ,
    force_requested_at    TIMESTAMPTZ,
    force_requested_by    UUID,
    attempts              INT          NOT NULL DEFAULT 0,
    last_error            TEXT,
    translation_model_name   TEXT,
    translation_model        TEXT,
    translation_prompt_version TEXT,
    updated_at            TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    PRIMARY KEY (subject_id, period, bucket_date, tz, lang, model_name, model),
    CONSTRAINT periodic_report_job_customer_id_period_bucket_date_tz_fkey
        FOREIGN KEY (subject_id, period, bucket_date, tz)
        REFERENCES periodic_report_state(subject_id, period, bucket_date, tz)
        ON DELETE CASCADE
);

CREATE INDEX periodic_report_job_queued_idx
    ON periodic_report_job (subject_id, period, bucket_date, tz)
    WHERE status = 'queued';

CREATE INDEX periodic_report_job_dry_run_idx
    ON periodic_report_job (subject_id)
    WHERE dry_run = TRUE;

-- Note: the IOC feed store (`ioc_feed_snapshot`) moved out of this
-- shared auth DB into its own dedicated feed DB (#564) — see
-- migrations/feed/0000_init.sql. Feed data is external-sourced,
-- read-heavy on match, and replaced wholesale on refresh, so it no
-- longer shares blast radius with the authn/authz hot path.

-- ---------------------------------------------------------------
-- customer_owned_domains (RFC 0001 Amendment A.2)
-- ---------------------------------------------------------------
-- Customer-registered owned domains used by the redaction engine,
-- parallel to `customer_redaction_ranges`. Only a customer's OWN
-- domains (and their subdomains) are masked in event payloads; external
-- domains pass through.
CREATE TABLE customer_owned_domains (
  id                  UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id         UUID        NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  owned_domain_suffix TEXT        NOT NULL,  -- normalized: lowercased, leading-dot-normalized for suffix matching
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_by          UUID        NOT NULL,
  UNIQUE (customer_id, owned_domain_suffix)
);

CREATE INDEX customer_owned_domains_customer_id_idx
  ON customer_owned_domains (customer_id);

-- ---------------------------------------------------------------
-- customer_default_model (#473)
-- ---------------------------------------------------------------
-- Per-customer default analysis model — the first tier of the
-- three-tier resolution `customer -> admin-set global -> env`
-- (`resolveDefaultModel`). One OPTIONAL row per customer: the ABSENCE
-- of a row means "no override, fall back to the global default (or
-- env)"; clearing the override is a plain row delete. Validated against
-- `ANALYSIS_MODEL_CATALOG` at save time — no DB-level CHECK against the
-- env-derived catalog is possible.
CREATE TABLE customer_default_model (
  customer_id  UUID         PRIMARY KEY REFERENCES customers(id) ON DELETE CASCADE,
  model_name   TEXT         NOT NULL,
  model        TEXT         NOT NULL,
  updated_at   TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  updated_by   UUID         NOT NULL
);

-- ---------------------------------------------------------------
-- event_leaf_backfill_runs / event_leaf_backfill_items (#470)
-- ---------------------------------------------------------------
-- Event-leaf re-analysis backfill control state (NOT an event-analysis
-- lifecycle). After a per-customer default-model change (#473), an
-- operator can re-analyze existing event leaves under the new model. A
-- run is scoped to one customer and one `(lang, model_name, model)`
-- variant over a recent event-time window. The drain-completion signal
-- is computed from `event_analysis_result` itself; these tables only
-- explain WHY an event is outstanding (failed vs not-yet-run vs
-- cap-excluded) for no-silent-caps reporting.
--
-- The single-owner lease (`lease_owner` / `lease_expires_at`) keeps the
-- self-paced model-call burst bounded per run regardless of replica
-- count: only the lease holder drains; on crash the lease lapses and
-- another worker resumes the run.
CREATE TABLE event_leaf_backfill_runs (
    id                       UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
    customer_id              UUID         NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
    -- Target variant the run re-analyzes toward.
    lang                     TEXT         NOT NULL,
    model_name               TEXT         NOT NULL,
    model                    TEXT         NOT NULL,
    -- Scope window on the baseline_event event-time basis, frozen at
    -- creation so preview, worker materialization, and reporting agree.
    window_days              INT          NOT NULL,
    window_start             TIMESTAMPTZ  NOT NULL,
    window_end               TIMESTAMPTZ  NOT NULL,
    -- Optional per-run cap on events actually re-analyzed (self-paced
    -- cost bound). NULL = no cap within the window; candidates beyond
    -- the cap are reported as `cap_excluded`.
    max_items                INT,
    status                   TEXT         NOT NULL DEFAULT 'pending'
        CHECK (status IN ('pending', 'running', 'completed', 'cancelled', 'failed')),
    -- Cooperative cancel flag the worker polls between events.
    cancel_requested         BOOLEAN      NOT NULL DEFAULT FALSE,
    -- Aggregate counts (no-silent-caps categories).
    total_universe           INT          NOT NULL DEFAULT 0,
    reanalyzed_count         INT          NOT NULL DEFAULT 0,
    already_current_count    INT          NOT NULL DEFAULT 0,
    source_unavailable_count INT          NOT NULL DEFAULT 0,
    failed_count             INT          NOT NULL DEFAULT 0,
    cap_excluded_count       INT          NOT NULL DEFAULT 0,
    error_message            TEXT,
    created_by               UUID,
    created_at               TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    started_at               TIMESTAMPTZ,
    finished_at              TIMESTAMPTZ,
    last_progress_at         TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    lease_owner              TEXT,
    lease_expires_at         TIMESTAMPTZ
);

-- At most one active run per customer + target variant; re-launching
-- returns the existing run.
CREATE UNIQUE INDEX event_leaf_backfill_runs_one_active
    ON event_leaf_backfill_runs (customer_id, lang, model_name, model)
    WHERE status IN ('pending', 'running');

-- Claim scan: the oldest active run whose lease is free / expired /
-- ours. Ordering by created_at keeps FIFO.
CREATE INDEX event_leaf_backfill_runs_claimable_idx
    ON event_leaf_backfill_runs (created_at)
    WHERE status IN ('pending', 'running');

CREATE INDEX event_leaf_backfill_runs_customer_idx
    ON event_leaf_backfill_runs (customer_id);

-- Per-event work item / status. `processing` is the in-flight claim
-- state: the worker claims each item with a conditional transition
-- (`pending` -> `processing`) BEFORE the model call, so replicas never
-- re-analyze the same event; stale `processing` rows are reclaimed once
-- the run lease lapses. `aice_id` / `event_key` mirror the customer-DB
-- `event_analysis_result` key types — no cross-database FK.
CREATE TABLE event_leaf_backfill_items (
    run_id      UUID           NOT NULL REFERENCES event_leaf_backfill_runs(id) ON DELETE CASCADE,
    aice_id     TEXT           NOT NULL,
    event_key   NUMERIC(39, 0) NOT NULL,
    status      TEXT           NOT NULL DEFAULT 'pending'
        CHECK (status IN ('pending', 'processing', 'reanalyzed',
                          'already_current', 'source_unavailable', 'failed',
                          'cap_excluded')),
    error       TEXT,
    updated_at  TIMESTAMPTZ    NOT NULL DEFAULT NOW(),
    PRIMARY KEY (run_id, aice_id, event_key)
);

-- Drain loop reads pending items for the active run; also serves the
-- stale-`processing` reclaim scan.
CREATE INDEX event_leaf_backfill_items_unfinished_idx
    ON event_leaf_backfill_items (run_id, status)
    WHERE status IN ('pending', 'processing');

-- ---------------------------------------------------------------
-- report_variant_refresh_runs / report_variant_refresh_items (#469)
-- ---------------------------------------------------------------
-- Operator-triggered report-variant refresh: bumps the `generation` of
-- scoped `periodic_report_job` variants (the force-regenerate
-- primitive) so the existing report worker re-aggregates freshly
-- re-analyzed leaves. No background worker — a refresh run executes
-- synchronously at confirm-time; these tables persist the run and its
-- per-variant outcomes so the refreshed-vs-skipped breakdown survives
-- across requests (no silent caps).
CREATE TABLE report_variant_refresh_runs (
    id                       UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
    customer_id              UUID         NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
    -- Target the refreshed variants are keyed under.
    lang                     TEXT         NOT NULL,
    model_name               TEXT         NOT NULL,
    model                    TEXT         NOT NULL,
    -- Optional timezone-variant scope; NULL = all timezone variants
    -- within the recent window.
    tz                       TEXT,
    -- Enqueue-recency window: which report buckets are in scope, frozen
    -- at creation. DISTINCT from the per-variant drain-gate window,
    -- which is derived from each variant's period.
    window_days              INT          NOT NULL,
    window_start             TIMESTAMPTZ  NOT NULL,
    window_end               TIMESTAMPTZ  NOT NULL,
    -- The periods in scope (subset of LIVE/DAILY/WEEKLY/MONTHLY).
    periods                  TEXT[]       NOT NULL,
    -- Optional per-run cap on variants actually refreshed; variants
    -- beyond the cap are reported as `limited`.
    max_variants             INT,
    -- Synchronous: completes (or fails) within the creating request;
    -- `running` is the brief in-flight state.
    status                   TEXT         NOT NULL DEFAULT 'running'
        CHECK (status IN ('running', 'completed', 'failed')),
    -- Aggregate per-variant outcome counts.
    total_variants           INT          NOT NULL DEFAULT 0,
    refreshed_count          INT          NOT NULL DEFAULT 0,
    capped_count             INT          NOT NULL DEFAULT 0,
    gated_count              INT          NOT NULL DEFAULT 0,
    already_queued_count     INT          NOT NULL DEFAULT 0,
    source_unavailable_count INT          NOT NULL DEFAULT 0,
    limited_count            INT          NOT NULL DEFAULT 0,
    error_message            TEXT,
    created_by               UUID,
    created_at               TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    finished_at              TIMESTAMPTZ
);

CREATE INDEX report_variant_refresh_runs_customer_idx
    ON report_variant_refresh_runs (customer_id, created_at DESC);

-- One row per scoped report variant the run evaluated. The variant
-- columns mirror the `periodic_report_job` PK; no FK because a variant
-- the run only seeds may have no job row yet at eval time.
-- `window_start` / `window_end` are the per-variant ANCHORED
-- aggregation window the drain gate checked (NOT the run's enqueue
-- window), so the gate decision is auditable per variant.
CREATE TABLE report_variant_refresh_items (
    run_id        UUID        NOT NULL REFERENCES report_variant_refresh_runs(id) ON DELETE CASCADE,
    period        TEXT        NOT NULL,
    bucket_date   DATE        NOT NULL,
    tz            TEXT        NOT NULL,
    lang          TEXT        NOT NULL,
    model_name    TEXT        NOT NULL,
    model         TEXT        NOT NULL,
    category      TEXT        NOT NULL
        CHECK (category IN ('refreshed', 'capped', 'gated', 'already_queued',
                            'source_unavailable', 'limited')),
    -- The variant generation after a refresh (the bumped value), or
    -- NULL for a non-refreshed outcome.
    generation    INT,
    window_start  TIMESTAMPTZ NOT NULL,
    window_end    TIMESTAMPTZ NOT NULL,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (run_id, period, bucket_date, tz, lang, model_name, model)
);

CREATE INDEX report_variant_refresh_items_category_idx
    ON report_variant_refresh_items (run_id, category);

-- ---------------------------------------------------------------
-- event_analysis_job (#493)
-- ---------------------------------------------------------------
-- Individual baseline-event auto-analysis job lifecycle (RFC 0002
-- amendment #489) — the event-grain analog of `story_analysis_job`.
-- Grain `(customer_id, aice_id, event_key, lang, model_name, model)`;
-- `aice_id := baseline_event.source_aice_id` at seed time, consistent
-- with `event_analysis_result.aice_id`.
--
-- `baseline_version` carries the EXACT version ingested at enqueue so
-- the precise `baseline_event.raw_event` can be reloaded for analysis;
-- the dedup-against-the-live-leaf rule keeps a rebaseline from
-- re-analyzing.
--
-- Budget accounting (per-customer daily cap):
--   * `selection_tier` — `tier_a` (IOC hit; uncapped) | `tier_b`
--     (budget-gated). NULL means HELD (no conclusive enrichment
--     verdict yet); held rows never inflate the tier-B count.
--   * `budget_day` — the customer-tz calendar day the row was seeded
--     into, stamped at seed (UTC timestamps cannot re-derive it).
--   * The cap is a SEED-TIME RESERVATION: COUNT(*) of tier_b rows on
--     the day whose `status <> 'budget_skipped'`. `budget_skipped` is
--     the TERMINAL tier-B overflow status — queryable, never retried.
--   * `event_time` / `received_at` carry the source ordering keys so
--     pickup ORDER BY follows neutral chronological order.
--
-- Unlike `story_analysis_job` (which cascades through its state
-- parent), this table has no per-event state parent, so it references
-- `customers(id)` DIRECTLY — without the cascade a deleted customer
-- would leave orphaned rows the worker keeps picking and failing on.
CREATE TABLE event_analysis_job (
    customer_id           UUID           NOT NULL
        REFERENCES customers(id) ON DELETE CASCADE,
    aice_id               TEXT           NOT NULL,
    event_key             NUMERIC(39, 0) NOT NULL,
    lang                  TEXT           NOT NULL,
    model_name            TEXT           NOT NULL,
    model                 TEXT           NOT NULL,
    status                TEXT           NOT NULL
        CHECK (status IN ('queued', 'processing', 'done', 'failed',
                          'budget_skipped')),
    -- NULL = held (awaiting enrichment / classification); see header.
    selection_tier        TEXT
        CHECK (selection_tier IS NULL
               OR selection_tier IN ('tier_a', 'tier_b')),
    budget_day            DATE           NOT NULL,
    baseline_version      TEXT           NOT NULL,
    event_time            TIMESTAMPTZ    NOT NULL,
    received_at           TIMESTAMPTZ    NOT NULL,
    generation            INT            NOT NULL DEFAULT 1,
    dry_run               BOOLEAN        NOT NULL DEFAULT FALSE,
    created_at            TIMESTAMPTZ    NOT NULL DEFAULT NOW(),
    processing_started_at TIMESTAMPTZ,
    last_generated_at     TIMESTAMPTZ,
    force_requested_at    TIMESTAMPTZ,
    force_requested_by    UUID,
    attempts              INT            NOT NULL DEFAULT 0,
    last_error            TEXT,
    updated_at            TIMESTAMPTZ    NOT NULL DEFAULT NOW(),
    PRIMARY KEY (customer_id, aice_id, event_key, lang, model_name, model)
);

-- Backs the queued-job pickup ORDER BY (neutral chronological order
-- under a low daily cap rather than an arbitrary key order).
CREATE INDEX event_analysis_job_queued_idx
    ON event_analysis_job (event_time, received_at, aice_id, event_key)
    WHERE status = 'queued';

-- Backs the per-`(customer_id, budget_day)` tier-B reservation
-- COUNT(*); partial on the exact predicate the reservation evaluates.
CREATE INDEX event_analysis_job_budget_idx
    ON event_analysis_job (customer_id, budget_day)
    WHERE selection_tier = 'tier_b' AND status <> 'budget_skipped';

-- ---------------------------------------------------------------
-- customer_baseline_analysis_cap (#493)
-- ---------------------------------------------------------------
-- Per-customer override for the tier-B baseline auto-analysis daily
-- cap, resolved through the same three tiers as the default model
-- (`resolveBaselineDailyCap`): this table → `system_settings` →
-- env fallback. One OPTIONAL row per customer; absence means "no
-- override". `daily_cap = 0` disables tier B entirely (tier A is
-- uncapped regardless).
CREATE TABLE customer_baseline_analysis_cap (
  customer_id  UUID         PRIMARY KEY REFERENCES customers(id) ON DELETE CASCADE,
  daily_cap    INT          NOT NULL CHECK (daily_cap >= 0),
  updated_at   TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  updated_by   UUID         NOT NULL
);

-- ---------------------------------------------------------------
-- customer_groups (RFC 0004)
-- ---------------------------------------------------------------
-- A customer group is a `kind='group'` subject aggregating >= 2 member
-- customers; the subtype shares its UUID with its `subjects` row.
-- `kind` is a constant structural guard: together with the composite FK
-- onto `subjects (id, kind)` it makes "this subject is a group"
-- provable at the DB level. `created_by` is IMMUTABLE (trigger below);
-- `owner_id` is the single, MUTABLE owner (ownership transfer, #510).
-- `tz` is the group's report bucket timezone, pinned against later
-- member-tz changes.
--
-- `database_status` mirrors the per-customer provisioning lifecycle
-- 1:1 for the group's own dedicated data DB ('provisioning' →
-- 'active' | 'failed'); `wrapped_dek` is the Transit-wrapped per-group
-- DEK. `lifecycle_status` is DISTINCT from it: it tracks whether report
-- GENERATION is running (`active`) or paused (`suspended`) because a
-- member customer is not operational — a suspended group keeps its
-- database and existing reports.
CREATE TABLE customer_groups (
    id              UUID         PRIMARY KEY,
    kind            TEXT         NOT NULL DEFAULT 'group'
                    CHECK (kind = 'group'),
    name            TEXT         NOT NULL,
    description     TEXT,
    created_by      UUID         NOT NULL REFERENCES accounts(id),
    owner_id        UUID         NOT NULL REFERENCES accounts(id),
    tz              TEXT         NOT NULL,
    created_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    database_status TEXT         NOT NULL DEFAULT 'provisioning'
                    CHECK (database_status IN ('provisioning', 'active', 'failed')),
    wrapped_dek     TEXT,
    lifecycle_status TEXT        NOT NULL DEFAULT 'active'
                    CHECK (lifecycle_status IN ('active', 'suspended')),
    -- The subtype can only attach to a group-kind subject. Deleting the
    -- subject cascades the group subtype away (entity-level delete).
    CONSTRAINT customer_groups_id_kind_subject_fkey
        FOREIGN KEY (id, kind) REFERENCES subjects(id, kind) ON DELETE CASCADE
);

-- ---------------------------------------------------------------
-- customer_group_members
-- ---------------------------------------------------------------
-- Membership is IMMUTABLE after creation: there is no add/remove API
-- and create is the only writer (UPDATE is blocked by a trigger below;
-- DELETE must remain allowed so the subject-delete cascade works). A
-- customer may belong to multiple groups (flat, no nesting).
CREATE TABLE customer_group_members (
    group_id    UUID NOT NULL REFERENCES customer_groups(id) ON DELETE CASCADE,
    customer_id UUID NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
    PRIMARY KEY (group_id, customer_id)
);

CREATE INDEX customer_group_members_customer_idx
    ON customer_group_members (customer_id);

-- ---------------------------------------------------------------
-- group_retention_policy
-- ---------------------------------------------------------------
-- Per-group analysis-retention policy, a subject-keyed peer of
-- `customer_retention_policy` living in the auth DB (NOT the group data
-- DB). Groups aggregate member data and do not ingest directly, so
-- there is no `ingestion_days`. NULL `analysis_days` means "no expiry".
-- The DDL default 1095 mirrors DEFAULT_ANALYSIS_RETENTION_DAYS in
-- `src/lib/auth/retention-defaults.ts` (SQL cannot import the TS
-- constant); the runtime creation path sources the value FROM the
-- constant — this default only well-forms rows created outside it.
CREATE TABLE group_retention_policy (
    subject_id    UUID         PRIMARY KEY
                  REFERENCES subjects(id) ON DELETE CASCADE,
    analysis_days INTEGER      DEFAULT 1095
                  CHECK (analysis_days IS NULL OR analysis_days >= 30),
    updated_at    TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    updated_by    UUID         NOT NULL
);

-- ===================================================================
-- Trigger functions + triggers
-- ===================================================================

-- Enforce that membership role_id references only general-context
-- roles. An admin role in a membership would project admin permissions
-- into the general JWT, breaking auth context separation.
CREATE OR REPLACE FUNCTION check_membership_role_auth_context()
RETURNS TRIGGER AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM roles WHERE id = NEW.role_id AND auth_context = 'general'
  ) THEN
    RAISE EXCEPTION 'account_customer_memberships.role_id must reference a role with auth_context=general';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_membership_role_check
  BEFORE INSERT OR UPDATE OF role_id ON account_customer_memberships
  FOR EACH ROW EXECUTE FUNCTION check_membership_role_auth_context();

-- Same guard for invitations.
CREATE OR REPLACE FUNCTION check_invitation_role_auth_context()
RETURNS TRIGGER AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM roles WHERE id = NEW.role_id AND auth_context = 'general'
  ) THEN
    RAISE EXCEPTION 'invitations.role_id must reference a role with auth_context=general';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_invitation_role_check
  BEFORE INSERT OR UPDATE OF role_id ON invitations
  FOR EACH ROW EXECUTE FUNCTION check_invitation_role_auth_context();

-- Guard against auth_context bypass: prevent changing a role to 'admin'
-- when existing memberships or invitations reference it. Without this,
-- an attacker could create a general membership and then flip the role
-- to admin, projecting admin permissions into the general JWT.
CREATE OR REPLACE FUNCTION check_roles_auth_context_change()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW.auth_context = 'admin' AND OLD.auth_context = 'general' THEN
    IF EXISTS (
      SELECT 1 FROM account_customer_memberships WHERE role_id = NEW.id
    ) THEN
      RAISE EXCEPTION 'Cannot change auth_context to admin: role is referenced by account_customer_memberships';
    END IF;
    IF EXISTS (
      SELECT 1 FROM invitations WHERE role_id = NEW.id
    ) THEN
      RAISE EXCEPTION 'Cannot change auth_context to admin: role is referenced by invitations';
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_roles_auth_context_guard
  BEFORE UPDATE OF auth_context ON roles
  FOR EACH ROW EXECUTE FUNCTION check_roles_auth_context_change();

-- Every customer is a `kind='customer'` subject sharing its UUID. The
-- application's `createCustomer()` path inserts the `subjects` row
-- explicitly first, but the invariant must hold for EVERY insert path —
-- including raw `INSERT INTO customers` fixtures/seeds. This
-- BEFORE-INSERT trigger materializes the supertype row in the same
-- transaction (`NEW.id` is already populated — column DEFAULTs run
-- before BEFORE-row triggers). `ON CONFLICT DO NOTHING` makes it a
-- no-op when the subject already exists, but DO NOTHING would also
-- silently keep a pre-existing subject of a DIFFERENT kind — re-check
-- after the upsert and reject that case (#503).
CREATE FUNCTION ensure_customer_subject() RETURNS trigger AS $$
BEGIN
    INSERT INTO subjects (id, kind)
    VALUES (NEW.id, 'customer')
    ON CONFLICT (id) DO NOTHING;
    IF NOT EXISTS (
        SELECT 1 FROM subjects
         WHERE id = NEW.id AND kind = 'customer'
    ) THEN
        RAISE EXCEPTION
            'customer % cannot be backed by a non-customer subject',
            NEW.id
            USING ERRCODE = 'integrity_constraint_violation';
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER customers_ensure_subject
    BEFORE INSERT ON customers
    FOR EACH ROW EXECUTE FUNCTION ensure_customer_subject();

-- The insert trigger guards customer *creation*, but `subjects.kind` is
-- mutable (UPDATE is granted), so keep `kind` immutable for any subject
-- that has a `customers` subtype row: such a subject is a customer by
-- definition and can only stop being one by deleting the customer
-- (which cascades the subject away). A subject with no customer subtype
-- (e.g. `kind='group'`) is unaffected.
CREATE FUNCTION subjects_protect_customer_kind() RETURNS trigger AS $$
BEGIN
    IF NEW.kind IS DISTINCT FROM OLD.kind
       AND EXISTS (SELECT 1 FROM customers WHERE id = NEW.id) THEN
        RAISE EXCEPTION
            'subject % backs a customer and cannot change kind from % to %',
            NEW.id, OLD.kind, NEW.kind
            USING ERRCODE = 'integrity_constraint_violation';
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER subjects_protect_customer_kind
    BEFORE UPDATE OF kind ON subjects
    FOR EACH ROW EXECUTE FUNCTION subjects_protect_customer_kind();

-- Customer-timezone-change archive: when an admin runs `UPDATE
-- customers SET timezone = 'X'`, every `periodic_report_state` row
-- whose `tz` no longer matches is archived automatically; new-tz rows
-- are seeded lazily by the reconcile scan. A trigger (rather than an
-- SQL helper on the admin path) keeps the archive correct even if a
-- future code path forgets to call the helper. The customer's
-- `subject_id == id`, so the join key matches the periodic rows for
-- that same UUID.
CREATE OR REPLACE FUNCTION fn_archive_periodic_states_on_tz_change()
RETURNS TRIGGER AS $$
BEGIN
  UPDATE periodic_report_state
     SET status = 'archived', updated_at = NOW()
   WHERE subject_id = NEW.id
     AND tz <> NEW.timezone
     AND status <> 'archived';
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_archive_periodic_states_on_tz_change
  AFTER UPDATE OF timezone ON customers
  FOR EACH ROW
  WHEN (NEW.timezone IS DISTINCT FROM OLD.timezone)
  EXECUTE FUNCTION fn_archive_periodic_states_on_tz_change();

-- Block UPDATE of `customer_group_members` entirely (membership is
-- immutable). DELETE is intentionally still allowed so the delete
-- cascade works.
CREATE FUNCTION customer_group_members_block_update() RETURNS trigger AS $$
BEGIN
    RAISE EXCEPTION
        'customer_group_members is immutable; membership cannot be edited'
        USING ERRCODE = 'integrity_constraint_violation';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER customer_group_members_no_update
    BEFORE UPDATE ON customer_group_members
    FOR EACH ROW EXECUTE FUNCTION customer_group_members_block_update();

-- Block UPDATE of `customer_groups.created_by` (it records the creator
-- and never changes). `owner_id` is deliberately NOT locked — #510
-- updates it on transfer.
CREATE FUNCTION customer_groups_protect_created_by() RETURNS trigger AS $$
BEGIN
    IF NEW.created_by IS DISTINCT FROM OLD.created_by THEN
        RAISE EXCEPTION
            'customer_groups.created_by is immutable'
            USING ERRCODE = 'integrity_constraint_violation';
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER customer_groups_protect_created_by
    BEFORE UPDATE OF created_by ON customer_groups
    FOR EACH ROW EXECUTE FUNCTION customer_groups_protect_created_by();

-- ===================================================================
-- Runtime-role grants (aimer_auth)
-- ===================================================================
-- Role creation is handled by infra/postgres/init-databases.sql
-- (Docker entrypoint); this file only assigns grants.

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

-- Roles and permissions: read-only at runtime. Mutations go through
-- the owner role (admin operations). This prevents auth_context bypass
-- via role UPDATE.
GRANT SELECT ON roles, role_permissions TO aimer_auth;

-- Sequence access for the SERIAL columns above. Scoped to the named
-- sequences rather than a blanket ALL-SEQUENCES grant.
GRANT USAGE, SELECT ON SEQUENCE
  roles_id_seq,
  aice_environments_id_seq,
  trust_registry_id_seq
TO aimer_auth;

GRANT SELECT, INSERT, DELETE ON phase2_consumed_jtis TO aimer_auth;
GRANT SELECT, INSERT, DELETE ON customer_redaction_ranges TO aimer_auth;
GRANT SELECT, INSERT, UPDATE, DELETE ON customer_retention_policy TO aimer_auth;
GRANT SELECT, INSERT, UPDATE, DELETE ON redaction_jobs TO aimer_auth;
GRANT SELECT, INSERT, UPDATE, DELETE ON redaction_job_items TO aimer_auth;
GRANT SELECT, INSERT, UPDATE, DELETE ON pending_analysis_requests TO aimer_auth;
GRANT SELECT, INSERT, UPDATE, DELETE ON story_analysis_state TO aimer_auth;
GRANT SELECT, INSERT, UPDATE, DELETE ON story_analysis_job TO aimer_auth;
GRANT SELECT, INSERT, UPDATE, DELETE ON periodic_report_state TO aimer_auth;
GRANT SELECT, INSERT, UPDATE, DELETE ON periodic_report_job TO aimer_auth;
GRANT SELECT, INSERT, DELETE ON customer_owned_domains TO aimer_auth;
GRANT SELECT, INSERT, UPDATE, DELETE ON customer_default_model TO aimer_auth;
GRANT SELECT, INSERT, UPDATE, DELETE ON event_leaf_backfill_runs TO aimer_auth;
GRANT SELECT, INSERT, UPDATE, DELETE ON event_leaf_backfill_items TO aimer_auth;
GRANT SELECT, INSERT, UPDATE, DELETE ON report_variant_refresh_runs TO aimer_auth;
GRANT SELECT, INSERT, UPDATE, DELETE ON report_variant_refresh_items TO aimer_auth;
GRANT SELECT, INSERT, UPDATE, DELETE ON event_analysis_job TO aimer_auth;
GRANT SELECT, INSERT, UPDATE, DELETE ON customer_baseline_analysis_cap TO aimer_auth;
GRANT SELECT, INSERT, UPDATE, DELETE ON subjects TO aimer_auth;
GRANT SELECT, INSERT, UPDATE, DELETE ON customer_groups TO aimer_auth;
-- No UPDATE grant: membership is immutable. SELECT/INSERT/DELETE only.
GRANT SELECT, INSERT, DELETE ON customer_group_members TO aimer_auth;
GRANT SELECT, INSERT, UPDATE, DELETE ON group_retention_policy TO aimer_auth;

-- ===================================================================
-- Seeds
-- ===================================================================

-- Built-in roles
INSERT INTO roles (name, auth_context, description, is_builtin, mfa_required) VALUES
  ('System Administrator', 'admin',   'System-wide management: accounts, environments, trust registry, settings', true, true),
  ('User',                 'general', 'Basic AI analysis access within assigned customers',                        true, false),
  ('Manager',              'general', 'Customer settings and user management within assigned customers',            true, false),
  ('Analyst',              'general', 'Advanced AI analysis for internal analysts',                                 true, false);

-- System Administrator permissions (admin context). The
-- customer-scoped keys (customer-redaction-ranges / customer-retention
-- / customer-owned-domains / customer-default-model) are seeded here
-- even though the admin context routes through authorizeAdmin without
-- a membership check, so admin-context management surfaces can rely on
-- the same permission keys as the general-context routes.
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
  ('system-settings:read'), ('system-settings:write'),
  ('customer-redaction-ranges:read'), ('customer-redaction-ranges:write'),
  ('customer-retention:read'), ('customer-retention:write'),
  ('customer-owned-domains:read'), ('customer-owned-domains:write'),
  ('customer-default-model:read'), ('customer-default-model:write'),
  ('ti-feed:read'), ('ti-feed:write')
) AS p(permission)
WHERE r.name = 'System Administrator';

-- User permissions (general context). Read access on the
-- redaction-range / retention / owned-domain surfaces extends to User
-- and Analyst, which is why those have dedicated keys instead of
-- reusing the Manager-only `customer-settings:*`.
INSERT INTO role_permissions (role_id, permission)
SELECT r.id, p.permission
FROM roles r,
LATERAL (VALUES
  ('workspace:read'), ('workspace:select'),
  ('analyses:read'), ('analyses:create'),
  ('reports:read'), ('reports:export'),
  ('dashboard:read'),
  ('customer-redaction-ranges:read'),
  ('customer-retention:read'),
  ('customer-owned-domains:read')
) AS p(permission)
WHERE r.name = 'User';

-- Manager permissions (general context, includes User base plus the
-- write halves of the customer-settings surfaces).
INSERT INTO role_permissions (role_id, permission)
SELECT r.id, p.permission
FROM roles r,
LATERAL (VALUES
  ('workspace:read'), ('workspace:select'),
  ('analyses:read'), ('analyses:create'),
  ('reports:read'), ('reports:export'),
  ('dashboard:read'),
  ('customer-settings:read'), ('customer-settings:write'),
  ('customer-members:read'), ('customer-members:write'),
  ('customer-redaction-ranges:read'), ('customer-redaction-ranges:write'),
  ('customer-retention:read'), ('customer-retention:write'),
  ('customer-owned-domains:read'), ('customer-owned-domains:write')
) AS p(permission)
WHERE r.name = 'Manager';

-- Analyst permissions (general context, includes User base). The
-- per-customer default-model keys are analyst-facing (#473): seeded
-- ONLY to Analyst and System Administrator — Manager and User receive
-- neither and cannot view or change the per-customer default.
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
  ('dashboard:customize'),
  ('customer-redaction-ranges:read'),
  ('customer-retention:read'),
  ('customer-owned-domains:read'),
  ('customer-default-model:read'), ('customer-default-model:write')
) AS p(permission)
WHERE r.name = 'Analyst';
