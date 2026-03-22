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
`export default` an async function that receives a `PoolClient`:

```ts
import type { PoolClient } from "pg";

export default async function (client: PoolClient) {
  await client.query("UPDATE users SET active = true WHERE verified = true");
}
```

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

## Concurrency Safety

The migration runner acquires a PostgreSQL advisory lock before running.
This prevents multiple application replicas from applying migrations
simultaneously during a rolling deploy.
