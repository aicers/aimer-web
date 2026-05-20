import type { AnalyzeErrorCode } from "./analyze-types";

/**
 * Error codes surfaced by the analyze-bridge wrapping endpoint.
 *
 * Superset of the closed `AnalyzeErrorCode` union emitted by the JSON
 * `/api/analysis/analyze` route, plus bridge-only codes for JWS /
 * cross-binding failures. The JSON analyze route's nominal output
 * surface stays exactly as declared in RFC 0001 — only the bridge
 * endpoint can emit `invalid_context_token`,
 * `invalid_events_envelope`, or `invalid_analyze_params_token`. Each
 * of the three crypto codes is kept distinct for diagnostic clarity:
 * collapsing them would hide which JWS layer actually failed.
 */
export type AnalyzeBridgeErrorCode =
  | AnalyzeErrorCode
  | "invalid_context_token"
  | "invalid_events_envelope"
  | "invalid_analyze_params_token";

/**
 * Human-readable, end-user-facing summary for each error code. The
 * analyze-bridge endpoint surfaces these on a styled error page rather
 * than as JSON — the user reaches the wrapping endpoint via a top-level
 * navigation in a new tab, not a programmatic XHR.
 */
export const ANALYZE_BRIDGE_ERROR_TITLES: Record<
  AnalyzeBridgeErrorCode,
  string
> = {
  invalid_event_data: "Invalid request",
  event_key_mismatch: "Event mismatch",
  lang_unsupported: "Unsupported language",
  event_data_too_large: "Request too large",
  authorization_failed: "Not authorized",
  aimer_auth_failed: "Authentication with aimer failed",
  aimer_invalid_request: "aimer rejected the request",
  aimer_call_failed: "aimer call failed",
  aimer_unavailable: "aimer is unavailable",
  redaction_failed: "Redaction failed",
  storage_failed: "Storage failed",
  internal_error: "Internal error",
  invalid_context_token: "Invalid context token",
  invalid_events_envelope: "Invalid events envelope",
  invalid_analyze_params_token: "Invalid analyze parameters token",
};
