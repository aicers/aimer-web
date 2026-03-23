/**
 * Audit logging stub — records are silently dropped until the
 * audit infrastructure is implemented in #48.
 */
export async function auditLog(_params: {
  actorId: string;
  authContext?: "general" | "admin";
  action: string;
  targetType: string;
  targetId?: string;
  details?: Record<string, unknown>;
  ipAddress?: string;
  sid?: string;
  customerId?: string;
}): Promise<void> {
  // TODO(#48): Write to audit_logs table via audit pool
}
