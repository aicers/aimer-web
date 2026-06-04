-- RFC 0003 P1a (#361) — per-story IOC enrichment state + evidence
-- (customer DB).
--
-- The async enrichment worker derives `known_ioc_hit` for a story's
-- canonical version, UPDATEs `story.known_ioc_hit`, and records here:
--
--   * `story_enrichment_state` — one row per canonical
--     `(story_id, story_version)` marking that enrichment ran, its
--     `coverage_status`, the derived `known_ioc_hit`, and a completed-at
--     timestamp. This row is the marker the story-analysis worker's
--     precondition checks before reading the floor: analysis requeues
--     its own job until the canonical version is marked complete, so a
--     stale `known_ioc_hit` can never be read. It is written even when
--     there are zero matches, so `false-complete` (enrichment ran, no
--     hit) is distinguishable from `false-unknown` (enrichment
--     incomplete or a deterministic feed was stale/unavailable).
--
--   * `story_ioc_evidence` — one row per floor-supporting match, storing
--     the RFC 0003 `EvidenceRecord` fields so a `known_ioc_hit = true`
--     is explainable after the fact. No plaintext indicator is stored by
--     default: only the keyed HMAC of the normalized indicator plus the
--     `redactionToken` identity reference. Linked to the canonical story
--     version, NOT to `story_analysis_result` (which does not yet exist
--     when enrichment runs — analysis produces it later and can join
--     back on `story_id`).
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
    -- Links evidence back to the masked member (identity reference for
    -- external raw indicators that carry no token).
    redaction_token           TEXT         NOT NULL,
    -- Keyed HMAC of the normalized indicator + the key version that
    -- produced it (rotation retains old versions so prior evidence stays
    -- verifiable) + the normalization version (keeps the HMAC
    -- interpretable as rules evolve). No plaintext indicator by default.
    normalized_indicator_hmac TEXT         NOT NULL,
    hmac_key_version          TEXT         NOT NULL,
    evidence_key_id           TEXT,
    normalization_version     TEXT         NOT NULL,
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

-- The enrichment worker must flip the inert payload default of
-- `story.known_ioc_hit` once a floor-eligible deterministic match is
-- observed. Grant only that column (column-scoped UPDATE keeps the
-- restricted-role posture, matching the redaction-job grants in 0006).
GRANT UPDATE (known_ioc_hit) ON story TO aimer_customer;

GRANT SELECT, INSERT, UPDATE, DELETE ON story_enrichment_state TO aimer_customer;
GRANT SELECT, INSERT, UPDATE, DELETE ON story_ioc_evidence TO aimer_customer;
