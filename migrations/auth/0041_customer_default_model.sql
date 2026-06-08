-- Per-customer default analysis model (#473).
--
-- The default `(model_name, model)` pair used for new analyses and for
-- default-omitting force-regenerate / backfill calls was previously
-- read straight from env (`ANALYSIS_DEFAULT_MODEL_NAME` /
-- `ANALYSIS_DEFAULT_MODEL`). This table moves the default into the DB
-- as a per-customer override — the first tier of the three-tier
-- resolution order `customer -> admin-set global -> env` implemented by
-- `resolveDefaultModel(customerId)` (`src/lib/analysis/default-model.ts`).
--
-- One OPTIONAL row per customer. Unlike `customer_retention_policy`,
-- the provisioning transaction does NOT seed a row here: the ABSENCE of
-- a row is meaningful — it means "no per-customer override, fall back to
-- the global default (or env)". Clearing the override is a plain row
-- delete (exposed in the settings UI/API), which reverts the customer to
-- the global default. `(model_name, model)` is validated against
-- `ANALYSIS_MODEL_CATALOG` by the setter API at save time; the resolver
-- is additionally defensive and falls back to the next tier on a stale
-- value, so no DB-level CHECK against the (env-derived) catalog is
-- possible or attempted here.

CREATE TABLE customer_default_model (
  customer_id  UUID         PRIMARY KEY REFERENCES customers(id) ON DELETE CASCADE,
  model_name   TEXT         NOT NULL,
  model        TEXT         NOT NULL,
  updated_at   TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  updated_by   UUID         NOT NULL
);

GRANT SELECT, INSERT, UPDATE, DELETE ON customer_default_model TO aimer_auth;
