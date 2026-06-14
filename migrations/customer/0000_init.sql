-- customer_db first-version schema (#535).
--
-- Single collapsed schema file applied to every per-customer database.
-- aimer-web is pre-release: dev databases are reset on schema changes,
-- so this file is edited in place until the first release. Post-release
-- changes append numbered migrations starting at 0001 (see
-- migrations/README.md).
--
-- Storage model (RFC 0001): redacted plaintext + encrypted map. Event
-- content is stored as redacted JSONB; the original values live only in
-- the per-event encrypted redaction map. Phase 2 ingest tables (RFC
-- 0002 §5) are plaintext columns relying on DB/disk-level encryption —
-- the plaintext shape enables the range scans, joins and filters the
-- reports need.
--
-- Organization: extensions → tables (with their indexes, in FK
-- dependency order) → runtime-role grants.

CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- ---------------------------------------------------------------
-- detection_events — per-event redacted ingest rows (Phase 1)
-- ---------------------------------------------------------------
-- The UNIQUE (aice_id, event_key) guard backs the ingestion dedup
-- short-circuit.
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
-- baseline_event (RFC 0002 §5)
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
--
-- The empty-string DEFAULT on redaction_policy_version is part of the
-- final schema: a row carrying '' is read as "stale, needs
-- reprocessing" by the retroactive re-redact job — distinct from any
-- valid `engine:<semver>|ranges:<sha256-short>` value, so the
-- staleness oracle works. The column stays NOT NULL throughout; the
-- default never silently shadows a missing value. (Same on
-- story_member / policy_event below.)
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
    redaction_policy_version TEXT     NOT NULL DEFAULT '',
    PRIMARY KEY (baseline_version, event_key)
);

CREATE INDEX baseline_event_event_time_idx ON baseline_event (event_time);
CREATE INDEX baseline_event_kind_idx ON baseline_event (kind);
CREATE INDEX baseline_event_category_idx ON baseline_event (category);
CREATE INDEX baseline_event_primary_asset_idx ON baseline_event (primary_asset);
CREATE INDEX baseline_event_raw_score_idx ON baseline_event (raw_score);
CREATE INDEX baseline_event_event_key_idx ON baseline_event (event_key);

-- Retention sweep clock column + map cascade NOT EXISTS lookup
-- (keyed on (source_aice_id, event_key)).
CREATE INDEX idx_baseline_event_received_at
    ON baseline_event (received_at);
CREATE INDEX idx_baseline_event_source_aice_id_event_key
    ON baseline_event (source_aice_id, event_key);

-- ---------------------------------------------------------------
-- story / story_member (RFC 0002 §5)
-- ---------------------------------------------------------------
-- story.known_ioc_hit is the enrichment-derived floor input for the
-- canonical version; `false` is the signal-absent state and the
-- enrichment worker flips it via a column-scoped UPDATE grant. story
-- holds only aggregate JSONB (not redacted in v1) and intentionally
-- carries no redaction_policy_version.
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

-- Retention sweep clock column + map cascade parent join.
CREATE INDEX idx_story_received_at
    ON story (received_at);
CREATE INDEX idx_story_source_aice_id
    ON story (source_aice_id);

CREATE TABLE story_member (
    story_id            BIGINT        NOT NULL,
    story_version       TEXT          NOT NULL,
    member_event_key    NUMERIC(39, 0) NOT NULL,
    role                TEXT          NOT NULL CHECK (role IN ('primary', 'context')),
    event               JSONB         NOT NULL,
    redaction_policy_version TEXT     NOT NULL DEFAULT '',
    PRIMARY KEY (story_id, story_version, member_event_key),
    FOREIGN KEY (story_id, story_version) REFERENCES story (story_id, story_version) ON DELETE CASCADE
);

-- ---------------------------------------------------------------
-- policy_run / policy_event (RFC 0002 §5)
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

-- Retention sweep clock column + map cascade parent join.
CREATE INDEX idx_policy_run_received_at
    ON policy_run (received_at);
CREATE INDEX idx_policy_run_source_aice_id
    ON policy_run (source_aice_id);

