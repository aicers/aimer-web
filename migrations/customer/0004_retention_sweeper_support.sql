-- Retention sweeper support — DELETE grant on detection_events and
-- six sweeper-supporting indexes that #250 did not bundle.
--
-- See issue #255 §"Runtime grants" and §"Index dependencies".

-- ---------------------------------------------------------------
-- Runtime grant: aimer_customer DELETE on detection_events.
-- Phase 1's #250 redeclaration kept the pre-restructure grant
-- (SELECT, INSERT); without DELETE the sweep tick fails with
-- "permission denied for table detection_events" on the first
-- run.
-- ---------------------------------------------------------------
GRANT DELETE ON detection_events TO aimer_customer;

-- ---------------------------------------------------------------
-- Per-table sweep indexes (clock column < cutoff)
-- ---------------------------------------------------------------
CREATE INDEX idx_baseline_event_received_at
    ON baseline_event (received_at);

CREATE INDEX idx_story_received_at
    ON story (received_at);

CREATE INDEX idx_policy_run_received_at
    ON policy_run (received_at);

-- ---------------------------------------------------------------
-- Map cascade NOT EXISTS lookups
-- ---------------------------------------------------------------
-- baseline_event lookup is keyed on (source_aice_id, event_key).
CREATE INDEX idx_baseline_event_source_aice_id_event_key
    ON baseline_event (source_aice_id, event_key);

-- story_member joins via story.source_aice_id, then filters by
-- the member's event_key. The parent join needs source_aice_id
-- indexed on story; story_member's PK already covers the join.
CREATE INDEX idx_story_source_aice_id
    ON story (source_aice_id);

-- Same shape for policy_event via policy_run.source_aice_id.
CREATE INDEX idx_policy_run_source_aice_id
    ON policy_run (source_aice_id);
