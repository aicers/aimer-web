-- Customer-registered owned domains used by the redaction engine
-- (RFC 0001 Amendment A.2). Live in auth_db so the suffixes are looked
-- up by `customer_id` before any per-customer DB is opened — parallel
-- to `customer_redaction_ranges` (0019).
--
-- Only a customer's OWN domains (and their subdomains) are masked in
-- event payloads; external domains pass through, mirroring the
-- external-IP pass-through for ranges. The suffix is stored normalized
-- (lowercased, leading-dot-normalized) for suffix matching.

CREATE TABLE customer_owned_domains (
  id                  UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id         UUID        NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  owned_domain_suffix TEXT        NOT NULL,  -- normalized: lowercased, leading-dot-normalized for suffix matching
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_by          UUID        NOT NULL,
  UNIQUE (customer_id, owned_domain_suffix)
);

CREATE INDEX customer_owned_domains_customer_id_idx
  ON customer_owned_domains (customer_id);

GRANT SELECT, INSERT, DELETE ON customer_owned_domains TO aimer_auth;
