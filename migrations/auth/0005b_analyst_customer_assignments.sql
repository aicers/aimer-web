CREATE TABLE analyst_customer_assignments (
  account_id  UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  customer_id UUID NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  assigned_by UUID NOT NULL REFERENCES accounts(id),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (account_id, customer_id)
);
