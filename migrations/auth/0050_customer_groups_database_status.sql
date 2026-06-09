-- RFC 0004 (#507) — group dedicated database provisioning state.
--
-- Mirror the per-customer provisioning columns onto `customer_groups`,
-- 1:1 with `customers`. A group gets its own dedicated data DB (peer of
-- the per-customer DBs) holding generated results only; this migration
-- records that DB's provisioning lifecycle and its wrapped DEK.
--
-- DESIGN OVERRIDE: RFC 0004 phrases provisioning state as a
-- "subject-level status" (`customers.database_status` → a status on the
-- `subjects` supertype). This issue deliberately reads that as a
-- per-subtype peer column on `customer_groups`, the same way #506 placed
-- the group retention policy in the auth DB rather than the group DB.
-- Hoisting `database_status` onto `subjects` would force edits to the
-- already-landed, tested customer provisioning path (provision-customer,
-- delete-customer, the customer create route, and #506's member-
-- eligibility check that reads `customers.database_status = 'active'`) —
-- a regression surface this issue should not open. Keeping the status
-- per-subtype is the lower-blast-radius mirror. The RFC text is
-- reconciled separately.
--
-- `database_status` lifecycle mirrors `customers`: starts at
-- 'provisioning', flips to 'active' once the group DB is created,
-- migrated and DEK-wrapped, or 'failed' on any provisioning error
-- (retry-safe). `wrapped_dek` is the OpenBao Transit-wrapped per-group
-- DEK, populated during provisioning (nullable until then).
--
-- Pre-release dev DB reset policy applies — no backfill of existing rows
-- is required. Forward-only; never edit an applied migration.

ALTER TABLE customer_groups
    ADD COLUMN database_status TEXT NOT NULL DEFAULT 'provisioning'
        CHECK (database_status IN ('provisioning', 'active', 'failed')),
    ADD COLUMN wrapped_dek TEXT;
