-- RFC 0004 (#503) — `subjects` supertype + periodic-report re-key.
--
-- Introduces `subjects` as the first-class identity that customers
-- (and, later, groups) extend. A customer becomes a `kind='customer'`
-- subject sharing the SAME UUID as the existing `customers.id`, so no
-- id is remapped: every existing `customer_id` value is already a valid
-- `subject_id`, and `/customers/{id}` → `/subjects/{id}` is a pure path
-- swap.
--
-- The three periodic-report tables are re-keyed from `customer_id` to
-- `subject_id` because groups (a later #502 issue) also produce periodic
-- reports recorded in this shared state — they must key on the generic
-- subject identity. `periodic_report_result` (per-customer DB) is
-- re-keyed in the paired customer migration. `story_analysis_*` /
-- `event_analysis_*` stay `customer_id`-keyed (customer-side analysis
-- orchestration a group does not use) — a deliberate, likely permanent
-- split (#503).
--
-- Forward-only: pre-release reset removes the data-backfill cost, but
-- the schema still ships as a new migration (never edit an applied one;
-- the runner checksum-guards them — migrations/README.md). The
-- INSERT...SELECT below is defensive — a no-op on the reset (empty
-- `customers`) but keeps the migration correct on a populated DB.

CREATE TABLE subjects (
    id         UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
    kind       TEXT         NOT NULL
               CHECK (kind IN ('customer', 'group')),
    created_at TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

GRANT SELECT, INSERT, UPDATE, DELETE ON subjects TO aimer_auth;

-- Every existing customer is a `kind='customer'` subject sharing its
-- UUID. Idempotent / no-op on the pre-release reset (empty table).
INSERT INTO subjects (id, kind, created_at, updated_at)
SELECT id, 'customer', created_at, updated_at
  FROM customers
ON CONFLICT (id) DO NOTHING;

-- `customers` extends `subjects`: the PK is also a FK carrying the same
-- value. Deleting the subject cascades to the customer subtype.
ALTER TABLE customers
    ADD CONSTRAINT customers_id_subject_fkey
    FOREIGN KEY (id) REFERENCES subjects(id) ON DELETE CASCADE;

-- Every customer is a `kind='customer'` subject sharing its UUID. The
-- application's `createCustomer()` path inserts the `subjects` row
-- explicitly first, but a customer is a subtype of subject by definition,
-- so the invariant must hold for EVERY insert path — including the many
-- raw `INSERT INTO customers` fixtures/seeds/backfills that would
-- otherwise each have to be edited and could silently drift. This
-- BEFORE-INSERT trigger materializes the supertype row in the same
-- transaction, before the row lands, so the FK is always satisfiable.
-- `NEW.id` is already populated here (column DEFAULT runs before
-- BEFORE-row triggers), covering both explicit-id and default-id inserts.
-- `ON CONFLICT DO NOTHING` makes it a no-op when `createCustomer()`
-- already inserted the `kind='customer'` subject. But DO NOTHING also
-- silently keeps a *pre-existing* subject of a DIFFERENT kind — e.g. an
-- `INSERT INTO subjects (id, kind) VALUES ($id, 'group')` followed by an
-- `INSERT INTO customers (id, …) VALUES ($id, …)` would otherwise create
-- a customer backed by a `kind='group'` subject, violating the core
-- invariant that every customer is a `kind='customer'` subject sharing
-- its UUID (#503). Re-check after the upsert and reject that case.
CREATE FUNCTION ensure_customer_subject() RETURNS trigger AS $$
BEGIN
    INSERT INTO subjects (id, kind)
    VALUES (NEW.id, 'customer')
    ON CONFLICT (id) DO NOTHING;
    IF NOT EXISTS (
        SELECT 1 FROM subjects
         WHERE id = NEW.id AND kind = 'customer'
    ) THEN
        RAISE EXCEPTION
            'customer % cannot be backed by a non-customer subject',
            NEW.id
            USING ERRCODE = 'integrity_constraint_violation';
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER customers_ensure_subject
    BEFORE INSERT ON customers
    FOR EACH ROW EXECUTE FUNCTION ensure_customer_subject();

-- --------------------------------------------------------------------
-- periodic_report_state: customer_id → subject_id, FK → subjects(id)
-- --------------------------------------------------------------------
ALTER TABLE periodic_report_state
    DROP CONSTRAINT periodic_report_state_customer_id_fkey;
ALTER TABLE periodic_report_state
    RENAME COLUMN customer_id TO subject_id;
ALTER INDEX periodic_report_state_customer_idx
    RENAME TO periodic_report_state_subject_idx;
ALTER TABLE periodic_report_state
    ADD CONSTRAINT periodic_report_state_subject_id_fkey
    FOREIGN KEY (subject_id) REFERENCES subjects(id) ON DELETE CASCADE;

-- --------------------------------------------------------------------
-- periodic_report_job: customer_id → subject_id. The composite FK to
-- periodic_report_state and the PK / indexes follow the rename
-- automatically (Postgres tracks the columns by identity).
-- --------------------------------------------------------------------
ALTER TABLE periodic_report_job
    RENAME COLUMN customer_id TO subject_id;

-- --------------------------------------------------------------------
-- A `RENAME COLUMN` does NOT rewrite stored function bodies, so the
-- migration-0030 timezone-archive trigger still references the old
-- `customer_id` column and would error on the next
-- `UPDATE customers SET timezone = …`. Recreate it against
-- `subject_id`. The customer's `subject_id == id`, so the join key is
-- unchanged (the trigger still fires on a `customers` row and matches
-- the periodic rows for that same UUID).
-- --------------------------------------------------------------------
CREATE OR REPLACE FUNCTION fn_archive_periodic_states_on_tz_change()
RETURNS TRIGGER AS $$
BEGIN
  UPDATE periodic_report_state
     SET status = 'archived', updated_at = NOW()
   WHERE subject_id = NEW.id
     AND tz <> NEW.timezone
     AND status <> 'archived';
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
