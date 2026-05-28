-- Phase 2 ingestion tables (per RFC 0002 §5).
--
-- Encryption-at-rest decision (RFC 0002 §11.1): this migration ships
-- option (c) — plaintext columns with relational integrity, relying on
-- DB-level TDE / disk-level encryption. The plaintext shape enables the
-- range scans, joins and category/kind filters Phase 2 reports need.
-- If a future security review requires column-level encryption (options
-- (a) full or (b) selective), the migration can be extended in a
-- follow-up. analysis_narrative.narrative inherits the same plaintext +
-- DB-level-TDE assumption as the source events; if column-level
-- encryption is re-introduced for ingest payloads, narratives MUST
-- follow under the same envelope.

-- ---------------------------------------------------------------
-- baseline_event
-- ---------------------------------------------------------------
-- baseline_score is NOT stored — it is a read-time
-- CUME_DIST() OVER (kind, baseline_version) per RFC 0001 §3. The exact
-- value at push time is captured in score_window_context.baseline_rank_snapshot.
--
-- event_key is NOT unique across baseline_version values — the same
-- REview event can appear under multiple baseline_versions if it
-- survives a rebaseline. The standalone event_key index supports
-- event_key-only joins from policy_event; read helpers MUST dedupe
-- with a "latest by received_at" (or equivalent) rule.
CREATE TABLE baseline_event (
    baseline_version    TEXT          NOT NULL,
    event_key           NUMERIC(39, 0) NOT NULL,
    event_time          TIMESTAMPTZ   NOT NULL,
    kind                TEXT          NOT NULL,
    category            TEXT,
    primary_asset       TEXT,
    raw_score           DOUBLE PRECISION NOT NULL,
    selector_tags       TEXT[]        NOT NULL DEFAULT '{}',
    raw_event           JSONB         NOT NULL,
    score_window_context JSONB        NOT NULL,
    window_signals      JSONB         NOT NULL,
    asset_context       JSONB,
    scoring_weights_snapshot JSONB    NOT NULL,
    source_aice_id      TEXT          NOT NULL,
    received_at         TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
    PRIMARY KEY (baseline_version, event_key)
);

CREATE INDEX baseline_event_event_time_idx ON baseline_event (event_time);
CREATE INDEX baseline_event_kind_idx ON baseline_event (kind);
CREATE INDEX baseline_event_category_idx ON baseline_event (category);
CREATE INDEX baseline_event_primary_asset_idx ON baseline_event (primary_asset);
CREATE INDEX baseline_event_raw_score_idx ON baseline_event (raw_score);
CREATE INDEX baseline_event_event_key_idx ON baseline_event (event_key);

-- ---------------------------------------------------------------
-- story / story_member
-- ---------------------------------------------------------------
CREATE TABLE story (
    story_id            BIGINT        NOT NULL,
    story_version       TEXT          NOT NULL,
    kind                TEXT          NOT NULL CHECK (kind IN ('auto_correlated', 'analyst_curated')),
    correlation_rule_id TEXT,
    primary_asset       TEXT,
    time_window_start   TIMESTAMPTZ   NOT NULL,
    time_window_end     TIMESTAMPTZ   NOT NULL,
    score               DOUBLE PRECISION,
    summary_payload     JSONB         NOT NULL,
    known_ioc_hit       BOOLEAN       NOT NULL DEFAULT FALSE,
    source_aice_id      TEXT          NOT NULL,
    received_at         TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
    PRIMARY KEY (story_id, story_version)
);

CREATE INDEX story_time_window_idx ON story (time_window_start, time_window_end);
CREATE INDEX story_primary_asset_idx ON story (primary_asset);
CREATE INDEX story_score_idx ON story (score);

CREATE TABLE story_member (
    story_id            BIGINT        NOT NULL,
    story_version       TEXT          NOT NULL,
    member_event_key    NUMERIC(39, 0) NOT NULL,
    role                TEXT          NOT NULL CHECK (role IN ('primary', 'context')),
    event               JSONB         NOT NULL,
    PRIMARY KEY (story_id, story_version, member_event_key),
    FOREIGN KEY (story_id, story_version) REFERENCES story (story_id, story_version) ON DELETE CASCADE
);

