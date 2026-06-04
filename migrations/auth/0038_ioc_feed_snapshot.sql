-- RFC 0003 P1a (#361) — Tier-1 local IOC feed snapshot (shared auth DB).
--
-- This table holds the imported, locally-matched IOC feed snapshots
-- (abuse.ch Feodo / URLhaus, Spamhaus DROP/EDROP, …). It lives in the
-- shared `auth` DB rather than per-customer because the feed data is
-- global — identical for every customer — so duplicating it into each
-- customer DB would waste space and risk drift. The enrichment worker
-- already holds `authPool` for the lookup while it reads members and
-- writes the floor through `customerPool`.
--
-- Tier 1 means only the feed download leaves the host: customer
-- indicators are matched locally against this table and never egress.
-- The fetch/parse layer imports a snapshot by replacing all rows for a
-- `source_policy_id` inside one transaction, so a row's
-- `source_version` / `feed_hash` / `source_updated_at` describe the
-- snapshot it belongs to and freshness is recordable per source.
--
-- Matching:
--   * exact entries carry `match_value` (the normalized indicator, e.g.
--     a canonical IP / A-label domain / canonical URL / lowercased
--     hash) and `cidr IS NULL`;
--   * range entries (Spamhaus DROP/EDROP) carry `cidr` (a CIDR network)
--     and `match_value IS NULL`, matched with the `>>=` containment
--     operator against a candidate `inet`.
-- One of the two is always present (enforced by the CHECK below).

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
-- `>>=` containment test. Feed snapshots are modest in size (Spamhaus
-- DROP is ~1k rows), so a scoped scan is sufficient — no GiST needed.
CREATE INDEX ioc_feed_snapshot_cidr_idx
    ON ioc_feed_snapshot (source_policy_id)
    WHERE cidr IS NOT NULL;

-- The enrichment worker reads this table through the restricted
-- `aimer_auth` runtime role; the import/refresh path replaces a
-- source's rows (DELETE + INSERT) within one transaction.
GRANT SELECT, INSERT, DELETE ON ioc_feed_snapshot TO aimer_auth;
