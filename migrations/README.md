# Database Migrations

This directory contains the SQL schema files applied by the migration
runner (`src/lib/db/migrate.ts`), organized by database scope.

## Directory Structure

- `auth/` — Schema for the auth database (shared, central)
- `audit/` — Schema for the audit database (shared, central)
- `feed/` — Schema for the threat-intel feed database (shared, central)
- `customer/` — Schema applied to every customer database
- `group/` — Schema applied to every customer-group data database

## Pre-release Policy: One `0000_init.sql` Per Scope

aimer-web is pre-release and has never been deployed. Until the first
release, each scope carries exactly one schema file, `0000_init.sql`,
and schema changes are made by **editing that file in place** — no
incremental migrations are added.

The trade-off is that dev databases must be **reset** on every schema
change (`docker compose down -v`, or drop the affected databases): the
runner records a SHA-256 checksum for every applied file and will
refuse to start against a database whose recorded `0000` checksum no
longer matches the edited file. That refusal is by design — resetting
the database is the expected response, not a workaround.

After the first release this policy flips: `0000_init.sql` is frozen,
and every schema change ships as a new numbered migration appended
after it, starting at `0001_*.sql`. From that point on, applied files
are never edited — the checksum validation enforces it.

## File Naming Convention

Migration files must follow the pattern:

```text
NNNN_description.sql
```

`NNNN` is a zero-padded four-digit version number. Migrations are
applied in lexicographic order, each inside its own transaction.

## How the Runner Applies Files

The runner tracks applied files in a `_migrations` table (version,
name, SHA-256 checksum, applied-at). On every run it:

1. Acquires a PostgreSQL advisory lock so concurrent replicas cannot
   apply migrations simultaneously during a rolling deploy.
2. Skips files already recorded in `_migrations`, after verifying the
   stored checksum still matches the file on disk (mismatch aborts).
3. Applies each pending file inside a transaction and records it.

Auth, audit, and feed migrations run on application startup. Customer and
group databases are migrated at provisioning time
(`provision-customer.ts` / `provision-group.ts`), on startup for every
active tenant, and on demand via `pnpm migrate:customers` /
`pnpm migrate:groups` (retry / disaster-recovery paths). The backup
tooling (`src/lib/backup/`) replays pending migrations after a restore.

The feed database **is** a backup/restore target as of the manual-upload
supply mode (#566). In `manual-upload` mode `ioc_feed_snapshot` holds an
operator-uploaded snapshot that is **not** re-derivable from the committed
`feeds/*` fixtures, so the feed DB now carries non-reproducible data and is
backed up/restored/verified alongside the other databases (`feed` /
`feed_db` target across `src/lib/backup/`). (Before manual-upload its only
contents were fixture-reproducible, hence its earlier absence as a target.)

## Database Roles

Each database uses two PostgreSQL roles to enforce least-privilege access:

| Role | Example | Used by | Privileges |
| --- | --- | --- | --- |
| Owner | `aimer_auth_owner` | Migration runner | Full DDL + DML (CREATE, ALTER, DROP, INSERT, UPDATE, DELETE) |
| Runtime | `aimer_auth` | Application | Minimum required privileges (SELECT, INSERT, UPDATE, DELETE on granted tables) |

For the audit database the runtime role (`aimer_audit`) is restricted
to INSERT + SELECT only — it cannot UPDATE or DELETE audit records.

The feed database follows the same owner/runtime split
(`aimer_feed_owner` / `aimer_feed`). The runtime role has
SELECT/INSERT/DELETE on `ioc_feed_snapshot` (the import path replaces a
source's rows wholesale), no UPDATE.

The migration runner reads `DATABASE_MIGRATION_URL` /
`AUDIT_DATABASE_MIGRATION_URL` / `FEED_DATABASE_MIGRATION_URL` (falling
back to `DATABASE_URL` / `AUDIT_DATABASE_URL` / `FEED_DATABASE_URL` when
unset). The application runtime always uses `DATABASE_URL` /
`AUDIT_DATABASE_URL` / `FEED_DATABASE_URL`.

Customer and group databases share two roles across all tenants:

- **`aimer_customer_owner`** — Migration runner (full DDL + DML)
- **`aimer_customer`** — Application runtime (SELECT, INSERT, UPDATE, DELETE on granted tables)

These roles are created by `infra/postgres/init-databases.sql`.
Database-level grants are applied during provisioning; table-level
grants are applied by the schema files themselves.

The migration runner uses `CUSTOMER_DATABASE_OWNER_URL` (template URL
with the owner role credentials — the database name is replaced per
tenant). Customer database names follow the convention
`customer_<uuid_without_hyphens>`, derived from `customers.id`; group
database names follow `group_<uuid_without_hyphens>`, derived from
`customer_groups.id`.
