-- RFC 0002 Phase 0.5 (#295) — store the cursor quality alongside the
-- cursor watermark on `periodic_report_state`.
--
-- #294 introduced `cursor_watermark TIMESTAMPTZ` on this table but did
-- not record the watermark's quality. Phase 0.5 (#295) needs the
-- quality so the worker readiness check can shorten DAILY settle only
-- when a `strict` watermark covers the bucket end. Soft watermarks are
-- still recorded but do not shorten settle.
--
-- Decision 3 (issue #295): nullable column, CHECK-constrained to
-- ('strict', 'soft'). Update policy lives in the ingest-hook write
-- path: a strictly-greater incoming `cursor_event_time` overwrites
-- both fields; on equal timestamps, `strict` wins over `soft`.

ALTER TABLE periodic_report_state
    ADD COLUMN cursor_watermark_quality TEXT NULL
        CHECK (cursor_watermark_quality IN ('strict', 'soft'));
