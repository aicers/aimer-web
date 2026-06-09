-- RFC 0004 (#506) — customer groups: data model, timezone, retention policy.
--
-- A customer group is a `kind='group'` subject (RFC 0004 / #503) that
-- aggregates >= 2 member customers. Like `customers`, the group subtype
-- shares its UUID with its `subjects` supertype row; the create path
-- inserts the `subjects (kind='group')` row first, in the same
-- transaction, mirroring `createCustomer()`.
--
-- This migration is auth-DB only and is INDEPENDENT of group dedicated
-- data-DB provisioning (#507): the entity, its timezone, the permission
-- gates, and the (auth-DB, subject_id-keyed) retention policy all land
-- without a group data DB existing.

-- --------------------------------------------------------------------
-- subjects: composite-FK target.
--
-- A plain `id REFERENCES subjects(id)` does not prove the subject is a
-- group — it could point at a `kind='customer'` subject. The group
-- subtype below uses a composite FK `(id, kind) REFERENCES
-- subjects(id, kind)` so the subtype row can only attach to a
-- group-kind subject. That composite FK needs a UNIQUE (id, kind) on
-- `subjects` (the PK is `id` alone — #503's 0048). `id` is already
-- unique, so this constraint is redundant for uniqueness; it exists
-- solely to be a valid composite-FK target.
-- --------------------------------------------------------------------
ALTER TABLE subjects
    ADD CONSTRAINT subjects_id_kind_key UNIQUE (id, kind);

-- --------------------------------------------------------------------
-- customer_groups: the group subtype of `subjects`.
--
-- `kind` is a constant structural guard (CHECK (kind = 'group')) that,
-- together with the composite FK, makes "this subject is a group"
-- provable at the DB level. It is a DB-only guard — the API never
-- exposes it (the `/api/groups` namespace already implies the kind).
--
-- `created_by` records who created the group and is IMMUTABLE (a trigger
-- below blocks UPDATEs of it). `owner_id` is the single, MUTABLE owner,
-- initialized to the creator on create; ownership transfer and the
-- owner-only gates live in lifecycle (#510), so `owner_id` is left
-- updatable here.
--
-- `tz` is the group's report bucket timezone, resolved at creation
-- (auto-adopted when members agree, else creator-chosen). It is pinned
-- against later member-tz changes and re-settable via the timezone
-- endpoint (future buckets only).
-- --------------------------------------------------------------------
CREATE TABLE customer_groups (
    id          UUID         PRIMARY KEY,
    kind        TEXT         NOT NULL DEFAULT 'group'
                CHECK (kind = 'group'),
    name        TEXT         NOT NULL,
    description TEXT,
    created_by  UUID         NOT NULL REFERENCES accounts(id),
    owner_id    UUID         NOT NULL REFERENCES accounts(id),
    tz          TEXT         NOT NULL,
    created_at  TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    updated_at  TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    -- The subtype can only attach to a group-kind subject. Deleting the
    -- subject cascades the group subtype away (entity-level delete).
    CONSTRAINT customer_groups_id_kind_subject_fkey
        FOREIGN KEY (id, kind) REFERENCES subjects(id, kind) ON DELETE CASCADE
);

GRANT SELECT, INSERT, UPDATE, DELETE ON customer_groups TO aimer_auth;

-- --------------------------------------------------------------------
-- customer_group_members: the (group, customer) join.
--
-- Membership is IMMUTABLE after creation: there is no add/remove API,
-- and create is the only writer. As defense-in-depth a trigger blocks
-- UPDATE (below) — but DELETE must remain allowed so the delete cascade
-- (from the subject row, through `customer_groups`, to these rows)
-- works. A customer may belong to multiple groups (flat, no nesting);
-- the PK enforces a customer appears at most once per group.
-- --------------------------------------------------------------------
CREATE TABLE customer_group_members (
    group_id    UUID NOT NULL REFERENCES customer_groups(id) ON DELETE CASCADE,
    customer_id UUID NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
    PRIMARY KEY (group_id, customer_id)
);

CREATE INDEX customer_group_members_customer_idx
    ON customer_group_members (customer_id);

-- No UPDATE grant: membership is immutable. SELECT/INSERT/DELETE only.
GRANT SELECT, INSERT, DELETE ON customer_group_members TO aimer_auth;

-- --------------------------------------------------------------------
-- group_retention_policy: per-group analysis-retention policy.
--
-- A subject-scoped policy row keyed by `subject_id`, a peer of
-- `customer_retention_policy` (0020). It lives in the auth DB (NOT the
-- group's data DB), keyed by `subject_id` — matching the customer
-- policy's location and the `subject_id` keying #503 established. This
-- deliberately OVERRIDES RFC 0004's "on the group database" wording so
-- #506 stays independent of group-DB provisioning (#507) and consistent
-- with `customer_retention_policy`. #509's reaper reads both this policy
-- and the member `customer_retention_policy` rows from the auth DB.
--
-- `analysis_days` is the per-group analysis-retention window the API
-- exposes as `groupPolicyDays`. Groups aggregate member data and do not
-- ingest directly, so (unlike `customer_retention_policy`) there is no
-- `ingestion_days`. NULL means "no expiry" (matching the customer
-- policy's nullable analysis_days).
--
-- The DDL default 1095 mirrors DEFAULT_ANALYSIS_RETENTION_DAYS in
-- `src/lib/auth/retention-defaults.ts` (the customer analysis-retention
-- default). SQL cannot import the TS constant, so the literal is kept in
-- sync manually — the runtime creation path sources the value FROM the
-- constant; this default only well-forms rows created outside that path.
-- --------------------------------------------------------------------
CREATE TABLE group_retention_policy (
    subject_id    UUID         PRIMARY KEY
                  REFERENCES subjects(id) ON DELETE CASCADE,
    analysis_days INTEGER      DEFAULT 1095
                  CHECK (analysis_days IS NULL OR analysis_days >= 30),
    updated_at    TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    updated_by    UUID         NOT NULL
);

GRANT SELECT, INSERT, UPDATE, DELETE ON group_retention_policy TO aimer_auth;

-- --------------------------------------------------------------------
-- Immutability triggers (defense-in-depth — the primary guarantee is
-- the API surface, which exposes no membership edit and never updates
-- `created_by`).
-- --------------------------------------------------------------------

-- Block UPDATE of `customer_group_members` entirely (membership is
-- immutable). DELETE is intentionally still allowed so the delete
-- cascade works.
CREATE FUNCTION customer_group_members_block_update() RETURNS trigger AS $$
BEGIN
    RAISE EXCEPTION
        'customer_group_members is immutable; membership cannot be edited'
        USING ERRCODE = 'integrity_constraint_violation';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER customer_group_members_no_update
    BEFORE UPDATE ON customer_group_members
    FOR EACH ROW EXECUTE FUNCTION customer_group_members_block_update();

-- Block UPDATE of `customer_groups.created_by` (it records the creator
-- and never changes). `owner_id` is deliberately NOT locked — #510
-- updates it on transfer.
CREATE FUNCTION customer_groups_protect_created_by() RETURNS trigger AS $$
BEGIN
    IF NEW.created_by IS DISTINCT FROM OLD.created_by THEN
        RAISE EXCEPTION
            'customer_groups.created_by is immutable'
            USING ERRCODE = 'integrity_constraint_violation';
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER customer_groups_protect_created_by
    BEFORE UPDATE OF created_by ON customer_groups
    FOR EACH ROW EXECUTE FUNCTION customer_groups_protect_created_by();
