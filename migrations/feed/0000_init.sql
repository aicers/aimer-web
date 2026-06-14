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
    -- Intrinsic to a POSITIVE match: a curated known-bad listing is
    -- `deterministic_ioc`; a noisy/score feed would be `soft_reputation`
    -- and can never drive the floor. NULL for NEGATIVE rows (see `polarity`
    -- and the cross-column CHECK below): a warninglist entry is neither
    -- `deterministic_ioc` nor `soft_reputation`, so it carries no hit_type.
    hit_type          TEXT,
    -- RFC 0003 F5 negative layer (#599): a source's rows are either a
    -- positive known-bad/known-noisy signal (`positive`, the default — every
    -- existing source) or a negative known-good/known-noisy signal
    -- (`negative`, MISP-warninglist style) that suppresses / down-weights an
    -- indicator's positive matches. A negative row MUST NEVER feed
    -- `known_ioc_hit`: it contributes only a suppression signal, never a
    -- positive match. Defaulting to `positive` keeps every existing row /
    -- source unchanged.
    polarity          TEXT         NOT NULL DEFAULT 'positive'
        CHECK (polarity IN ('positive', 'negative')),
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
    CHECK ((match_value IS NULL) <> (cidr IS NULL)),
    -- Tie `hit_type` to `polarity` (#599): `hit_type` is meaningful only for a
    -- positive match, so a positive row carries one of the enum values
    -- (NOT NULL) and a negative row carries none (NULL). This keeps positive
    -- rows under exactly today's `hit_type NOT NULL` enum while relaxing the
    -- column to allow the negative case.
    -- The explicit `hit_type IS NOT NULL` is load-bearing: a bare
    -- `hit_type IN (...)` against a NULL yields UNKNOWN, and a CHECK admits
    -- UNKNOWN, so a positive row with NULL hit_type would slip through without
    -- it.
    CHECK (
        (polarity = 'positive'
            AND hit_type IS NOT NULL
            AND hit_type IN ('deterministic_ioc', 'soft_reputation'))
        OR (polarity = 'negative' AND hit_type IS NULL)
    )
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

-- ---------------------------------------------------------------
-- cve_snapshot (RFC 0005 CVE catalog foundation, #601)
-- ---------------------------------------------------------------
-- Locally-imported CVE enrichment snapshots from the core CVE sources
-- (NVD CVSS+CWE, CISA KEV known-exploited, FIRST EPSS). This is the
-- CVE analogue of `ioc_feed_snapshot`, but CVE never flows through the
-- IOC indicator/dispatch/floor pipeline — it is its own catalog
-- (`PgCveCatalog` over this table), keyed for an efficient `lookup(cve)`.
--
-- Keyed at `(source_id, cve)` granularity — ONE row per source per CVE —
-- so each source is independently replaceable via a per-source
-- `DELETE WHERE source_id = … ` + `INSERT` in one transaction, exactly the
-- replace-only model `ioc_feed_snapshot` uses (no UPDATE grant). NVD / KEV /
-- EPSS refresh independently (#611), so one source's refresh must not clobber
-- another's facts; a wide one-row-per-`cve` table could not be replaced per
-- source under the replace-only grant. `lookup(cve)` merges the per-source
-- rows into one `CveRecord`.
--
-- Each row carries only the columns its own source populates (the others
-- stay NULL): NVD rows carry `cvss_score` / `cwe` / `cvss_vector` and the
-- CVSS `description`; KEV rows carry `kev_known_exploited` / `kev_date_added`
-- / `in_the_wild` and the CISA `shortDescription`; EPSS rows carry
-- `epss_score` / `epss_percentile`. `description` is source-local (a KEV-only
-- CVE still has CISA's description for the landscape, even with no NVD row).
--
-- `published_at` is the upstream CVE publication date. It drives the
-- recent-CVE LANDSCAPE recency window ONLY — never coverage staleness.
-- Coverage freshness for `CveSourceOutcome.sourceUpdatedAt` comes from the
-- per-source fetch clock in `cve_fetch_state.last_fetched_at`, NOT from this
-- per-CVE publish date (a daily-revalidated unchanged source must read fresh).
CREATE TABLE cve_snapshot (
    source_id            TEXT         NOT NULL
        CHECK (source_id IN ('nvd', 'kev', 'epss')),
    -- Canonical CVE id (`CVE-YYYY-N{4,}`).
    cve                  TEXT         NOT NULL,
    -- NVD: CVSS base score + CWE list. `cvss_vector` is audit-only — the
    -- raw CVSS vector is NOT part of `CvssFact` and is never surfaced in
    -- `CveRecord`; it is stored here so the complete source column set lives
    -- in this file (#611 only writes rows, it adds no columns).
    cvss_score           DOUBLE PRECISION,
    cwe                  TEXT[],
    cvss_vector          TEXT,
    -- CISA KEV: known-exploited flag, date added to the catalog (upstream
    -- ISO date, stored verbatim), and the in-the-wild signal.
    kev_known_exploited  BOOLEAN,
    kev_date_added       TEXT,
    in_the_wild          BOOLEAN,
    -- FIRST EPSS: exploit-prediction score + percentile.
    epss_score           DOUBLE PRECISION,
    epss_percentile      DOUBLE PRECISION,
    -- Source-local one-line description (NVD CVSS summary / CISA
    -- shortDescription). Lives on the source's own row so a KEV-only CVE
    -- still carries a description for the landscape.
    description          TEXT,
    -- Upstream CVE publication date (landscape recency ONLY — see header).
    published_at         TIMESTAMPTZ,
    imported_at          TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    PRIMARY KEY (source_id, cve)
);

-- `lookup(cve)` / `landscape()` fan a CVE across its per-source rows; the
-- composite PK leads with `source_id`, so a dedicated `cve` index serves the
-- value-keyed merge. CVE snapshots are modest, so no further indexing.
CREATE INDEX cve_snapshot_cve_idx ON cve_snapshot (cve);

-- ---------------------------------------------------------------
-- cve_fetch_state (RFC 0005 CVE catalog foundation, #601)
-- ---------------------------------------------------------------
-- Per-source fetch/availability/freshness bookkeeping for the CVE sources —
-- the CVE-namespaced analogue of `feed_fetch_state`, but keyed on the CVE
-- `source_id` ('nvd' | 'kev' | 'epss'), NOT the IOC `source_policy_id`
-- namespace, so the two never collide. Mirrors `feed_fetch_state`'s columns
-- but is a distinct table (#611 populates it on fetch).
--
-- `last_fetched_at` is the last-successful-fetch/validation clock, bumped on
-- every successful 200/304 (like `feed_fetch_state.last_fetched_at`). It is
-- the authority for `CveSourceOutcome.sourceUpdatedAt`: a source that
-- revalidates daily and finds nothing changed (304) must read FRESH, not
-- stale, so freshness derives from this clock and NOT from the per-CVE
-- upstream `cve_snapshot.published_at`. A source that has never successfully
-- fetched (`last_fetched_at` NULL) is reported `answered: false`. A failure
-- leaves `last_fetched_at` untouched so freshness decays naturally.
CREATE TABLE cve_fetch_state (
    source_id        TEXT         PRIMARY KEY
        CHECK (source_id IN ('nvd', 'kev', 'epss')),
    -- Last successful fetch (200 or 304); the freshness clock.
    last_fetched_at  TIMESTAMPTZ,
    -- Last fetch attempt, success or failure (status/error display).
    last_attempt_at  TIMESTAMPTZ,
    -- Conditional-GET validators from the last 200 response.
    etag             TEXT,
    last_modified    TEXT,
    -- 'ok' | 'not-modified' | 'error' (last attempt's outcome).
    last_status      TEXT,
    last_error       TEXT,
    -- Rows imported by the last successful 200 (may be 0).
    last_row_count   INTEGER,
    updated_at       TIMESTAMPTZ  NOT NULL DEFAULT NOW()
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

-- CVE catalog (#601): `cve_snapshot` is replace-only — the per-source CVE
-- refresh (#611) replaces a source's rows (DELETE + INSERT) within one
-- transaction, exactly like `ioc_feed_snapshot`, so NO UPDATE grant. The
-- per-source `cve_fetch_state` is upserted (ON CONFLICT DO UPDATE) on each
-- fetch, so it needs UPDATE like `feed_fetch_state`.
GRANT SELECT, INSERT, DELETE ON cve_snapshot TO aimer_feed;
GRANT SELECT, INSERT, UPDATE ON cve_fetch_state TO aimer_feed;
