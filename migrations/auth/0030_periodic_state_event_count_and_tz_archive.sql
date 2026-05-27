-- RFC 0002 Phase 0 (#294) — round-8 review follow-ups.
--
-- 1. `periodic_report_state.event_count` — the last observed
--    `baseline_event` row count for the bucket. Reconcile updates this
--    on every pass with `COUNT(*)` from customer DB. When the stored
--    value is higher than the recomputed value the bucket has lost
--    content since the last pass — a window-replace / backfill
--    envelope deleted events whose `event_time` or `received_at`
--    no longer advances the bucket maxima. Reconcile dirties the
--    state row in that case, closing the gap surfaced by round-8
--    review item 1 (envelope-overlap dirty after a hook failure
--    where neither max advances).
--
-- 2. Customer-timezone-change archive trigger — when an admin runs
--    `UPDATE customers SET timezone = 'X'`, every `periodic_report_state`
--    row whose `tz` no longer matches `customers.timezone` is archived
--    automatically. RFC 0002 §"Customer-level timezone" / issue #294
--    decision 4 require old-tz rows to be archived on a tz change; the
--    new-tz rows are seeded lazily by the reconcile scan from the
--    customer's source data.

ALTER TABLE periodic_report_state
  ADD COLUMN event_count BIGINT NOT NULL DEFAULT 0;

-- A trigger function rather than an SQL function on the admin path
-- keeps the archive correct even if a future code path forgets to call
-- the helper. AFTER UPDATE OF timezone ... WHEN NEW IS DISTINCT FROM OLD
-- ensures we only fire on a real change and not on idempotent re-writes.
CREATE OR REPLACE FUNCTION fn_archive_periodic_states_on_tz_change()
RETURNS TRIGGER AS $$
BEGIN
  UPDATE periodic_report_state
     SET status = 'archived', updated_at = NOW()
   WHERE customer_id = NEW.id
     AND tz <> NEW.timezone
     AND status <> 'archived';
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_archive_periodic_states_on_tz_change
  AFTER UPDATE OF timezone ON customers
  FOR EACH ROW
  WHEN (NEW.timezone IS DISTINCT FROM OLD.timezone)
  EXECUTE FUNCTION fn_archive_periodic_states_on_tz_change();
