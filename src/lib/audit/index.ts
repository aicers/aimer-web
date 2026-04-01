import "server-only";

import { getAuditPool } from "../db/client";
import type { AuditAction } from "./actions";
import { getCorrelationId } from "./correlation";

export type { AuditAction } from "./actions";
export { getCorrelationId, withCorrelationId } from "./correlation";

/** Actor context for audit event emission from service functions. */
export interface ActorContext {
  actorId: string;
  authContext: "general" | "admin";
  ipAddress?: string;
  sid?: string;
}

/**
 * Actor ID for pre-authentication requests where the caller's identity
 * cannot be determined (e.g. invalid context token on bridge entry).
 *
 * Discussion #10 §5 defines actor_id as "account UUID or `system`".
 * `unknown` is an additional sentinel for requests that fail before
 * any identity can be established.
 */
export const UNKNOWN_ACTOR_ID = "unknown";

export interface AuditLogParams {
  actorId: string;
  authContext?: "general" | "admin";
  action: AuditAction;
  targetType: string;
  targetId?: string;
  details?: Record<string, unknown>;
  ipAddress?: string;
  sid?: string;
  customerId?: string;
  aiceId?: string;
  /** Override the auto-populated correlation ID from AsyncLocalStorage. */
  correlationId?: string;
}

/**
 * Write an entry to the `audit_logs` table.
 *
 * Fire-and-forget: errors are logged to stderr but never thrown,
 * so audit failures cannot break the request pipeline.
 */
export async function auditLog(params: AuditLogParams): Promise<void> {
  const correlationId = params.correlationId ?? getCorrelationId() ?? null;

  try {
    const pool = getAuditPool();
    await pool.query(
      `INSERT INTO audit_logs
         (actor_id, auth_context, action, target_type, target_id,
          details, ip_address, sid, customer_id, aice_id, correlation_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8::uuid, $9::uuid, $10, $11::uuid)`,
      [
        params.actorId,
        params.authContext ?? null,
        params.action,
        params.targetType,
        params.targetId ?? null,
        params.details ? JSON.stringify(params.details) : null,
        params.ipAddress ?? null,
        params.sid ?? null,
        params.customerId ?? null,
        params.aiceId ?? null,
        correlationId,
      ],
    );
  } catch (err) {
    console.error("[audit] Failed to write audit log:", err);
  }
}
