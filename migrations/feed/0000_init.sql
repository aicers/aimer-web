-- feed_db first-version schema (RFC 0003 Tier-1 feed-refresh, #564).
--
-- Single collapsed schema file for the dedicated feed database. aimer-web
-- is pre-release: dev databases are reset on schema changes, so this file
-- is edited in place until the first release. Post-release changes append
-- numbered migrations starting at 0001 (see migrations/README.md).
--
-- The feed store moved out of the shared auth DB (#564): feed data is
-- external-sourced, read-heavy on match, and replaced wholesale on
-- refresh, so co-locating it with the authn/authz hot path coupled
-- unrelated blast radius and workloads. It now lives here on its own
-- two-role / two-pool split, mirroring the audit DB.
--
-- Role creation is handled by infra/postgres/init-databases.sql (Docker
-- entrypoint); this file only assigns grants.

-- ---------------------------------------------------------------
-- ioc_feed_snapshot (RFC 0003 P1a, #361)
-- ---------------------------------------------------------------
-- Imported, locally-matched IOC feed snapshots (abuse.ch Feodo /
-- URLhaus, Spamhaus DROP/EDROP, …). The feed data is global — identical
-- for every customer. Tier 1 means only the feed download leaves the
-- host: customer indicators are matched locally against this table and
-- never egress.
--
-- Matching: exact entries carry `match_value` (normalized indicator)
-- and `cidr IS NULL`; range entries carry `cidr` and `match_value IS
-- NULL`, matched with the `>>=` containment operator. One of the two is
-- always present (CHECK below).
CREATE TABLE ioc_feed_snapshot (
    id                BIGINT       GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    source_policy_id  TEXT         NOT NULL,
    entity_type       TEXT         NOT NULL
        CHECK (entity_type IN ('IP', 'DOMAIN', 'URL', 'HASH')),
    -- Exact normalized indicator (NULL for range entries).
    match_value       TEXT,
    -- CIDR network for range matching (NULL for exact entries).
    cidr              CIDR,
    -- Intrinsic to the match: a curated known-bad listing is
    -- `deterministic_ioc`; a noisy/score feed would be `soft_reputation`
    -- and can never drive the floor.
    hit_type          TEXT         NOT NULL
        CHECK (hit_type IN ('deterministic_ioc', 'soft_reputation')),
    classification    TEXT,
    confidence        DOUBLE PRECISION,
    -- Snapshot provenance / freshness (audit + stale-coverage policy).
    source_version    TEXT,
    feed_hash         TEXT,
    source_updated_at TIMESTAMPTZ,
    imported_at       TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    CHECK ((match_value IS NULL) <> (cidr IS NULL))
);

-- Exact-match lookups: scoped by source + entity type, then by value.
CREATE INDEX ioc_feed_snapshot_exact_idx
    ON ioc_feed_snapshot (source_policy_id, entity_type, match_value)
    WHERE match_value IS NOT NULL;

-- Range-match scan: narrowed to a source's IP range entries before the
-- `>>=` containment test (feed snapshots are modest — no GiST needed).
CREATE INDEX ioc_feed_snapshot_cidr_idx
    ON ioc_feed_snapshot (source_policy_id)
    WHERE cidr IS NOT NULL;

-- ===================================================================
-- Grants
-- ===================================================================
-- Role creation is handled by infra/postgres/init-databases.sql; this
-- file only assigns grants.

-- Owner: full access for migrations.
GRANT ALL ON ALL TABLES IN SCHEMA public TO aimer_feed_owner;
GRANT ALL ON ALL SEQUENCES IN SCHEMA public TO aimer_feed_owner;

-- Runtime (aimer_feed): the enrichment worker reads ioc_feed_snapshot;
-- the import/refresh path replaces a source's rows (DELETE + INSERT)
-- within one transaction. `id` is GENERATED ALWAYS AS IDENTITY, whose
-- sequence needs no separate grant (INSERT on the table suffices).
GRANT SELECT, INSERT, DELETE ON ioc_feed_snapshot TO aimer_feed;
