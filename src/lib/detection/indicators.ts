/**
 * Suspicious activity detection indicators per Discussion #10 §6.
 */
export type SuspiciousIndicator =
  | "consecutive_sign_in_denials"
  | "admin_auth_denial_pattern"
  | "session_ip_mismatch"
  | "concurrent_multi_ip_sessions"
  | "bridge_abuse"
  | "bridge_scope_probing"
  | "suspended_account_sign_in";

export type AlertSeverity = "severe" | "warning";

/** All detection indicators, ordered for UI display. */
export const ALL_INDICATORS: readonly SuspiciousIndicator[] = [
  "consecutive_sign_in_denials",
  "admin_auth_denial_pattern",
  "session_ip_mismatch",
  "concurrent_multi_ip_sessions",
  "bridge_abuse",
  "bridge_scope_probing",
  "suspended_account_sign_in",
] as const;

/** Indicators that trigger immediate event-driven alerts. */
export const SEVERE_INDICATORS = new Set<SuspiciousIndicator>([
  "suspended_account_sign_in",
  "admin_auth_denial_pattern",
  "bridge_scope_probing",
]);

export function severityOf(indicator: SuspiciousIndicator): AlertSeverity {
  return SEVERE_INDICATORS.has(indicator) ? "severe" : "warning";
}
