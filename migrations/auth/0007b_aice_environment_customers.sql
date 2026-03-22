CREATE TABLE aice_environment_customers (
  aice_id     TEXT NOT NULL REFERENCES aice_environments(aice_id) ON DELETE CASCADE,
  customer_id UUID NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (aice_id, customer_id)
);
