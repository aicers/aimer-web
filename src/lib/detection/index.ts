import "server-only";

import { getCorrelationId } from "../audit/correlation";
import { getAuditPool } from "../db/client";
import type { AlertSeverity, SuspiciousIndicator } from "./indicators";
import { severityOf } from "./indicators";

export type { AlertSeverity, SuspiciousIndicator } from "./indicators";

export interface AlertParams {
  indicator: SuspiciousIndicator;
  severity?: AlertSeverity;
  actorId?: string;
  ipAddress?: string;
  summary: Record<string, unknown>;
  auditLogIds?: number[];
  correlationId?: string;
}

/**
 * Insert a suspicious activity alert.
 *
 * Fire-and-forget: errors are logged to stderr but never thrown,
 * so detection failures cannot break the request pipeline.
 */
export async function insertAlert(params: AlertParams): Promise<void> {
  const severity = params.severity ?? severityOf(params.indicator);

  try {
    const pool = getAuditPool();
    await pool.query(
      `INSERT INTO suspicious_activity_alerts
         (indicator, severity, actor_id, ip_address, summary,
          audit_log_ids, correlation_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7::uuid)`,
      [
        params.indicator,
        severity,
        params.actorId ?? null,
        params.ipAddress ?? null,
        JSON.stringify(params.summary),
        params.auditLogIds ?? [],
        params.correlationId ?? getCorrelationId() ?? null,
      ],
    );
  } catch (err) {
    console.error("[detection] Failed to insert alert:", err);
  }
}

/**
 * Emit a severe alert synchronously at the call site.
 * Convenience wrapper that forces severity to "severe".
 */
export async function emitSevereAlert(
  params: Omit<AlertParams, "severity">,
): Promise<void> {
  return insertAlert({ ...params, severity: "severe" });
}