-- policy_event intentionally omits raw_score / selector_tags /
-- window_signals — corpus B on aice-web-next is policy-mode only and
-- does not store baseline-centric snapshots. Aimer-web can join
-- against baseline_event by event_key (supported by
-- baseline_event_event_key_idx above) for baseline enrichment.
--
-- orig_addr / resp_addr are TEXT (not INET) so they can hold redacted
-- tokens like <<REDACTED_IP_001>> that the INET type would reject.
CREATE TABLE policy_event (
    run_id              BIGINT        NOT NULL,
    event_key           NUMERIC(39, 0) NOT NULL,
    event_time          TIMESTAMPTZ   NOT NULL,
    kind                TEXT          NOT NULL,
    sensor              TEXT,
    orig_addr           TEXT,
    orig_port           INTEGER,
    resp_addr           TEXT,
    resp_port           INTEGER,
    proto               INTEGER,
    host                TEXT,
    dns_query           TEXT,
    uri                 TEXT,
    category            TEXT,
    policy_triage_snapshot JSONB     NOT NULL,
    redaction_policy_version TEXT    NOT NULL DEFAULT '',
    PRIMARY KEY (run_id, event_key),
    FOREIGN KEY (run_id) REFERENCES policy_run (run_id) ON DELETE CASCADE
);

CREATE INDEX policy_event_event_time_idx ON policy_event (event_time);
CREATE INDEX policy_event_kind_idx ON policy_event (kind);
CREATE INDEX policy_event_category_idx ON policy_event (category);

