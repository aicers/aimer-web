-- RFC 0003 C1 (#440) — enrichment-fact bodies + self-scoped redaction
-- map (customer DB). Implements RFC 0001 Amendment A.1 (fact side).
--
-- The enrichment worker generates narrative threat-intel facts from a
-- story's IOC matches, redacts each fact's text at the DB-write boundary
-- (external indicators stay raw; customer-asset IPs / owned domains
-- become self-scoped `<<REDACTED_*_NNN>>` tokens), and records here:
--
--   * `story_enrichment_fact` — the redacted fact TEXT that prompt-build
--     reads, with its OWN identity (`IDENTITY PK fact_id`). Linked to the
--     canonical `(story_id, story_version)` and stamped with the
--     `redaction_policy_version` the fact was redacted under. This is the
--     authoritative source of fact bodies. It is INDEPENDENT of
--     `story_ioc_evidence` (0010) so it can hold `soft_reputation` /
--     floor-ineligible narrative facts that have no evidence row;
--     `story_ioc_evidence` stays floor-only.
--
--   * `enrichment_redaction_map` — the self-scoped encrypted map
--     `fact_token -> { kind, value }`, keyed on `fact_id`. The encrypted
--     values carry NO story/member data (RFC A.1 — the story linkage
--     lives on `story_enrichment_fact`, not inside the map), so the map
--     stays story-agnostic and a cross-story cache key can be layered on
--     later without changing its shape. Same envelope adapter / column
--     shape (`ciphertext BYTEA`, `wrapped_dek TEXT`) as
--     `event_redaction_map`.
--
-- Both cascade-delete with the canonical story version, mirroring
-- `story_member` / `story_ioc_evidence`.

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
    -- The composite redaction policy version the fact was redacted under
    -- (engine + ranges + owned-domains hash), for audit / drift parity
    -- with the member-side `redaction_policy_version`.
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

GRANT SELECT, INSERT, UPDATE, DELETE ON story_enrichment_fact TO aimer_customer;
GRANT SELECT, INSERT, UPDATE, DELETE ON enrichment_redaction_map TO aimer_customer;
