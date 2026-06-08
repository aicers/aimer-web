-- Individual baseline-event auto-analysis job lifecycle (#493).
--
-- RFC 0002 amendment (#489) §"Individual baseline-event auto-analysis".
-- The FIRST event-level analysis job lifecycle table. Until now event
-- analysis has been per-event and synchronous (`analyzeAndStoreEventResult`,
-- the manual path); `0043` scopes its "events have NO lifecycle table"
-- comment to that manual path. This table is the auto-baseline path's
-- lifecycle, the event-grain analog of `story_analysis_job` (`0028`), and
-- like it lives in the AUTH DB (not the customer DB).
--
-- Grain `(customer_id, aice_id, event_key, lang, model_name, model)`. The
-- key uses `aice_id` (mapped `aice_id := baseline_event.source_aice_id` at
-- seed time) to stay consistent with `event_analysis_result.aice_id`.
--
-- `baseline_version` carries the EXACT version ingested at enqueue so the
-- precise `baseline_event.raw_event` can be reloaded for analysis (result
-- reproducibility). `baseline_event.event_key` is NOT unique across
-- `baseline_version` (the same event reappears after a rebaseline), so the
-- job records the latest observed `baseline_version` while the
-- dedup-against-the-live-leaf rule (skip when a non-superseded
-- `event_analysis_result` already exists for the target variant) keeps a
-- rebaseline from re-analyzing.
--
-- Budget-accounting columns (required for a correct per-customer daily cap):
--   * `selection_tier` — `tier_a` (IOC hit; uncapped) | `tier_b`
--     (budget-gated). NULL means HELD: the event has not yet been
--     classified (no conclusive `event_enrichment_state` verdict). A held
--     row never inflates the tier-B reservation count (the count filters
--     `selection_tier = 'tier_b'`), which is exactly RFC's "do not classify
--     a tier yet" for an absent / non-conclusive verdict.
--   * `budget_day` — the customer-tz calendar day the row was seeded into,
--     stamped at seed (an auth-DB row only knows UTC timestamps, so the
--     customer-tz day boundary cannot be re-derived from `created_at`).
--
-- The cap is a SEED-TIME RESERVATION, not a `done` tally: the reservation
-- count is `COUNT(*)` of `selection_tier = 'tier_b' AND budget_day = D`
-- rows whose `status <> 'budget_skipped'` (i.e. queued/processing/done/
-- failed all reserve a slot). A row is admitted as tier-B only if the live
-- reserved count is `< cap`; otherwise it is written `budget_skipped`.
-- `budget_skipped` is the TERMINAL tier-B overflow status — queryable,
-- never retried.

CREATE TABLE event_analysis_job (
    customer_id           UUID           NOT NULL,
    aice_id               TEXT           NOT NULL,
    event_key             NUMERIC(39, 0) NOT NULL,
    lang                  TEXT           NOT NULL,
    model_name            TEXT           NOT NULL,
    model                 TEXT           NOT NULL,
    status                TEXT           NOT NULL
        CHECK (status IN ('queued', 'processing', 'done', 'failed',
                          'budget_skipped')),
    -- NULL = held (awaiting enrichment / classification); see header.
    selection_tier        TEXT
        CHECK (selection_tier IS NULL
               OR selection_tier IN ('tier_a', 'tier_b')),
    budget_day            DATE           NOT NULL,
    baseline_version      TEXT           NOT NULL,
    generation            INT            NOT NULL DEFAULT 1,
    dry_run               BOOLEAN        NOT NULL DEFAULT FALSE,
    created_at            TIMESTAMPTZ    NOT NULL DEFAULT NOW(),
    processing_started_at TIMESTAMPTZ,
    last_generated_at     TIMESTAMPTZ,
    force_requested_at    TIMESTAMPTZ,
    force_requested_by    UUID,
    attempts              INT            NOT NULL DEFAULT 0,
    last_error            TEXT,
    updated_at            TIMESTAMPTZ    NOT NULL DEFAULT NOW(),
    PRIMARY KEY (customer_id, aice_id, event_key, lang, model_name, model)
);

CREATE INDEX event_analysis_job_queued_idx
    ON event_analysis_job (customer_id, aice_id, event_key)
    WHERE status = 'queued';

-- Backs the per-`(customer_id, budget_day)` tier-B reservation COUNT(*).
-- Partial on the exact predicate the seed-time reservation evaluates so
-- the count stays an index-only scan.
CREATE INDEX event_analysis_job_budget_idx
    ON event_analysis_job (customer_id, budget_day)
    WHERE selection_tier = 'tier_b' AND status <> 'budget_skipped';

GRANT SELECT, INSERT, UPDATE, DELETE ON event_analysis_job TO aimer_auth;
