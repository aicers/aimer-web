-- Customer-registered public IP ranges used by the redaction engine
-- (RFC 0001 §"customer_redaction_ranges"). Live in auth_db so the
-- ranges are looked up by `customer_id` before any per-customer DB
-- is opened.

CREATE TABLE customer_redaction_ranges (
  id          UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id UUID         NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  cidr        CIDR         NOT NULL,
  ip_version  SMALLINT     NOT NULL CHECK (ip_version IN (4, 6)),
  created_at  TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  created_by  UUID         NOT NULL,
  UNIQUE (customer_id, cidr)
);

CREATE INDEX customer_redaction_ranges_customer_id_idx
  ON customer_redaction_ranges (customer_id);

GRANT SELECT, INSERT, DELETE ON customer_redaction_ranges TO aimer_auth;
