# Backup & Restore

This guide covers how to back up and restore all stateful components
of Clumit Insight: the central databases (`auth_db`, `audit_db`,
`feed_db`), per-customer databases, and the OpenBao secret engine.

## Prerequisites

- **PostgreSQL client tools** (`pg_dump`, `pg_restore`) on `PATH`.
  These must match (or be newer than) the PostgreSQL server version.
- **tar** for OpenBao file-storage backup.
- Environment variables configured (see
  [Environment variables](#environment-variables) below).

## Backup Targets

| Target       | What is backed up                                   |
| ------------ | --------------------------------------------------- |
| `auth`       | Central auth database (`pg_dump --format=custom`)   |
| `audit`      | Central audit database                              |
| `feed`       | Threat-intel feed database (manual-upload snapshots)|
| `customers`  | All customer databases with `database_status`       |
|              | `IN ('active', 'failed')`                           |
| `openbao`    | OpenBao `file` storage directory (KEK + DEKs)       |

The `feed` database holds Tier-1 threat-intel feed snapshots imported
through the manual-upload admin UI (see
[Threat Feeds](threat-feeds.md)). Because operator-uploaded snapshots
are not re-derivable from committed fixtures, the feed DB is a required
backup target.

Customer databases for suspended and disabled customers are included
as long as `database_status` is `active` or `failed`. Databases that
do not actually exist (failed provisioning) are skipped with a
warning.

## Running a Backup

```bash
# Full backup of all targets
pnpm backup --target=all

# Back up a single target
pnpm backup --target=auth
pnpm backup --target=audit
pnpm backup --target=feed
pnpm backup --target=customers
pnpm backup --target=openbao

# Back up a single customer
pnpm backup --target=customers --customer-id=<uuid>

# Label the backup (e.g., before a destructive operation)
pnpm backup --target=customers --customer-id=<uuid> \
  --label=pre-delete-<uuid>

# Override the backup directory
pnpm backup --target=all --output-dir=/mnt/backups
```

### Backup Directory Layout

Each backup creates a timestamped directory:

    backups/
      2026-04-02T14-30-45Z/
        auth_db.dump
        audit_db.dump
        feed_db.dump
        customers/
          customer_<uuid>.dump
        openbao/
          bao-data.tar.gz
        manifest.json

The `manifest.json` file records metadata for each target: file
path, size, duration, and any errors or skipped targets.

### Exit Codes

| Code | Meaning                             |
| ---- | ----------------------------------- |
| 0    | All backups succeeded               |
| 1    | One or more backups failed          |
| 2    | Configuration error (missing flags) |

## Scheduling Backups

The backup CLI is designed for external scheduling (e.g., cron,
systemd timer, Kubernetes CronJob). Example cron entry for a daily
backup at 03:00 UTC:

    0 3 * * * cd /opt/aimer-web && pnpm backup --target=all >> /var/log/aimer-backup.log 2>&1

## Restore Procedures

All restore operations require the `--confirm` flag to prevent
accidental execution. Use `--dry-run` to validate first.

### Full Disaster Recovery

Restore order: OpenBao -> auth_db -> audit_db -> feed_db ->
customer_dbs -> post-restore cleanup -> migration runner.

```bash
pnpm restore --target=full \
  --backup-dir=./backups/2026-04-02T14-30-45Z \
  --confirm
```

Post-restore actions (automatic unless skipped):

- All sessions are revoked
- Pending bridge connections are deleted
- Staged event data is deleted
- Migration runner applies any migrations newer than the backup

After restore:

1. Restart Keycloak
2. Unseal OpenBao
3. Run `pnpm migrate:customers` for customer DB migrations
4. Start aimer-web

### audit_db-Only Recovery

If `audit_db` is corrupted while `auth_db` is intact:

```bash
pnpm restore --target=audit \
  --backup-file=./backups/2026-04-02T14-30-45Z/audit_db.dump \
  --confirm
```

This restores `audit_db` and runs its migrations. `auth_db` is not
touched. Audit entries between the backup and the failure are lost.

### feed_db-Only Recovery

If `feed_db` is corrupted, restore it on its own:

```bash
pnpm restore --target=feed \
  --backup-file=./backups/2026-04-02T14-30-45Z/feed_db.dump \
  --confirm
```

This restores `feed_db` and runs its migrations. Other databases are
not touched. Threat-intel feed snapshots imported between the backup
and the failure are lost; re-run the manual-upload imports to recover
them.

### Single-Customer Restore

```bash
pnpm restore --target=customer \
  --customer-id=<uuid> \
  --backup-file=./backups/.../customers/customer_<uuid>.dump \
  --confirm
```

Requirements:

- The customer's wrapped DEK must still be available in OpenBao
  Transit (verify with `pnpm backup:verify`).
- `auth_db` is not touched — the customer record and memberships
  remain intact.
- Run `pnpm migrate:customers --customer-id=<uuid>` afterward.

### Hard-Delete Customer Recovery (Exceptional)

When a customer was hard-deleted (DEK destroyed), recovery requires
restoring from both `auth_db` and `customer_db` backups, plus the
OpenBao backup:

1. Restore `auth_db` backup into a temporary database:

        pnpm restore --target=auth \
          --backup-file=./backups/.../auth_db.dump \
          --skip-post-cleanup --skip-migrations --confirm

2. Extract the customer row and related records from the temporary
   database and re-insert into the live `auth_db` (manual SQL).

3. Restore `customer_db` from backup:

        pnpm restore --target=customer \
          --customer-id=<uuid> \
          --backup-file=./backups/.../customers/customer_<uuid>.dump \
          --confirm

4. Restore the DEK from the OpenBao backup:

        pnpm restore --target=openbao \
          --backup-file=./backups/.../openbao/bao-data.tar.gz \
          --confirm

5. Unseal OpenBao and verify the DEK unwraps.

6. Run customer migrations:
   `pnpm migrate:customers --customer-id=<uuid>`

Without the DEK, the customer database backup is **unrecoverable**
(data is encrypted at rest).

### OpenBao Recovery

```bash
# Stop OpenBao first
pnpm restore --target=openbao \
  --backup-file=./backups/.../openbao/bao-data.tar.gz \
  --confirm
```

After restore:

1. Unseal OpenBao (manual Shamir or auto-unseal)
2. Verify KEK and DEK availability before starting aimer-web

### Misconfiguration Recovery

For system settings, account, or trust registry misconfiguration:
do **not** restore `auth_db`. Instead, use the audit log to inspect
previous values and correct them via the admin UI or API.

## Backup Artifact Handling on Deletion

| Deletion type      | DEK status         | Backup recoverability   |
| ------------------ | ------------------ | ----------------------- |
| Hard delete        | Destroyed          | Backups unreadable      |
| Recoverable delete | Preserved in backup | Recovery within window  |

`audit_db` backups are purged by the retention policy.

## Retention and Purge

After each backup, expired directories are automatically purged.
Retention windows are configured via environment variables:

- `BACKUP_RETENTION_DAYS` (default: 30) — auth_db, feed_db, and
  customer_db
- `AUDIT_BACKUP_RETENTION_DAYS` (default: 365) — audit_db

## Verification Drills

Run periodic verification to ensure backups are restorable:

```bash
pnpm backup:verify --backup-dir=./backups/2026-04-02T14-30-45Z
```

The drill:

1. Restores each target into a temporary database
2. Runs the migration runner
3. Verifies DEK unwrap via OpenBao Transit (for customers)
4. Reads data from the restored database
5. Drops the temporary database

Results are printed as PASS/FAIL per target. Exit code 1 if any
verification fails.

## Environment Variables

| Variable                       | Required | Default      | Description                         |
| ------------------------------ | -------- | ------------ | ----------------------------------- |
| `BACKUP_DIR`                   | No       | `./backups`  | Root directory for backup storage   |
| `BACKUP_RETENTION_DAYS`        | No       | `30`         | Retention for auth/customer backups |
| `AUDIT_BACKUP_RETENTION_DAYS`  | No       | `365`        | Retention for audit backups         |
| `BAO_DATA_DIR`                 | Yes*     |              | OpenBao file storage path           |
| `BAO_ADDR`                     | Yes      |              | OpenBao API address                 |
| `BAO_TOKEN`                    | Yes      |              | OpenBao authentication token        |
| `DATABASE_MIGRATION_URL`       | Yes      |              | auth_db connection (owner role)     |
| `AUDIT_DATABASE_MIGRATION_URL` | Yes      |              | audit_db connection (owner role)    |
| `FEED_DATABASE_MIGRATION_URL`  | Yes†     |              | feed_db connection (owner role)     |
| `FEED_DATABASE_URL`            | Yes†     |              | feed_db fallback connection         |
| `DATABASE_ADMIN_URL`           | Yes      |              | Admin connection for DB operations  |
| `CUSTOMER_DATABASE_OWNER_URL`  | Yes      |              | Customer DB template (owner role)   |

*Required only for OpenBao backup/restore targets.

†Required only for the `feed` backup/restore target.
`FEED_DATABASE_MIGRATION_URL` is preferred; `FEED_DATABASE_URL` is
used as a fallback.

## Production Storage

The `BACKUP_DIR` should point to encrypted, off-host storage in
production (e.g., an encrypted NFS mount or S3-backed filesystem).
For ransomware protection, consider object storage with Object Lock
(immutable backup copies).
