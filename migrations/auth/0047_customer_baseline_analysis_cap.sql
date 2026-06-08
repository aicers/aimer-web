-- Per-customer override for the baseline auto-analysis daily cap (#493).
--
-- The tier-B (budget-gated) per-customer daily cap resolves through the
-- same three tiers as the default model (#473), via
-- `resolveBaselineDailyCap(customerId)`
-- (`src/lib/analysis/baseline-daily-cap.ts`):
--
--   1. per-customer override  — this table
--   2. admin-set global       — `system_settings.baseline_auto_analysis_daily_cap`
--   3. env fallback           — `BASELINE_AUTO_ANALYSIS_DAILY_CAP`
--
-- One OPTIONAL row per customer, mirroring `customer_default_model`
-- (`0041`): the ABSENCE of a row means "no override, fall back to the
-- global default (or env)". Clearing the override is a plain row delete.
-- `daily_cap` is a non-negative count of tier-B baseline events admitted
-- per customer-tz calendar day; `0` disables tier B entirely (tier A is
-- uncapped regardless).

CREATE TABLE customer_baseline_analysis_cap (
  customer_id  UUID         PRIMARY KEY REFERENCES customers(id) ON DELETE CASCADE,
  daily_cap    INT          NOT NULL CHECK (daily_cap >= 0),
  updated_at   TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  updated_by   UUID         NOT NULL
);

GRANT SELECT, INSERT, UPDATE, DELETE ON customer_baseline_analysis_cap TO aimer_auth;
