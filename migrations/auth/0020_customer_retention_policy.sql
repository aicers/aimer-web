-- Per-customer retention policy (RFC 0001 §"customer_retention_policy").
--
-- One row per customer. The createCustomer transaction
-- (`src/lib/auth/customers.ts`) inserts a row at provisioning time
-- with the defaults below. The schema-level default on
-- `ingestion_days` is kept so the row is well-formed even if some
-- future call path forgets to supply it, but `analysis_days` is
-- intentionally left nullable in the schema (NULL means "no expiry"
-- per RFC 0001 §"Retention") and the provisioning insert supplies
-- 1095 explicitly — defaulting NULL would silently change the
-- retention policy from "36 months" to "forever".

CREATE TABLE customer_retention_policy (
  customer_id     UUID         PRIMARY KEY REFERENCES customers(id) ON DELETE CASCADE,
  ingestion_days  INTEGER      NOT NULL DEFAULT 365 CHECK (ingestion_days >= 30),
  analysis_days   INTEGER      CHECK (analysis_days IS NULL OR analysis_days >= 30),
  updated_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  updated_by      UUID         NOT NULL
);

GRANT SELECT, INSERT, UPDATE, DELETE ON customer_retention_policy TO aimer_auth;
