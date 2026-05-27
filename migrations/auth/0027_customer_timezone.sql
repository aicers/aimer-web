-- RFC 0002 Phase 0 (#294) — customer-level timezone.
--
-- Day/week/month boundaries used by aimer-web schedulers and aimer
-- report inputs are computed from a customer-level timezone (RFC 0002
-- §"Customer-level timezone"). Account-level `accounts.timezone`
-- remains UI-display-only and is not touched here.
--
-- Default `Asia/Seoul` matches the deployment region; admin SQL update
-- (no UI in Phase 0) is the only mutation path for now. UI gating
-- against this column lands in a later phase.

ALTER TABLE customers
  ADD COLUMN timezone TEXT NOT NULL DEFAULT 'Asia/Seoul';
