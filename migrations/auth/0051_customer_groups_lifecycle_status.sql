-- RFC 0004 (#510) — group generation/lifecycle status.
--
-- `lifecycle_status` tracks whether a group's report GENERATION is running
-- (`active`) or PAUSED (`suspended`) because one of its member customers is
-- not operational. It is DISTINCT from `database_status` (added in #507),
-- which tracks the group's OWN dedicated database provisioning lifecycle —
-- the two must never be conflated. A suspended group keeps its database and
-- existing reports (read-only); generation simply does not advance until
-- every member is operational again.
--
-- Suspend predicate (owned by #510's lifecycle evaluator): any member
-- customer `status IN ('suspended', 'disabled')` OR `database_status =
-- 'failed'`. Resume (back to `active`) only when ALL members are
-- `status = 'active'` AND `database_status = 'active'`. The #508 generation
-- pipeline reads this flag; this issue owns setting and clearing it.
--
-- Pre-release dev DB reset policy applies — no backfill of existing rows is
-- required. Forward-only; never edit an applied migration.

ALTER TABLE customer_groups
    ADD COLUMN lifecycle_status TEXT NOT NULL DEFAULT 'active'
        CHECK (lifecycle_status IN ('active', 'suspended'));
