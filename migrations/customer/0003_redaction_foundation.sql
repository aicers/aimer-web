-- Redaction foundation (RFC 0001 §"SQL schemas").
--
-- This migration ships the schema changes that turn the per-customer
-- DB into the storage layer for the redacted-plaintext + encrypted-map
-- model. It is intentionally schema-only: ingestion writers
-- (`src/lib/auth/event-storage.ts`, `src/app/api/phase2/_shared/ingest.ts`)
-- are updated in #251. KEK rotation is the one app-code touch
-- bundled here because it reads the column being dropped — see
-- `src/lib/auth/kek-rotation.ts`.
--
-- The Phase 1 restructure drops the encrypted batch blob (`payload`,
-- `wrapped_dek`, `event_count`) and replaces it with per-event redacted
-- JSONB. Per RFC 0001 §"Greenfield", we drop and recreate
-- `detection_events` rather than backfill batch rows.

-- ---------------------------------------------------------------
-- Phase 1 detection_events — per-event restructure
-- ---------------------------------------------------------------
DROP TABLE detection_events;

CREATE TABLE detection_events (
    id                       UUID          PRIMARY KEY DEFAULT gen_random_uuid(),
    aice_id                  TEXT          NOT NULL,
    event_key                NUMERIC(39, 0) NOT NULL,
    redacted_event           JSONB         NOT NULL,
    redaction_policy_version TEXT          NOT NULL,
    schema_version           TEXT          NOT NULL,
    payload_hash             TEXT          NOT NULL,
    source                   TEXT          NOT NULL CHECK (source IN ('bridge', 'manual')),
    connection_id            UUID,
    ingested_by              UUID          NOT NULL,
    created_at               TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
    UNIQUE (aice_id, event_key)
);

CREATE INDEX idx_detection_events_aice_id ON detection_events (aice_id);
CREATE INDEX idx_detection_events_created_at ON detection_events (created_at DESC);

-- ---------------------------------------------------------------
-- Phase 2 column changes
-- ---------------------------------------------------------------
-- policy_event.orig_addr / resp_addr: INET -> TEXT so they can hold
-- redacted tokens like <<REDACTED_IP_001>> that the INET type would
-- reject.
ALTER TABLE policy_event ALTER COLUMN orig_addr TYPE TEXT;
ALTER TABLE policy_event ALTER COLUMN resp_addr TYPE TEXT;

-- redaction_policy_version on every table that holds redacted
-- canonical content. story and policy_run hold only aggregate JSONB
-- (not redacted in v1) and are intentionally excluded.
--
-- The empty-string DEFAULT is a deliberate transition affordance.
-- This PR ships the schema; #251 wires the redaction engine into
-- the ingestion writers and supplies the real
-- `engine:<semver>|ranges:<sha256-short>` value. Between the two
-- merges, pre-#251 inserts continue to satisfy the NOT NULL
-- constraint with `''`, which the retroactive re-redact job (#253)
-- treats as "stale, needs reprocessing" — distinct from any valid
-- current policy version, so the staleness oracle still works.
-- The column stays NOT NULL throughout; the default never silently
-- shadows a missing value.
ALTER TABLE baseline_event ADD COLUMN redaction_policy_version TEXT NOT NULL DEFAULT '';
ALTER TABLE story_member   ADD COLUMN redaction_policy_version TEXT NOT NULL DEFAULT '';
ALTER TABLE policy_event   ADD COLUMN redaction_policy_version TEXT NOT NULL DEFAULT '';

-- ---------------------------------------------------------------
-- event_redaction_map (RFC 0001 §"SQL schemas — new tables")
-- ---------------------------------------------------------------
-- One row per ingested event, shared across all ingestion paths.
-- The PK columns mirror the Phase 1 column name `aice_id`; Phase 2
-- tables call the same logical value `source_aice_id` (no rename in
-- this PR — engine code joins through the parent table when reading
-- story_member / policy_event). See the header comment in
-- `src/lib/redaction/engine.ts` for the naming-gap mapping.
CREATE TABLE event_redaction_map (
    aice_id      TEXT           NOT NULL,
    event_key    NUMERIC(39, 0) NOT NULL,
    ciphertext   BYTEA          NOT NULL,
    wrapped_dek  TEXT           NOT NULL,
    created_at   TIMESTAMPTZ    NOT NULL DEFAULT NOW(),
    updated_at   TIMESTAMPTZ    NOT NULL DEFAULT NOW(),
    PRIMARY KEY (aice_id, event_key)
);

-- ---------------------------------------------------------------
-- event_analysis_result (RFC 0001 §"event_analysis_result")
-- ---------------------------------------------------------------
-- One row per (aice_id, event_key, lang, model_name, model).
-- force=true re-analysis UPSERTs on the PK. analysis_narrative is
-- not dropped in this PR; the drop lands in #254 once
-- event_analysis_result is the live cache path.
CREATE TABLE event_analysis_result (
    aice_id                  TEXT           NOT NULL,
    event_key                NUMERIC(39, 0) NOT NULL,
    lang                     TEXT           NOT NULL,
    model_name               TEXT           NOT NULL,
    model                    TEXT           NOT NULL,
    model_actual_version     TEXT,
    prompt_version           TEXT,
    severity_score           DOUBLE PRECISION NOT NULL,    -- 0.0–1.0; "if real, how bad" (impact, blast radius)
    likelihood_score         DOUBLE PRECISION NOT NULL,    -- 0.0–1.0; "how likely this is a real threat"
    severity_factors         JSONB          NOT NULL DEFAULT '[]',   -- short noun phrases articulating severity_score; see RFC 0002 §"Score factor articulation"
    likelihood_factors       JSONB          NOT NULL DEFAULT '[]',   -- same shape, articulating likelihood_score
    ttp_tags                 JSONB          NOT NULL DEFAULT '[]',   -- validated MITRE ATT&CK technique IDs; see RFC 0002 §"MITRE ATT&CK TTP tagging"
    priority_tier            TEXT NOT NULL
        CHECK (priority_tier IN ('CRITICAL', 'HIGH', 'MEDIUM', 'LOW')),   -- derived via 4x4 matrix; see RFC 0002 §"Priority tiering"
    analysis_text            TEXT           NOT NULL,
    redaction_policy_version TEXT           NOT NULL,
    requested_by             UUID           NOT NULL,
    requested_at             TIMESTAMPTZ    NOT NULL DEFAULT NOW(),
    PRIMARY KEY (aice_id, event_key, lang, model_name, model)
);

CREATE INDEX idx_event_analysis_result_requested_at
    ON event_analysis_result (requested_at DESC);

-- ---------------------------------------------------------------
-- Runtime role grants
-- ---------------------------------------------------------------
-- Phase 1 detection_events: keep SELECT, INSERT only (matches the
-- pre-restructure grant; #251 will add what its ingestion writer
-- needs).
GRANT SELECT, INSERT ON detection_events TO aimer_customer;

-- The two new tables explicitly need UPDATE: event_redaction_map is
-- mutated by the shared-map invariant (INSERT ... ON CONFLICT DO
-- UPDATE) and by KEK rotation; event_analysis_result is mutated by
-- force=true re-analysis. The "no UPDATE on Phase 2" guard in
-- customer-schema.db.test.ts:489 covers only the pre-existing Phase
-- 2 tables and is unaffected.
GRANT SELECT, INSERT, UPDATE, DELETE ON event_redaction_map TO aimer_customer;
GRANT SELECT, INSERT, UPDATE, DELETE ON event_analysis_result TO aimer_customer;
