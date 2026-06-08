-- RFC 0003 consumer ④ (#492) — per-event IOC enrichment state + evidence
-- (customer DB). The event-grain analog of 0010's story tables.
--
-- This is the tier-A prerequisite for RFC 0002's individual baseline-event
-- auto-analysis (amendment, #489): a loose `baseline_event` not belonging
-- to any story gets a deterministic per-`(source_aice_id, event_key)` IOC
-- verdict the downstream auto-analysis worker gates on. The IOC-matching
-- machinery is reused from the story path (`enrichment-worker.ts`); only
-- the input-read shape differs (indicators come from the stored, redacted
-- `baseline_event.raw_event`, not `story_member` + `policy_event`).
--
--   * `event_enrichment_state` — one row per `(source_aice_id, event_key)`
--     marking that enrichment ran, its `coverage_status`, the derived
--     `known_ioc_hit` verdict, and a completed-at timestamp. Written even
--     on zero matches, so `false-complete` (enrichment ran, clean miss) is
--     distinguishable from `false-unknown` (a deterministic feed was
--     stale/unavailable). Unlike the story path there is NO
--     `baseline_event.known_ioc_hit` column to mirror the verdict onto —
--     the verdict lives here entirely. Readiness (`status`) and the verdict
--     (`known_ioc_hit` + `coverage_status`) are columns of the SAME row, so
--     the downstream worker reads both from one snapshot and can never gate
--     on a torn read (analogous to the story worker reading
--     `story_enrichment_state` + `known_ioc_hit` together).
--
--   * `event_ioc_evidence` — one row per floor-supporting match, mirroring
--     `story_ioc_evidence` field-for-field minus the story linkage, keyed
--     by `(source_aice_id, event_key)`. Floor-supporting matches only;
--     soft-reputation / non-floor-eligible matches never land here and do
--     not produce a tier-A-qualifying verdict. Indicators are stored the
--     same way as the rest of the redaction layer: external indicators raw
--     and customer-asset indicators as `<<REDACTED_*_NNN>>` tokens (the
--     original lives only in the existing encrypted `event_redaction_map`
--     row, located by this row's `(source_aice_id, event_key)` scope).
--
-- The grain is `(source_aice_id, event_key)`, NOT a baseline_version-scoped
-- key: `event_key` recurs across `baseline_version` after a rebaseline
-- (`baseline_event` PK is `(baseline_version, event_key)`), and the verdict
-- describes the logical event. There is therefore NO FK to `baseline_event`;
-- the read helper dedupes to the latest `baseline_event` row by
-- `received_at` (then `baseline_version DESC`) before extracting indicators.
-- Per the pre-release dev-DB reset policy these tables are introduced freely
-- with no migration/backfill concern.

CREATE TABLE event_enrichment_state (
    source_aice_id  TEXT           NOT NULL,
    event_key       NUMERIC(39, 0) NOT NULL,
    -- `complete` = enrichment ran to completion for this event (even with
    -- zero matches). `failed` = a hard error left the run incomplete; the
    -- downstream worker's precondition keeps requeuing.
    status          TEXT           NOT NULL
        CHECK (status IN ('complete', 'failed')),
    -- RFC 0003 §"Audit / evidence model": separate from the boolean. A
    -- stale/unavailable deterministic feed yields `unknown`/`stale`, never
    -- a silent `false`, so a negative is always explicable.
    coverage_status TEXT           NOT NULL
        CHECK (coverage_status IN ('complete', 'partial', 'unknown', 'stale')),
    -- The per-event floor verdict. Monotonic in observed hits — an
    -- unavailable source / refresh-miss never flips an established `true`
    -- back to false.
    known_ioc_hit   BOOLEAN        NOT NULL DEFAULT FALSE,
    completed_at    TIMESTAMPTZ,
    last_error      TEXT,
    created_at      TIMESTAMPTZ    NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ    NOT NULL DEFAULT NOW(),
    PRIMARY KEY (source_aice_id, event_key)
);

CREATE TABLE event_ioc_evidence (
    id                BIGINT         GENERATED ALWAYS AS IDENTITY
                                     PRIMARY KEY,
    -- The event redaction-map scope `(source_aice_id, event_key)` this
    -- evidence row was extracted under — i.e. the `(aice_id, event_key)`
    -- key of the `event_redaction_map` row. For a customer-asset
    -- `redaction_token` this is what makes the original recoverable; for a
    -- raw external indicator it is provenance (which event the hit came
    -- from). It is also the grain of the verdict in `event_enrichment_state`.
    source_aice_id    TEXT           NOT NULL,
    event_key         NUMERIC(39, 0) NOT NULL,
    -- The redaction-consistent indicator reference: the raw value for an
    -- external indicator, or a `<<REDACTED_*_NNN>>` token for a
    -- customer-asset indicator (whose original lives only in the existing
    -- encrypted redaction map).
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

GRANT SELECT, INSERT, UPDATE, DELETE ON event_enrichment_state TO aimer_customer;
GRANT SELECT, INSERT, UPDATE, DELETE ON event_ioc_evidence TO aimer_customer;
