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
    -- Optional per-row report-level context (RFC 0003 F6, #594): vendor IOC
    -- repositories bundle actor / campaign / malware family / report link
    -- with each indicator. NULL for context-less feeds (the existing five).
    -- Read back as `unknown` and narrowed before use — never trusted as-is.
    context           JSONB,
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

-- ---------------------------------------------------------------
-- feed_fetch_state (RFC 0003 self-fetch, #568)
-- ---------------------------------------------------------------
-- Per-source fetch bookkeeping for the self-fetch supply mode: drives
-- conditional GET (`If-None-Match` / `If-Modified-Since`), the hard
-- cadence floor, the status display, AND presence/freshness for
-- self-fetch.
--
-- Why freshness lives here, not in a snapshot row mutation: a 304 (Not
-- Modified) leaves the snapshot rows untouched, and a legitimately empty
-- feed (e.g. Feodo can be empty) imports 0 rows — both would read as
-- "stale"/"absent" under a row-count probe. So when the active mode is
-- self-fetch, `last_fetched_at` (bumped on every successful 200/304) is
-- the freshness authority and a row's existence with a successful fetch
-- means present, independent of `ioc_feed_snapshot` row count. A failure
-- (network/timeout/4xx/5xx) does NOT bump `last_fetched_at`, so freshness
-- decays naturally. `ioc_feed_snapshot` stays strictly replace-only.
CREATE TABLE feed_fetch_state (
    source_policy_id  TEXT         PRIMARY KEY,
    -- Last successful fetch (200 or 304); the self-fetch freshness clock.
    last_fetched_at   TIMESTAMPTZ,
    -- Last fetch attempt, success or failure (status/error display).
    last_attempt_at   TIMESTAMPTZ,
    -- Conditional-GET validators from the last 200 response.
    etag              TEXT,
    last_modified     TEXT,
    -- 'ok' | 'not-modified' | 'error' (last attempt's outcome).
    last_status       TEXT,
    last_error        TEXT,
    -- Rows imported by the last successful 200 (may be 0 for an empty feed).
    last_row_count    INTEGER,
    updated_at        TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

-- ---------------------------------------------------------------
-- feed_source_secret (RFC 0003 self-fetch, #568)
-- ---------------------------------------------------------------
-- OpenBao-Transit-wrapped secrets for self-fetch (the URLhaus Auth-Key).
-- Envelope-encrypted exactly like the redaction map: a per-secret DEK is
-- generated via Transit, the value is AES-256-GCM encrypted under it, and
-- the Transit-wrapped DEK is stored alongside the ciphertext. The
-- plaintext key never touches this table and is never returned to the UI
-- (write-only; status shows set/unset). Decrypted only at fetch time.
CREATE TABLE feed_source_secret (
    key_name    TEXT         PRIMARY KEY,
    wrapped_dek TEXT         NOT NULL,
    ciphertext  BYTEA        NOT NULL,
    updated_at  TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

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
-- ioc_feed_snapshot stays strictly replace-only — NO UPDATE grant:
-- self-fetch freshness lives in feed_fetch_state, not a row mutation.
GRANT SELECT, INSERT, DELETE ON ioc_feed_snapshot TO aimer_feed;

-- Self-fetch (#568): the fetch engine upserts fetch bookkeeping and the
-- admin route upserts the wrapped Auth-Key, so these two need UPDATE
-- (ON CONFLICT DO UPDATE) in addition to SELECT/INSERT.
GRANT SELECT, INSERT, UPDATE ON feed_fetch_state TO aimer_feed;
GRANT SELECT, INSERT, UPDATE ON feed_source_secret TO aimer_feed;
