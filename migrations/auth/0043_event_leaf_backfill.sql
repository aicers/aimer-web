-- Event-leaf re-analysis backfill control tables (#470).
--
-- After a per-customer default-model change (#473), an operator can
-- re-analyze the customer's EXISTING event leaves under the new model so
-- the report-model coverage (and #465's hybrid scores, once #469 refreshes
-- the report) becomes complete. Story leaves are handled by #466's sibling
-- backfill; event leaves are handled here.
--
-- Events have NO `event_analysis_state` / `event_analysis_job` lifecycle
-- table and no re-seed worker: event analysis is per-event and synchronous
-- (`analyzeAndStoreEventResult`). So the backfill cannot lean on a job
-- worker's drain for progress / cancel / per-item status / no-silent-caps
-- reporting the way the story side does. These two tables ARE that
-- bookkeeping — backfill control state, NOT an event-analysis lifecycle.
-- The drain-completion signal (#470 Scope §6) is computed from
-- `event_analysis_result` itself (correct across multiple runs), not from
-- these tables; the tables only explain WHY an event is outstanding
-- (failed vs not-yet-run vs cap-excluded) for reporting.
--
-- A run is scoped to a single customer (the default scope when launched
-- from a #473 model change) and a single target `(lang, model_name, model)`
-- variant, over a recent event-time window computed on the SAME
-- `baseline_event` event-time basis the report input builder uses.

CREATE TABLE event_leaf_backfill_runs (
    id                       UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
    customer_id              UUID         NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
    -- Target variant the run re-analyzes toward.
    lang                     TEXT         NOT NULL,
    model_name               TEXT         NOT NULL,
    model                    TEXT         NOT NULL,
    -- Scope window on the baseline_event event-time basis. `window_days`
    -- is the operator-chosen recent-window (default 7); `window_start` /
    -- `window_end` are the resolved instants frozen at creation so preview,
    -- worker materialization, and reporting all agree on one window.
    window_days              INT          NOT NULL,
    window_start             TIMESTAMPTZ  NOT NULL,
    window_end               TIMESTAMPTZ  NOT NULL,
    -- Optional per-run cap on the number of events actually re-analyzed
    -- (self-paced cost bound). NULL = no cap within the window. Work
    -- candidates beyond the cap are reported as `cap_excluded`.
    max_items                INT,
    status                   TEXT         NOT NULL DEFAULT 'pending'
        CHECK (status IN ('pending', 'running', 'completed', 'cancelled', 'failed')),
    -- Cooperative cancel flag the worker polls between events; the cancel
    -- endpoint sets it and the worker flips status to 'cancelled' at the
    -- next checkpoint.
    cancel_requested         BOOLEAN      NOT NULL DEFAULT FALSE,
    -- Aggregate counts (the no-silent-caps categories, Scope §8). The
    -- preview computes these over the §2 universe; the worker maintains
    -- them as it processes. `cap_excluded_count` is kept as an aggregate
    -- (per-item materialization of every excluded event is optional and
    -- skipped for a large scope — only touched items get per-item rows).
    total_universe           INT          NOT NULL DEFAULT 0,
    reanalyzed_count         INT          NOT NULL DEFAULT 0,
    already_current_count    INT          NOT NULL DEFAULT 0,
    source_unavailable_count INT          NOT NULL DEFAULT 0,
    failed_count             INT          NOT NULL DEFAULT 0,
    cap_excluded_count       INT          NOT NULL DEFAULT 0,
    error_message            TEXT,
    created_by               UUID,
    created_at               TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    started_at               TIMESTAMPTZ,
    finished_at              TIMESTAMPTZ,
    last_progress_at         TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

-- At most one active run per customer + target variant. Re-launching the
-- backfill for the same variant while one is queued/running must not
-- spawn a duplicate; the create endpoint returns the existing run.
CREATE UNIQUE INDEX event_leaf_backfill_runs_one_active
    ON event_leaf_backfill_runs (customer_id, lang, model_name, model)
    WHERE status IN ('pending', 'running');

CREATE INDEX event_leaf_backfill_runs_claimable_idx
    ON event_leaf_backfill_runs (created_at)
    WHERE status IN ('pending', 'running');

CREATE INDEX event_leaf_backfill_runs_customer_idx
    ON event_leaf_backfill_runs (customer_id);

-- Per-event work item / status. The worker materializes the work
-- candidates (universe members with no non-superseded target-variant leaf)
-- as `pending` rows when it first claims the run, then transitions each to
-- its terminal category. `already_current` / `source_unavailable` rows the
-- run touches are recorded too, so the per-item table explains the
-- aggregate counts. `aice_id` / `event_key` mirror the customer-DB
-- `event_analysis_result` key types (TEXT / NUMERIC); there is no
-- cross-database FK.
--
-- `processing` is the in-flight claim state. Because the run/item tables can
-- be drained by more than one server process (every replica installs the
-- worker), the worker claims each item with a conditional transition
-- (`pending` -> `processing`, guarded on `status = 'pending'`) BEFORE the
-- model call — mirroring the story worker's queued->processing claim. Only
-- the winner of that transition calls the model and records the terminal
-- status, so two replicas never re-analyze the same event or double-count
-- the run aggregates. A `processing` row whose worker crashed is reclaimed
-- back to `pending` by the worker once its claim goes stale (lease lapses).
CREATE TABLE event_leaf_backfill_items (
    run_id      UUID           NOT NULL REFERENCES event_leaf_backfill_runs(id) ON DELETE CASCADE,
    aice_id     TEXT           NOT NULL,
    event_key   NUMERIC(39, 0) NOT NULL,
    status      TEXT           NOT NULL DEFAULT 'pending'
        CHECK (status IN ('pending', 'processing', 'reanalyzed',
                          'already_current', 'source_unavailable', 'failed',
                          'cap_excluded')),
    error       TEXT,
    updated_at  TIMESTAMPTZ    NOT NULL DEFAULT NOW(),
    PRIMARY KEY (run_id, aice_id, event_key)
);

-- Drain loop reads pending items for the active run; the partial index also
-- serves the stale-`processing` reclaim scan.
CREATE INDEX event_leaf_backfill_items_unfinished_idx
    ON event_leaf_backfill_items (run_id, status)
    WHERE status IN ('pending', 'processing');

GRANT SELECT, INSERT, UPDATE, DELETE ON event_leaf_backfill_runs TO aimer_auth;
GRANT SELECT, INSERT, UPDATE, DELETE ON event_leaf_backfill_items TO aimer_auth;
