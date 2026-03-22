# Database Migrations

This directory contains SQL and TypeScript migration files organized by
database scope.

## Directory Structure

- `auth/` — Migrations for the auth database (shared, central)
- `audit/` — Migrations for the audit database (shared, central)
- `customer/` — Migrations applied to every customer database

## File Naming Convention

Migration files must follow the pattern:

```
NNNN_description.sql   — DDL migration (schema changes)
NNNN_description.ts    — DML migration (data manipulation)
```

`NNNN` is a zero-padded four-digit version number. Migrations are applied
in lexicographic order. Examples:

```
0001_create_users.sql
0002_add_email_index.sql
0003_backfill_usernames.ts
```

## DDL vs DML Migrations

**DDL (.sql)** — Schema changes written in plain SQL. Each file runs inside
a transaction by default. Add the marker comment `-- no-transaction` on any
line to opt out of the transaction wrapper (required for statements like
`CREATE INDEX CONCURRENTLY`).

**DML (.ts)** — Data migrations written in TypeScript. The file must
`export default` an async function that receives a `PoolClient` and an
optional `MigrationContext`:

```ts
import type { PoolClient } from "pg";
import type { MigrationContext } from "@/lib/db/migrate";

export default async function (client: PoolClient, context?: MigrationContext) {
  await client.query("UPDATE users SET active = true WHERE verified = true");
}
```

The `MigrationContext` object provides helpers that are only available for
customer DB DML migrations. Currently planned:

- `decryptDek` — Decrypt a customer's wrapped DEK via OpenBao Transit
  (available after #52).

## Expand/Contract Pattern

For zero-downtime rolling deploys, use the expand/contract pattern:

1. **Expand** — Add the new column/table without removing the old one.
   Both old and new code can run against this schema.
2. **Deploy** — Roll out the application code that writes to both old and
   new columns and reads from the new one.
3. **Migrate** — Backfill existing data into the new column (DML migration).
4. **Contract** — Drop the old column/table once all replicas use the new
   code path.

Each step is a separate migration so that a failed deploy can be rolled
forward without reverting schema changes.

## Rollback Strategy

Migrations are **forward-only**. To undo a change, create a new migration
that reverses the previous one. Never edit or delete an applied migration
file — the runner validates SHA-256 checksums and will refuse to proceed
if an applied migration has been modified.

## How to Create a New Migration

1. Determine the next version number by looking at the highest existing
   `NNNN` in the target directory.
2. Create a file following the naming convention above.
3. For SQL files, write idempotent DDL when possible (`IF NOT EXISTS`).
4. Test locally by running the application (auth/audit migrations run on
   startup) or `pnpm migrate:customers` for customer migrations.

## Database Roles

Each database uses two PostgreSQL roles to enforce least-privilege access:

| Role | Example | Used by | Privileges |
| --- | --- | --- | --- |
| Owner | `aimer_auth_owner` | Migration runner | Full DDL + DML (CREATE, ALTER, DROP, INSERT, UPDATE, DELETE) |
| Runtime | `aimer_auth` | Application | Minimum required privileges (SELECT, INSERT, UPDATE, DELETE on granted tables) |

For the audit database the runtime role (`audit_writer`) is restricted to
INSERT + SELECT only — it cannot UPDATE or DELETE audit records.

The migration runner reads `DATABASE_MIGRATION_URL` /
`AUDIT_DATABASE_MIGRATION_URL` (falling back to `DATABASE_URL` /
`AUDIT_DATABASE_URL` when unset). The application runtime always uses
`DATABASE_URL` / `AUDIT_DATABASE_URL`.

Customer DB owner/runtime role separation will be implemented alongside
the customers table schema in #36.

## Concurrency Safety

The migration runner acquires a PostgreSQL advisory lock before running.
This prevents multiple application replicas from applying migrations
simultaneously during a rolling deploy.
