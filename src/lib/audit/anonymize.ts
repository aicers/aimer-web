import type { Pool } from "pg";

/**
 * JSONB keys that contain PII and must be redacted on customer
 * hard-delete. Non-PII forensic context (reason, customerId,
 * connectionId, newStatus, etc.) is preserved per Discussion #10 §7.
 */
const PII_DETAIL_KEYS = ["email", "invited_email", "name"] as const;

/**
 * Anonymize audit log entries for a deleted customer.
 *
 * - PII keys in `details` are replaced with `"[redacted]"`
 * - `ip_address` is set to NULL
 * - `actor_id` is **preserved** (opaque UUID, not PII by itself)
 * - Non-PII fields in `details` are kept for forensic value
 *
 * Must be called with the audit **owner** pool (`aimer_audit_owner`)
 * because the runtime role lacks UPDATE permission.
 *
 * The self-audit INSERT uses direct SQL (not `auditLog()`) because
 * `auditLog()` writes via the runtime pool (`aimer_audit`) which
 * lacks UPDATE permission. Anonymization requires the owner pool
 * and the self-audit entry must use the same pool for consistency.
 */
export async function anonymizeCustomerAuditLogs(
  auditOwnerPool: Pool,
  customerId: string,
): Promise<void> {
  // Build a JSONB concatenation chain that replaces each PII key's
  // value with "[redacted]" only when the key exists in the row.
  const redactClauses = PII_DETAIL_KEYS.map(
    (key) =>
      `CASE WHEN details ? '${key}' THEN jsonb_build_object('${key}', '"[redacted]"'::jsonb) ELSE '{}'::jsonb END`,
  ).join(" || ");

  const anonymized = await auditOwnerPool.query(
    `UPDATE audit_logs
     SET details = CASE
           WHEN details IS NOT NULL AND details != '{}'::jsonb
           THEN details || ${redactClauses}
           ELSE details
         END,
         ip_address = NULL
     WHERE customer_id = $1`,
    [customerId],
  );

  if ((anonymized.rowCount ?? 0) > 0) {
    await auditOwnerPool.query(
      `INSERT INTO audit_logs
         (actor_id, auth_context, action, target_type, target_id,
          customer_id, details)
       VALUES ('system', 'admin', 'audit.anonymize', 'customer', $1,
               $2, $3::jsonb)`,
      [
        customerId,
        customerId,
        JSON.stringify({ rows_anonymized: anonymized.rowCount }),
      ],
    );
  }
}

/**
 * Anonymize audit log entries for a deleted customer group (#507).
 *
 * Peer of `anonymizeCustomerAuditLogs`. Group audit rows are NOT keyed by
 * `customer_id` (groups never set it) — they carry the group id in
 * `target_id` (TEXT). The group id is a globally-unique UUID, so scoping
 * by `target_id` captures exactly this group's rows
 * (`customer_group.*` / `group_retention_policy.updated` / `group_db.*`).
 *
 * Scrub target: the PII-bearing `details.name` (the human-given group
 * name, which can carry an organization name) and `ip_address`. Member
 * ids (`details.memberIds`) are opaque customer UUIDs — like `actor_id`
 * and `customer_id`, not PII by themselves — so they are PRESERVED for
 * forensic value, matching `anonymizeCustomerAuditLogs`.
 *
 * Must be called with the audit **owner** pool (`aimer_audit_owner`); the
 * runtime role lacks UPDATE permission. The self-audit INSERT uses direct
 * SQL for the same reason as the customer path.
 */
export async function anonymizeGroupAuditLogs(
  auditOwnerPool: Pool,
  groupId: string,
): Promise<void> {
  const redactClauses = PII_DETAIL_KEYS.map(
    (key) =>
      `CASE WHEN details ? '${key}' THEN jsonb_build_object('${key}', '"[redacted]"'::jsonb) ELSE '{}'::jsonb END`,
  ).join(" || ");

  const anonymized = await auditOwnerPool.query(
    `UPDATE audit_logs
     SET details = CASE
           WHEN details IS NOT NULL AND details != '{}'::jsonb
           THEN details || ${redactClauses}
           ELSE details
         END,
         ip_address = NULL
     WHERE target_id = $1`,
    [groupId],
  );

  if ((anonymized.rowCount ?? 0) > 0) {
    await auditOwnerPool.query(
      `INSERT INTO audit_logs
         (actor_id, auth_context, action, target_type, target_id,
          details)
       VALUES ('system', 'admin', 'audit.anonymize', 'customer_group', $1,
               $2::jsonb)`,
      [groupId, JSON.stringify({ rows_anonymized: anonymized.rowCount })],
    );
  }
}
