import { NextResponse } from "next/server";
import type { z } from "zod";
import type { EnvelopeVerificationError } from "@/lib/auth/envelope-verify";

/**
 * Route-local error codes raised by the Phase 2 ingest routes themselves
 * (i.e. not by the shared envelope verification helper).
 */
export type Phase2RouteErrorCode =
  | "schema_version_mismatch"
  | "context_jti_replay"
  | "payload_schema_invalid"
  | "database_error";

/**
 * Map an {@link EnvelopeVerificationError} from the shared helper to the
 * RFC 0002 §6 Phase 2 HTTP status set. Phase 1 maps the same codes to
 * its legacy 400/403/409 status set in
 * `src/app/api/auth/bridge/route.ts` — keep the two mappings independent.
 */
export function mapEnvelopeErrorToPhase2Response(
  err: EnvelopeVerificationError,
): NextResponse {
  switch (err.code) {
    case "malformed_multipart":
    case "missing_context_token":
    case "missing_events_envelope":
    case "missing_events_data":
    case "malformed_payload":
    case "missing_external_key":
      return phase2ErrorResponse(400, err.code, err.message, err.details);

    case "invalid_context_token":
    case "invalid_events_envelope":
    case "trust_registry_key_expired":
      return phase2ErrorResponse(401, err.code, err.message, err.details);

    case "payload_customer_not_authorized":
    case "envelope_payload_aice_id_mismatch":
      return phase2ErrorResponse(403, err.code, err.message, err.details);

    case "customer_not_found":
      return phase2ErrorResponse(404, err.code, err.message, err.details);

    case "events_data_too_large":
      return phase2ErrorResponse(413, err.code, err.message, err.details);
  }
}

/** Standard error body for Phase 2 ingest routes. */
export function phase2ErrorResponse(
  status: number,
  code: Phase2RouteErrorCode | EnvelopeVerificationError["code"],
  message: string,
  details?: Record<string, unknown>,
): NextResponse {
  return NextResponse.json(
    {
      error: message,
      code,
      ...(details ? { details } : {}),
    },
    { status },
  );
}

/** Translate a Zod failure into the route-local `payload_schema_invalid` error. */
export function zodErrorResponse(error: z.ZodError): NextResponse {
  return phase2ErrorResponse(
    400,
    "payload_schema_invalid",
    "events_data payload failed schema validation",
    { issues: error.issues },
  );
}
