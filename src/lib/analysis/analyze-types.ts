/**
 * Shape of a stored `event_analysis_result` row, with field names matching
 * the DB columns. Keys mirror the SQL column names (snake_case) because the
 * result page renders these directly without a presentation-layer rename.
 */
export interface EventAnalysisResultRow {
  aice_id: string;
  event_key: string;
  lang: "KOREAN" | "ENGLISH";
  model_name: string;
  model: string;
  model_actual_version: string | null;
  prompt_version: string | null;
  severity_score: number;
  likelihood_score: number;
  priority_tier: "CRITICAL" | "HIGH" | "MEDIUM" | "LOW";
  severity_factors: string[];
  likelihood_factors: string[];
  ttp_tags: string[];
  analysis_text: string;
  redaction_policy_version: string;
  requested_by: string;
  requested_at: Date;
}

/**
 * Canonical error codes for `POST /api/analysis/analyze` per RFC 0001
 * §"API contract — Errors". The set is exhaustive: the route surfaces
 * exactly one of these, never a free-form string.
 */
export type AnalyzeErrorCode =
  | "invalid_event_data"
  | "event_key_mismatch"
  | "event_time_invalid"
  | "lang_unsupported"
  | "event_data_too_large"
  | "authorization_failed"
  | "aimer_auth_failed"
  | "aimer_invalid_request"
  | "aimer_call_failed"
  | "aimer_unavailable"
  | "redaction_failed"
  | "storage_failed"
  | "internal_error";

export interface AnalyzeErrorBody {
  error: {
    code: AnalyzeErrorCode;
    message: string;
    retryable: boolean;
  };
}

const ERROR_RETRYABLE: Record<AnalyzeErrorCode, boolean> = {
  invalid_event_data: false,
  event_key_mismatch: false,
  event_time_invalid: false,
  lang_unsupported: false,
  event_data_too_large: false,
  authorization_failed: false,
  aimer_auth_failed: false,
  aimer_invalid_request: false,
  aimer_call_failed: true,
  aimer_unavailable: true,
  redaction_failed: false,
  storage_failed: true,
  internal_error: false,
};

const ERROR_HTTP_STATUS: Record<AnalyzeErrorCode, number> = {
  invalid_event_data: 400,
  event_key_mismatch: 400,
  event_time_invalid: 400,
  lang_unsupported: 400,
  event_data_too_large: 413,
  authorization_failed: 403,
  aimer_auth_failed: 502,
  aimer_invalid_request: 502,
  aimer_call_failed: 502,
  aimer_unavailable: 503,
  redaction_failed: 500,
  storage_failed: 500,
  internal_error: 500,
};

export function analyzeErrorResponse(
  code: AnalyzeErrorCode,
  message: string,
): Response {
  const body: AnalyzeErrorBody = {
    error: { code, message, retryable: ERROR_RETRYABLE[code] },
  };
  return Response.json(body, { status: ERROR_HTTP_STATUS[code] });
}
