-- Event-leaf backfill run lease (#470 Scope §3 — true self-paced throttle).
--
-- The self-paced throttle (a bounded model-call burst per interval) is the
-- operator-facing cost control for the event-leaf backfill. The worker
-- installs in EVERY server process, so without a run-level lease each replica
-- would claim the same `running` run and process its own `BATCH_SIZE` items
-- per tick: the per-replica item-claim guard prevents DUPLICATE calls for the
-- same event, but the aggregate burst becomes `replicas × BATCH_SIZE` per
-- interval, breaking the documented per-run bound.
--
-- A single-owner lease fixes this: a worker that claims a run stamps its
-- `lease_owner` and a `lease_expires_at` and renews (heartbeats) the lease as
-- it processes. While the lease is held and unexpired, NO other worker can
-- claim the run, so exactly one process drains it and the burst stays bounded
-- to `BATCH_SIZE` per interval regardless of replica count. If the owner
-- crashes, the lease lapses and another worker takes the run over (resuming
-- it), so the lease never strands a run.

ALTER TABLE event_leaf_backfill_runs
    ADD COLUMN lease_owner      TEXT,
    ADD COLUMN lease_expires_at TIMESTAMPTZ;

-- Claim scan: the oldest active run whose lease is free / expired / ours.
-- Ordering by created_at keeps FIFO; the partial predicate matches the claim
-- WHERE so the scan stays cheap as runs accumulate.
DROP INDEX IF EXISTS event_leaf_backfill_runs_claimable_idx;
CREATE INDEX event_leaf_backfill_runs_claimable_idx
    ON event_leaf_backfill_runs (created_at)
    WHERE status IN ('pending', 'running');