-- ---------------------------------------------------------------
-- policy_run / policy_event
-- ---------------------------------------------------------------
-- replaces is a soft reference (no FK) — the prior run may never have
-- been ingested (sender does not guarantee predecessor delivery) or
-- may have been retention-swept.
--
-- summary_stats has NO CHECK constraint on shape: a DB-level
-- jsonb_typeof = 'object' check would couple the schema to today's
-- payload variant and break forward-compat with future
-- phase2.policy_run.v1 minor extensions. The "is JSON object"
-- guarantee lives in the ingest endpoint (Zod), not this column.
CREATE TABLE policy_run (
    run_id              BIGINT        PRIMARY KEY,
    owner_account_id    UUID,
    period_start        TIMESTAMPTZ   NOT NULL,
    period_end          TIMESTAMPTZ   NOT NULL,
    created_at_source   TIMESTAMPTZ   NOT NULL,
    finalized_at_source TIMESTAMPTZ,
    baseline_version    TEXT          NOT NULL,
    policies_fingerprint   TEXT       NOT NULL,
    exclusions_fingerprint TEXT       NOT NULL,
    status              TEXT          NOT NULL CHECK (status IN ('ready', 'superseded')),
    replaces            BIGINT,
    summary_stats       JSONB,
    source_aice_id      TEXT          NOT NULL,
    received_at         TIMESTAMPTZ   NOT NULL DEFAULT NOW()
);

CREATE INDEX policy_run_created_at_idx ON policy_run (created_at_source);
CREATE INDEX policy_run_finalized_at_idx ON policy_run (finalized_at_source);
CREATE INDEX policy_run_baseline_version_idx ON policy_run (baseline_version);

-- policy_event intentionally omits raw_score / selector_tags /
-- window_signals — corpus B on aice-web-next is policy-mode only and
-- does not store baseline-centric snapshots. Aimer-web can join
-- against baseline_event by event_key (supported by
-- baseline_event_event_key_idx above) for baseline enrichment.
CREATE TABLE policy_event (
    run_id              BIGINT        NOT NULL,
    event_key           NUMERIC(39, 0) NOT NULL,
    event_time          TIMESTAMPTZ   NOT NULL,
    kind                TEXT          NOT NULL,
    sensor              TEXT,
    orig_addr           INET,
    orig_port           INTEGER,
    resp_addr           INET,
    resp_port           INTEGER,
    proto               INTEGER,
    host                TEXT,
    dns_query           TEXT,
    uri                 TEXT,
    category            TEXT,
    policy_triage_snapshot JSONB     NOT NULL,
    PRIMARY KEY (run_id, event_key),
    FOREIGN KEY (run_id) REFERENCES policy_run (run_id) ON DELETE CASCADE
);

CREATE INDEX policy_event_event_time_idx ON policy_event (event_time);
CREATE INDEX policy_event_kind_idx ON policy_event (kind);
CREATE INDEX policy_event_category_idx ON policy_event (category);

-- ---------------------------------------------------------------
-- analysis_narrative
-- ---------------------------------------------------------------
-- content_hash is computed by aimer-web at insert time as
-- hash(target_kind, target_keys, summary_payload, signals,
-- prompt_version, model_version). Insert-once semantics: every input
-- that feeds content_hash is in the hash, so any change produces a
-- new row — there is no UPDATE path. A model version bump produces a
-- new row; the old row remains until retention sweeps it.
--
-- v1 access pattern is content_hash lookup only. Reverse lookup by
-- target_keys is not supported in v1 — add CREATE INDEX
-- CONCURRENTLY ... USING GIN (target_keys) in a follow-up if needed.
--
-- No FK to target tables — narrative rows outlive their target row
-- when retention removes the source (RFC 0002 §5).
CREATE TABLE analysis_narrative (
    content_hash        TEXT          PRIMARY KEY,
    target_kind         TEXT          NOT NULL CHECK (target_kind IN ('baseline_event', 'story', 'policy_run')),
    target_keys         JSONB         NOT NULL,
    narrative           TEXT          NOT NULL,
    prompt_version      TEXT          NOT NULL,
    model_version       TEXT          NOT NULL,
    generated_at        TIMESTAMPTZ   NOT NULL DEFAULT NOW()
);

CREATE INDEX analysis_narrative_target_kind_generated_at_idx
    ON analysis_narrative (target_kind, generated_at);

-- ---------------------------------------------------------------
-- Runtime role grants
-- ---------------------------------------------------------------
-- DELETE is granted for the Phase 2 mutation endpoints (withdraw,
-- refresh-window) and for retention sweeps. analysis_narrative is
-- insert-once at the app level (no UPDATE); DELETE is granted for
-- retention sweeps and potential cache invalidation.
GRANT SELECT, INSERT, DELETE ON baseline_event TO aimer_customer;
GRANT SELECT, INSERT, DELETE ON story TO aimer_customer;
GRANT SELECT, INSERT, DELETE ON story_member TO aimer_customer;
GRANT SELECT, INSERT, DELETE ON policy_run TO aimer_customer;
GRANT SELECT, INSERT, DELETE ON policy_event TO aimer_customer;
GRANT SELECT, INSERT, DELETE ON analysis_narrative TO aimer_customer;
