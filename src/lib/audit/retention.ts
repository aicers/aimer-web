import "server-only";

import type { Pool } from "pg";

const DEFAULT_RETENTION_DAYS = 365;

/**
 * Purge anonymized audit log entries older than the retention window.
 *
 * Only deletes rows where `ip_address IS NULL` — the anonymization
 * step nullifies IP addresses, so this predicate targets rows that
 * have already been through PII redaction (i.e., the customer has
 * been hard-deleted and the data is no longer forensically useful
 * beyond the retention period).
 *
 * Returns the number of rows deleted.
 */
export async function purgeExpiredAuditLogs(
  pool: Pool,
  retentionDays = DEFAULT_RETENTION_DAYS,
): Promise<number> {
  const result = await pool.query(
    `DELETE FROM audit_logs
     WHERE ip_address IS NULL
       AND created_at < NOW() - make_interval(days => $1)`,
    [retentionDays],
  );
  return result.rowCount ?? 0;
}
