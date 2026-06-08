-- Operator-triggered report-variant refresh control tables (#469).
--
-- After a per-customer default-model change (#473), the story-leaf (#466)
-- and event-leaf (#470) backfills re-analyze the underlying leaves under
-- the new model. But an existing periodic-report `done` variant still
-- AGGREGATES the old leaf set until it is regenerated. This refresh bumps
-- the `generation` of scoped `periodic_report_job` variants (the force
-- regenerate primitive) so the existing report worker re-aggregates the
-- freshly re-analyzed leaves. It is NOT `enqueueOnDemandReportJob` (which
-- coalesces a `done` row and would never refresh a stale report).
--
-- Unlike the leaf backfills there is NO background re-analysis worker here:
-- a refresh is a generation bump that the EXISTING periodic-report worker
-- drains, so the run executes synchronously at confirm-time (evaluate the
-- scope, gate each variant on both leaf drain signals, bump the refreshable
-- ones). These two tables persist the run and its per-variant outcomes so
-- the refreshed-vs-skipped breakdown (Scope §5, no silent caps) survives
-- across requests rather than living only in a response body.
--
-- A run is scoped to a single customer (the default scope when launched
-- from a #473 model change) and a single target `(lang, model_name, model)`
-- pair (the customer's new default), bounded by an enqueue-recency window
-- (default 7 days) and an optional per-run variant cap. Each candidate
-- variant is gated on the #466/#470 drain signals over the variant's OWN
-- per-period aggregation window before it is refreshed.

CREATE TABLE report_variant_refresh_runs (
    id                       UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
    customer_id              UUID         NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
    -- Target the refreshed variants are keyed under: the customer's new
    -- default `(model_name, model)` and the operator-chosen `lang`.
    lang                     TEXT         NOT NULL,
    model_name               TEXT         NOT NULL,
    model                    TEXT         NOT NULL,
    -- Optional timezone-variant scope (Scope §2). A report variant is keyed
    -- by `(tz, lang, model_name, model)`, so a run may target a single
    -- timezone. NULL = all timezone variants within the recent window (the
    -- conservative default the operator gets when no timezone is chosen).
    tz                       TEXT,
    -- Enqueue-recency window (Scope §4): which report buckets are in scope.
    -- `window_days` is the operator-chosen recent-window (default 7);
    -- `window_start` / `window_end` are the resolved instants frozen at
    -- creation. This is DISTINCT from the per-variant drain-gate window,
    -- which is derived from each variant's period and may span far more
    -- than `window_days`.
    window_days              INT          NOT NULL,
    window_start             TIMESTAMPTZ  NOT NULL,
    window_end               TIMESTAMPTZ  NOT NULL,
    -- The periods in scope (subset of LIVE/DAILY/WEEKLY/MONTHLY).
    periods                  TEXT[]       NOT NULL,
    -- Optional per-run cap on the number of variants actually refreshed
    -- (self-paced cost bound). NULL = no cap within the window. Variants
    -- beyond the cap are reported as `limited`.
    max_variants             INT,
    -- A refresh run is synchronous: it completes (or fails) within the
    -- request that creates it. `running` is the brief in-flight state.
    status                   TEXT         NOT NULL DEFAULT 'running'
        CHECK (status IN ('running', 'completed', 'failed')),
    -- Aggregate per-variant outcome counts (Scope §5, no silent caps).
    total_variants           INT          NOT NULL DEFAULT 0,
    refreshed_count          INT          NOT NULL DEFAULT 0,
    capped_count             INT          NOT NULL DEFAULT 0,
    gated_count              INT          NOT NULL DEFAULT 0,
    already_queued_count     INT          NOT NULL DEFAULT 0,
    source_unavailable_count INT          NOT NULL DEFAULT 0,
    limited_count            INT          NOT NULL DEFAULT 0,
    error_message            TEXT,
    created_by               UUID,
    created_at               TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    finished_at              TIMESTAMPTZ
);

CREATE INDEX report_variant_refresh_runs_customer_idx
    ON report_variant_refresh_runs (customer_id, created_at DESC);

-- Per-variant outcome. One row per scoped report variant the run evaluated,
-- recording its category and (for a refreshed variant) the resulting
-- generation. `period` / `bucket_date` / `tz` / `lang` / `model_name` /
-- `model` mirror the `periodic_report_job` variant PK; there is no FK
-- because a variant the run only seeds may have no job row yet at eval time.
-- `window_start` / `window_end` are the per-variant ANCHORED aggregation
-- window the drain gate checked (NOT the run's enqueue window), so the gate
-- decision is auditable per variant.
CREATE TABLE report_variant_refresh_items (
    run_id        UUID        NOT NULL REFERENCES report_variant_refresh_runs(id) ON DELETE CASCADE,
    period        TEXT        NOT NULL,
    bucket_date   DATE        NOT NULL,
    tz            TEXT        NOT NULL,
    lang          TEXT        NOT NULL,
    model_name    TEXT        NOT NULL,
    model         TEXT        NOT NULL,
    category      TEXT        NOT NULL
        CHECK (category IN ('refreshed', 'capped', 'gated', 'already_queued',
                            'source_unavailable', 'limited')),
    -- The variant generation after a refresh (the bumped value), or NULL for
    -- a non-refreshed outcome.
    generation    INT,
    window_start  TIMESTAMPTZ NOT NULL,
    window_end    TIMESTAMPTZ NOT NULL,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (run_id, period, bucket_date, tz, lang, model_name, model)
);

CREATE INDEX report_variant_refresh_items_category_idx
    ON report_variant_refresh_items (run_id, category);

GRANT SELECT, INSERT, UPDATE, DELETE ON report_variant_refresh_runs TO aimer_auth;
GRANT SELECT, INSERT, UPDATE, DELETE ON report_variant_refresh_items TO aimer_auth;