-- ---------------------------------------------------------------
-- event_redaction_map (RFC 0001 §"SQL schemas — new tables")
-- ---------------------------------------------------------------
-- One row per ingested event, shared across all ingestion paths.
-- The PK columns mirror the Phase 1 column name `aice_id`; Phase 2
-- tables call the same logical value `source_aice_id` (engine code
-- joins through the parent table when reading story_member /
-- policy_event). See the header comment in
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
-- One row per (aice_id, event_key, lang, model_name, model,
-- generation). Re-analysis stamps `superseded_at` on the prior
-- generation and INSERTs a fresh `generation = N+1` row; both read
-- paths select the latest non-superseded row for the variant, and
-- periodic-report citations pin the exact generation they aggregated.
--
-- `origin` distinguishes auto-baseline rows (#493) from the manual
-- synchronous path; `requested_by` is nullable because the auto path
-- has no human requester (the worker is attributed via the audit actor
-- instead, matching the `story_analysis_result.requested_by` precedent).
CREATE TABLE event_analysis_result (
    aice_id                  TEXT           NOT NULL,
    event_key                NUMERIC(39, 0) NOT NULL,
    lang                     TEXT           NOT NULL,
    -- Bilingual marker (#581), same semantics as
    -- `periodic_report_result.restoration_lang`: NULL on a natively
    -- generated row (English canonical or a legacy English-only row);
    -- 'ENGLISH' on a row translated from the English canonical. The
    -- reader replays the canonical's redaction tokens at this language
    -- and the row's numeric scores / tier / TTP are copied verbatim from
    -- the canonical, so they stay byte-identical across the language pair.
    restoration_lang         TEXT,
    model_name               TEXT           NOT NULL,
    model                    TEXT           NOT NULL,
    model_actual_version     TEXT           NOT NULL,
    prompt_version           TEXT           NOT NULL,
    severity_score           DOUBLE PRECISION NOT NULL,    -- 0.0–1.0; "if real, how bad" (impact, blast radius)
    likelihood_score         DOUBLE PRECISION NOT NULL,    -- 0.0–1.0; "how likely this is a real threat"
    severity_factors         JSONB          NOT NULL DEFAULT '[]',   -- short noun phrases articulating severity_score; see RFC 0002 §"Score factor articulation"
    likelihood_factors       JSONB          NOT NULL DEFAULT '[]',   -- same shape, articulating likelihood_score
    ttp_tags                 JSONB          NOT NULL DEFAULT '[]',   -- validated MITRE ATT&CK technique IDs; see RFC 0002 §"MITRE ATT&CK TTP tagging"
    cve_refs                 JSONB          NOT NULL DEFAULT '[]',   -- RFC 0005 — validated + enriched CVE refs (the ttp_tags analogue); each element is a structured record (CVSS/KEV/EPSS/summary/in-the-wild + sources), not a bare id. Event PROMOTES the LLM's threat_classification.cve_numbers here.
    cve_status               TEXT
        CHECK (cve_status IN ('complete', 'partial', 'unknown', 'stale')),   -- RFC 0005 Scope 3a — CVE coverage status, mirroring coverage_status. NULL = CVE path did not run (feature inactive); 'complete' = authoritative (a zero result is a confirmed no-match); 'unknown'/'stale' = degraded (a catalog was unavailable/stale)
    priority_tier            TEXT NOT NULL
        CHECK (priority_tier IN ('CRITICAL', 'HIGH', 'MEDIUM', 'LOW')),   -- derived via 4x4 matrix; see RFC 0002 §"Priority tiering"
    analysis_text            TEXT           NOT NULL,
    event_time               TIMESTAMPTZ    NOT NULL,    -- upstream event instant (analyze input / baseline_event.event_time); titles the event on user-facing lists (#552)
    kind                     TEXT,                       -- upstream event kind (__typename); present on the auto-baseline path (baseline_event.kind), NULL on the manual path (#552)
    redaction_policy_version TEXT           NOT NULL,
    requested_by             UUID,
    requested_at             TIMESTAMPTZ    NOT NULL DEFAULT NOW(),
    generation               INT            NOT NULL DEFAULT 1,
    superseded_at            TIMESTAMPTZ,
    origin                   TEXT           NOT NULL DEFAULT 'manual'
        CHECK (origin IN ('manual', 'auto_baseline')),
    -- Translation-audit trio (#581), same semantics as the
    -- `periodic_report_job` columns: `translation_model_name` /
    -- `translation_model` hold the CONFIGURED translation-model selector
    -- the caller used for the aimer#495 `translateAnalysisNarrative` call,
    -- and `translation_prompt_version` holds that response's
    -- `promptVersion`. The response's `modelActualVersion` is intentionally
    -- NOT persisted (matching the report precedent). All three stay NULL on
    -- a native English row. Unlike reports — whose translation provenance
    -- lives on the job row — these sit on the result row because the
    -- manual/sync analyze and synchronous regenerate paths produce a
    -- translated result with no `event_analysis_job` row, so the result row
    -- is the only artifact common to every translation path.
    translation_model_name   TEXT,
    translation_model        TEXT,
    translation_prompt_version TEXT,
    PRIMARY KEY (aice_id, event_key, lang, model_name, model, generation)
);

CREATE INDEX idx_event_analysis_result_requested_at
    ON event_analysis_result (requested_at DESC);

COMMENT ON COLUMN event_analysis_result.generation IS
    'Forensic generation counter. force=true re-analysis stamps superseded_at on the prior generation and INSERTs generation = N+1 (RFC 0002 #297 round-14 item 1).';
COMMENT ON COLUMN event_analysis_result.superseded_at IS
    'Set when a newer generation supersedes this row; latest live row is superseded_at IS NULL.';

-- ---------------------------------------------------------------
-- story_analysis_result / periodic_report_result (RFC 0002)
-- ---------------------------------------------------------------
-- See RFC 0002 §"Data model additions" for the column shapes,
-- §"Priority tiering" for the matrix-derivation of `priority_tier`,
-- §"Score factor articulation" for the factor columns, and §"MITRE
-- ATT&CK TTP tagging" for the tag columns.
CREATE TABLE story_analysis_result (
    customer_id              UUID             NOT NULL,
    story_id                 BIGINT           NOT NULL,
    lang                     TEXT             NOT NULL,
    -- Language whose cited leaves the page loader replays to restore the
    -- per-story `<<REDACTED_*_E{i}_*>>` / `<<REDACTED_*_F{k}_*>>` tokens to
    -- plaintext. NULL means "replay leaves at this row's own `lang`" (the
    -- native English canonical path). A translated user-language row pins it
    -- to the English canonical's language (ENGLISH) because it copies the
    -- canonical's `input_event_refs` / `input_fact_refs` verbatim and those
    -- leaves only exist under that language (#580, mirroring the
    -- periodic_report_result column above).
    restoration_lang         TEXT,
    model_name               TEXT             NOT NULL,
    model                    TEXT             NOT NULL,
    model_actual_version     TEXT             NOT NULL,
    prompt_version           TEXT             NOT NULL,
    generation               INT              NOT NULL,
    severity_score           DOUBLE PRECISION NOT NULL,
    likelihood_score         DOUBLE PRECISION NOT NULL,
    severity_factors         JSONB            NOT NULL DEFAULT '[]',
    likelihood_factors       JSONB            NOT NULL DEFAULT '[]',
    ttp_tags                 JSONB            NOT NULL DEFAULT '[]',
    cve_refs                 JSONB            NOT NULL DEFAULT '[]',   -- RFC 0005 — validated + enriched CVE refs (the ttp_tags analogue); each element is a structured record (CVSS/KEV/EPSS/summary/in-the-wild + sources), not a bare id. Story ADDS this field.
    cve_status               TEXT
        CHECK (cve_status IN ('complete', 'partial', 'unknown', 'stale')),   -- RFC 0005 Scope 3a — CVE coverage status, mirroring coverage_status. NULL = CVE path did not run (feature inactive); 'complete' = authoritative; 'unknown'/'stale' = degraded
    priority_tier            TEXT             NOT NULL
        CHECK (priority_tier IN ('CRITICAL', 'HIGH', 'MEDIUM', 'LOW')),
    analysis_text            TEXT             NOT NULL,
    input_event_refs         JSONB            NOT NULL,
    -- RFC 0003 C1 (#440) — ordered `k -> fact_id` mapping for the
    -- `<<REDACTED_*_F{k}_*>>` fact-scope tokens carried by the redacted
    -- `enrichmentFacts` sent to aimer. Parallel to `input_event_refs`:
    -- the renderer reads it to resolve each `F{k}` back to its
    -- `story_enrichment_fact` row (and that fact's `enrichment_redaction_map`).
    -- Written for every result row alongside `input_event_refs` (`[]` when
    -- the story carried no enrichment facts); no compat default, so an
    -- omitted write fails loudly rather than silently producing a row that
    -- cannot demap `F{k}` tokens.
    input_fact_refs          JSONB            NOT NULL,
    input_hash               TEXT             NOT NULL,
    redaction_policy_version TEXT             NOT NULL,
    requested_by             UUID,
    requested_at             TIMESTAMPTZ      NOT NULL DEFAULT NOW(),
    superseded_at            TIMESTAMPTZ,
    PRIMARY KEY (customer_id, story_id, lang, model_name, model, generation)
);

CREATE INDEX story_analysis_result_requested_at_idx
    ON story_analysis_result (requested_at DESC);

CREATE INDEX story_analysis_result_story_idx
    ON story_analysis_result (customer_id, story_id);

-- Keyed on subject identity (RFC 0004 / #503): for a customer,
-- `subject_id == customer_id` (same UUID). The group data DB carries
-- the same table shape (migrations/group/0000_init.sql).
--
-- The named NOT NULL constraint on `subject_id` keeps its pre-rename
-- name: the #503 subject re-key renamed the column under the
-- constraint, which Postgres does not rename, and the collapsed schema
-- reproduces the historical chain's final state exactly.
CREATE TABLE periodic_report_result (
    subject_id                  UUID             CONSTRAINT periodic_report_result_customer_id_not_null NOT NULL,
    period                      TEXT             NOT NULL,
    bucket_date                 DATE             NOT NULL,
    tz                          TEXT             NOT NULL,
    lang                        TEXT             NOT NULL,
    -- Language whose cited leaves the page loader replays to restore the
    -- report-scope `<<REDACTED_*_R{j}_*>>` tokens to plaintext. NULL means
    -- "replay leaves at this row's own `lang`" (the native path). A
    -- translated row pins it to the English canonical's language (e.g.
    -- ENGLISH) because it copies the canonical's `input_*_refs` verbatim and
    -- the cited leaves only exist under that language (#389 PR #3 / #412).
    restoration_lang            TEXT,
    model_name                  TEXT             NOT NULL,
    model                       TEXT             NOT NULL,
    model_actual_version        TEXT             NOT NULL,
    prompt_version              TEXT             NOT NULL,
    generation                  INT              NOT NULL,
    aggregate_severity_score    DOUBLE PRECISION NOT NULL,
    aggregate_likelihood_score  DOUBLE PRECISION NOT NULL,
    aggregate_ttp_tags          JSONB            NOT NULL DEFAULT '[]',
    priority_tier               TEXT             NOT NULL
        CHECK (priority_tier IN ('CRITICAL', 'HIGH', 'MEDIUM', 'LOW')),
    sections_jsonb              JSONB            NOT NULL,
    input_event_refs            JSONB            NOT NULL,
    input_story_refs            JSONB            NOT NULL,
    input_hash                  TEXT             NOT NULL,
    input_watermark             TIMESTAMPTZ,
    redaction_policy_version    TEXT             NOT NULL,
    requested_by                UUID,
    requested_at                TIMESTAMPTZ      NOT NULL DEFAULT NOW(),
    superseded_at               TIMESTAMPTZ,
    -- Long-tail analyzed-event aggregates (#489 / #495), persisted so
    -- the non-English paths reproduce what the English native
    -- generation sent without recomputing a universe that may have
    -- drifted:
    --   * `input_exemplar_refs` — the distinct representative leaves of
    --     the kept exemplars, each `{ aice_id, event_key, generation,
    --     model_name, model }`; `generation` pins the exact immutable
    --     leaf (mirrors `input_event_refs`).
    --   * `input_analyzed_event_aggregates` — the exact
    --     `analyzedEventAggregates` object sent. NULL when the section
    --     was omitted (empty universe), keeping `computeInputHash`
    --     stable. Nullable with no default: NULL (rather than `'[]'`)
    --     is read as "no long-tail persisted".
    input_exemplar_refs             JSONB,
    input_analyzed_event_aggregates JSONB,
    PRIMARY KEY (subject_id, period, bucket_date, tz, lang, model_name, model, generation)
);

CREATE INDEX periodic_report_result_requested_at_idx
    ON periodic_report_result (requested_at DESC);

CREATE INDEX periodic_report_result_bucket_idx
    ON periodic_report_result (subject_id, period, bucket_date, tz);

-- GIN indexes for the reverse-citation lookup (T2, #396): citing
-- reports for a leaf are JSONB containment (`@>`) scans against the
-- ref columns. `jsonb_path_ops` is the operator class tuned for `@>`
-- containment — smaller and faster than the default `jsonb_ops`; it
-- only supports containment, which is exactly the query shape here.
CREATE INDEX periodic_report_result_input_event_refs_gin
    ON periodic_report_result
    USING GIN (input_event_refs jsonb_path_ops);

CREATE INDEX periodic_report_result_input_story_refs_gin
    ON periodic_report_result
    USING GIN (input_story_refs jsonb_path_ops);

CREATE INDEX story_analysis_result_input_event_refs_gin
    ON story_analysis_result
    USING GIN (input_event_refs jsonb_path_ops);

-- ---------------------------------------------------------------
-- story_enrichment_state / story_ioc_evidence (RFC 0003 P1a, #361)
-- ---------------------------------------------------------------
-- The async enrichment worker derives `known_ioc_hit` for a story's
-- canonical version, UPDATEs `story.known_ioc_hit`, and records here:
--
--   * `story_enrichment_state` — one row per canonical
--     `(story_id, story_version)` marking that enrichment ran, its
--     `coverage_status`, the derived `known_ioc_hit`, and a
--     completed-at timestamp. This row is the marker the
--     story-analysis worker's precondition checks before reading the
--     floor. Written even on zero matches, so `false-complete`
--     (enrichment ran, no hit) is distinguishable from `false-unknown`
--     (incomplete or a deterministic feed was stale/unavailable).
--
--   * `story_ioc_evidence` — one row per SURFACED match (RFC 0003
--     `EvidenceRecord` fields) so a `known_ioc_hit = true` is
--     explainable after the fact. Surfaced = floor-supporting matches
--     PLUS, per the RFC 0003 evidence-model amendment (#589, RFC 0005
--     Resolved decisions 2-3), floor-ineligible `deterministic_ioc`
--     (always) and `soft_reputation` matches that pass the
--     meaningfulness gate. Rows are distinguished by `hit_type` /
--     `floor_eligible`; only floor-supporting rows
--     (`deterministic_ioc AND floor_eligible`) explain `known_ioc_hit`,
--     the rest are evidence-only and never drive the floor. Indicators
--     are stored the same way as the rest of the redaction layer:
--     external indicators raw and customer-asset indicators as tokens,
--     both carried by `redaction_token`. A customer-asset token is
--     event-scoped, so the row also carries the `(source_aice_id,
--     member_event_key)` map key that recovers it. Linked to the
--     canonical story version, NOT to `story_analysis_result`.
--
-- Both are keyed on / FK'd to the canonical `(story_id, story_version)`
-- and cascade-delete with the story, mirroring `story_member`.
CREATE TABLE story_enrichment_state (
    story_id        BIGINT       NOT NULL,
    story_version   TEXT         NOT NULL,
    -- `complete` = enrichment ran to completion for this version (even
    -- with zero matches). `failed` = a hard error left the run
    -- incomplete; the analysis precondition keeps requeuing.
    status          TEXT         NOT NULL
        CHECK (status IN ('complete', 'failed')),
    -- RFC 0003 §"Audit / evidence model": separate from the boolean. A
    -- stale/unavailable deterministic feed yields `unknown`/`stale`,
    -- never a silent `false`.
    coverage_status TEXT         NOT NULL
        CHECK (coverage_status IN ('complete', 'partial', 'unknown', 'stale')),
    -- The derived floor input for this canonical version. Monotonic in
    -- observed hits — an unavailable source never flips a hit to false.
    known_ioc_hit   BOOLEAN      NOT NULL DEFAULT FALSE,
    completed_at    TIMESTAMPTZ,
    last_error      TEXT,
    created_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    PRIMARY KEY (story_id, story_version),
    FOREIGN KEY (story_id, story_version)
        REFERENCES story (story_id, story_version) ON DELETE CASCADE
);

CREATE TABLE story_ioc_evidence (
    id                        BIGINT       GENERATED ALWAYS AS IDENTITY
                                           PRIMARY KEY,
    story_id                  BIGINT       NOT NULL,
    story_version             TEXT         NOT NULL,
    -- The redaction-consistent indicator reference: the raw value for an
    -- external indicator, or a `<<REDACTED_*_NNN>>` token for a
    -- customer-asset indicator (whose original lives only in the
    -- existing encrypted redaction map).
    redaction_token           TEXT         NOT NULL,
    -- The event redaction-map scope this evidence row was extracted
    -- under — i.e. the `(aice_id, event_key)` key of the
    -- `event_redaction_map` row. For a customer-asset `redaction_token`
    -- this is what makes the original recoverable: token numbering
    -- restarts per event, so the same `<<REDACTED_IP_001>>` from two
    -- members maps to different values and the token alone is
    -- ambiguous. For a raw external indicator it is provenance.
    source_aice_id            TEXT           NOT NULL,
    member_event_key          NUMERIC(39, 0) NOT NULL,
    source_policy_id          TEXT         NOT NULL,
    source_version            TEXT,
    feed_hash                 TEXT,
    source_updated_at         TIMESTAMPTZ,
    hit_type                  TEXT         NOT NULL
        CHECK (hit_type IN ('deterministic_ioc', 'soft_reputation')),
    floor_eligible            BOOLEAN      NOT NULL,
    coverage_status           TEXT
        CHECK (coverage_status IN ('complete', 'partial', 'unknown', 'stale')),
    checked_at                TIMESTAMPTZ  NOT NULL,
    expires_at                TIMESTAMPTZ,
    created_at                TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    FOREIGN KEY (story_id, story_version)
        REFERENCES story (story_id, story_version) ON DELETE CASCADE
);

CREATE INDEX story_ioc_evidence_story_idx
    ON story_ioc_evidence (story_id, story_version);

-- ---------------------------------------------------------------
-- story_enrichment_fact / enrichment_redaction_map (RFC 0003 C1, #440)
-- ---------------------------------------------------------------
-- Enrichment-fact bodies + self-scoped redaction map (RFC 0001
-- Amendment A.1, fact side). `story_enrichment_fact` is the
-- authoritative source of fact bodies; it is INDEPENDENT of
-- `story_ioc_evidence` so it can hold `soft_reputation` /
-- floor-ineligible narrative facts that have no evidence row.
-- `enrichment_redaction_map` is the self-scoped encrypted map
-- `fact_token -> { kind, value }`, keyed on `fact_id`; the encrypted
-- values carry NO story/member data (the story linkage lives on
-- `story_enrichment_fact`), so the map stays story-agnostic. Both
-- cascade-delete with the canonical story version.
CREATE TABLE story_enrichment_fact (
    fact_id                  BIGINT       GENERATED ALWAYS AS IDENTITY
                                          PRIMARY KEY,
    story_id                 BIGINT       NOT NULL,
    story_version            TEXT         NOT NULL,
    -- Redacted narrative text. Customer-asset indicators appear as
    -- self-scoped `<<REDACTED_*_NNN>>` tokens; external indicators stay
    -- raw. Prompt-build renames the self-scoped tokens to fact-scope
    -- `<<REDACTED_*_F{k}_*>>` (pure string rename, no decrypt).
    fact_text                TEXT         NOT NULL,
    -- The composite redaction policy version the fact was redacted
    -- under (engine + ranges + owned-domains hash), for audit / drift
    -- parity with the member-side `redaction_policy_version`.
    redaction_policy_version TEXT         NOT NULL,
    created_at               TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    FOREIGN KEY (story_id, story_version)
        REFERENCES story (story_id, story_version) ON DELETE CASCADE
);

CREATE INDEX story_enrichment_fact_story_idx
    ON story_enrichment_fact (story_id, story_version);

CREATE TABLE enrichment_redaction_map (
    fact_id     BIGINT       NOT NULL,
    ciphertext  BYTEA        NOT NULL,
    wrapped_dek TEXT         NOT NULL,
    created_at  TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    updated_at  TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    PRIMARY KEY (fact_id),
    FOREIGN KEY (fact_id)
        REFERENCES story_enrichment_fact (fact_id) ON DELETE CASCADE
);

-- ---------------------------------------------------------------
-- event_enrichment_state / event_ioc_evidence (RFC 0003 ④, #492)
-- ---------------------------------------------------------------
-- Per-event IOC enrichment state + evidence — the event-grain analog
-- of the story tables above, and the tier-A prerequisite for the
-- individual baseline-event auto-analysis (RFC 0002 amendment #489).
--
-- The grain is `(source_aice_id, event_key)`, NOT a
-- baseline_version-scoped key: `event_key` recurs across
-- `baseline_version` after a rebaseline (`baseline_event` PK is
-- `(baseline_version, event_key)`), and the verdict describes the
-- logical event. There is therefore NO FK to `baseline_event`; the
-- read helper dedupes to the latest `baseline_event` row by
-- `received_at` (then `baseline_version DESC`) before extracting
-- indicators. Unlike the story path there is no `known_ioc_hit` column
-- on the source table to mirror — the verdict lives here entirely;
-- readiness (`status`) and the verdict (`known_ioc_hit` +
-- `coverage_status`) are columns of the SAME row, so the downstream
-- worker can never gate on a torn read.
CREATE TABLE event_enrichment_state (
    source_aice_id  TEXT           NOT NULL,
    event_key       NUMERIC(39, 0) NOT NULL,
    -- `complete` = enrichment ran to completion for this event (even
    -- with zero matches). `failed` = a hard error left the run
    -- incomplete; the downstream worker's precondition keeps requeuing.
    status          TEXT           NOT NULL
        CHECK (status IN ('complete', 'failed')),
    -- Separate from the boolean: a stale/unavailable deterministic
    -- feed yields `unknown`/`stale`, never a silent `false`.
    coverage_status TEXT           NOT NULL
        CHECK (coverage_status IN ('complete', 'partial', 'unknown', 'stale')),
    -- The per-event floor verdict. Monotonic in observed hits.
    known_ioc_hit   BOOLEAN        NOT NULL DEFAULT FALSE,
    completed_at    TIMESTAMPTZ,
    last_error      TEXT,
    created_at      TIMESTAMPTZ    NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ    NOT NULL DEFAULT NOW(),
    PRIMARY KEY (source_aice_id, event_key)
);

-- One row per SURFACED match, mirroring `story_ioc_evidence`
-- field-for-field minus the story linkage. Surfaced = floor-supporting
-- matches PLUS, per the RFC 0003 evidence-model amendment (#589),
-- floor-ineligible `deterministic_ioc` (always) and gate-passing
-- `soft_reputation` matches; distinguished by `hit_type` /
-- `floor_eligible`, only floor-supporting rows drive the per-event
-- verdict. (The event path has no fact channel, #489, so there are no
-- parallel facts for non-floor rows here.)
CREATE TABLE event_ioc_evidence (
    id                BIGINT         GENERATED ALWAYS AS IDENTITY
                                     PRIMARY KEY,
    source_aice_id    TEXT           NOT NULL,
    event_key         NUMERIC(39, 0) NOT NULL,
    redaction_token   TEXT           NOT NULL,
    source_policy_id  TEXT           NOT NULL,
    source_version    TEXT,
    feed_hash         TEXT,
    source_updated_at TIMESTAMPTZ,
    hit_type          TEXT           NOT NULL
        CHECK (hit_type IN ('deterministic_ioc', 'soft_reputation')),
    floor_eligible    BOOLEAN        NOT NULL,
    coverage_status   TEXT
        CHECK (coverage_status IN ('complete', 'partial', 'unknown', 'stale')),
    checked_at        TIMESTAMPTZ    NOT NULL,
    expires_at        TIMESTAMPTZ,
    created_at        TIMESTAMPTZ    NOT NULL DEFAULT NOW()
);

CREATE INDEX event_ioc_evidence_event_idx
    ON event_ioc_evidence (source_aice_id, event_key);

-- ===================================================================
-- Runtime-role grants (aimer_customer)
-- ===================================================================
-- Roles are created by infra/postgres/init-databases.sql and shared
-- across all customer DBs; this file only assigns grants.
--
-- DELETE on the ingest tables is granted for the Phase 2 mutation
-- endpoints (withdraw, refresh-window) and for retention sweeps.
--
-- The UPDATE grants are column-scoped to preserve the restricted-role
-- posture: the redaction-job worker re-stamps stale rows, so only the
-- redacted-payload columns and the policy-version column it writes are
-- exposed; operator-only columns (PKs, timestamps, FKs,
-- source_aice_id, raw_score, etc.) stay read-only. story and
-- policy_run hold no redacted columns and get no UPDATE at all —
-- except the enrichment worker's single-column
-- `UPDATE (known_ioc_hit)` on story.
GRANT SELECT, INSERT, DELETE ON detection_events TO aimer_customer;
GRANT UPDATE (redacted_event, redaction_policy_version)
    ON detection_events TO aimer_customer;

GRANT SELECT, INSERT, DELETE ON baseline_event TO aimer_customer;
GRANT UPDATE (raw_event, redaction_policy_version)
    ON baseline_event TO aimer_customer;

GRANT SELECT, INSERT, DELETE ON story TO aimer_customer;
GRANT UPDATE (known_ioc_hit) ON story TO aimer_customer;

GRANT SELECT, INSERT, DELETE ON story_member TO aimer_customer;
GRANT UPDATE (event, redaction_policy_version)
    ON story_member TO aimer_customer;

GRANT SELECT, INSERT, DELETE ON policy_run TO aimer_customer;

GRANT SELECT, INSERT, DELETE ON policy_event TO aimer_customer;
GRANT UPDATE (
    orig_addr,
    resp_addr,
    host,
    dns_query,
    uri,
    policy_triage_snapshot,
    redaction_policy_version
) ON policy_event TO aimer_customer;

-- event_redaction_map is mutated by the shared-map invariant
-- (INSERT ... ON CONFLICT DO UPDATE) and by KEK rotation;
-- event_analysis_result UPDATE is used to stamp `superseded_at`.
GRANT SELECT, INSERT, UPDATE, DELETE ON event_redaction_map TO aimer_customer;
GRANT SELECT, INSERT, UPDATE, DELETE ON event_analysis_result TO aimer_customer;

GRANT SELECT, INSERT, UPDATE, DELETE ON story_analysis_result TO aimer_customer;
GRANT SELECT, INSERT, UPDATE, DELETE ON periodic_report_result TO aimer_customer;

GRANT SELECT, INSERT, UPDATE, DELETE ON story_enrichment_state TO aimer_customer;
GRANT SELECT, INSERT, UPDATE, DELETE ON story_ioc_evidence TO aimer_customer;

GRANT SELECT, INSERT, UPDATE, DELETE ON story_enrichment_fact TO aimer_customer;
GRANT SELECT, INSERT, UPDATE, DELETE ON enrichment_redaction_map TO aimer_customer;

GRANT SELECT, INSERT, UPDATE, DELETE ON event_enrichment_state TO aimer_customer;
GRANT SELECT, INSERT, UPDATE, DELETE ON event_ioc_evidence TO aimer_customer;
