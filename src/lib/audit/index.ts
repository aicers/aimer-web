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

async function writeAuditLog(params: AuditLogParams): Promise<void> {
  const correlationId = params.correlationId ?? getCorrelationId() ?? null;
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
}

/**
 * Write an entry to the `audit_logs` table.
 *
 * Fire-and-forget: errors are logged to stderr but never thrown,
 * so audit failures cannot break the request pipeline.
 */
export async function auditLog(params: AuditLogParams): Promise<void> {
  try {
    await writeAuditLog(params);
  } catch (err) {
    console.error("[audit] Failed to write audit log:", err);
  }
}

/**
 * Write an entry to the `audit_logs` table and throw on failure.
 *
 * The default `auditLog` swallows write errors so a flaky audit DB
 * cannot stall every request. Most call sites want that behavior, but
 * RFC 0002 Phase 0.5 (#295) makes the Phase 2 cursor-bearing
 * `phase2.ingest` row the recovery source for `cursor_watermark` /
 * `cursor_watermark_quality` on reconcile, so a silent audit failure
 * there would lose the watermark advance with no operator-visible
 * signal. The cursor-bearing handler awaits this variant and treats a
 * throw as the fail-closed event: log at `error` with the cursor
 * fields, leave the JTI consumed, still return a 200 success (see
 * decision 9). Other audit writes keep using `auditLog` because they
 * have no reconcile-critical payload.
 */
export async function auditLogOrThrow(params: AuditLogParams): Promise<void> {
  await writeAuditLog(params);
}
