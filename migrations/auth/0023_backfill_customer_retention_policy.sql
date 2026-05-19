-- Backfill: insert a customer_retention_policy row for every
-- pre-existing customer that does not have one yet.
--
-- Greenfield prod has no pre-existing customers, but dev/staging
-- environments may. The retention sweeper (#255) and settings UI
-- (#252) treat the absence of a row as a bug, so we close the gap
-- now rather than during the first downstream change.
--
-- updated_by resolution per the rule in issue #250:
--   1. Earliest Manager membership by (created_at ASC, account_id ASC).
--   2. If no Manager membership exists, fall back to the nil UUID
--      sentinel '00000000-0000-0000-0000-000000000000' (documented as
--      "no Manager assignable at backfill time") so the NOT NULL
--      constraint holds without inventing a fake account row.
--
-- analysis_days = 1095 (≈ 36 months) is supplied explicitly. The
-- column default in the schema is NULL ("no expiry") which is the
-- operator-opted unlimited state; defaulting NULL at backfill time
-- would silently flip the policy from 36 months to forever.

INSERT INTO customer_retention_policy (customer_id, ingestion_days, analysis_days, updated_by)
SELECT
  c.id,
  365,
  1095,
  COALESCE(
    (
      SELECT m.account_id
      FROM account_customer_memberships m
      JOIN roles r ON r.id = m.role_id
      WHERE m.customer_id = c.id
        AND r.name = 'Manager'
      ORDER BY m.created_at ASC, m.account_id ASC
      LIMIT 1
    ),
    '00000000-0000-0000-0000-000000000000'::uuid
  )
FROM customers c
WHERE NOT EXISTS (
  SELECT 1 FROM customer_retention_policy p WHERE p.customer_id = c.id
);
