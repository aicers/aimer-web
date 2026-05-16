import type { NextRequest } from "next/server";
import type { Pool } from "pg";
import { type ContextTokenClaims, verifyContextToken } from "./context-token";
import { getCustomerByExternalKey } from "./customers";
import { PayloadTooLargeError, TrustRegistryKeyExpiredError } from "./errors";
import {
  type EventsEnvelopeClaims,
  verifyEventsEnvelope,
} from "./events-envelope";

// ---------------------------------------------------------------------------
// Types & errors
// ---------------------------------------------------------------------------

/**
 * Semantic error codes produced by the helpers in this module. HTTP
 * status mapping is the caller's responsibility — Phase 1 maps these
 * to its historical 400/403/409 set, Phase 2 routes will map the same
 * codes to RFC 0002-aligned statuses (401/413/etc.).
 */
export type EnvelopeVerificationCode =
  | "malformed_multipart"
  | "missing_context_token"
  | "missing_events_envelope"
  | "missing_events_data"
  | "invalid_context_token"
  | "invalid_events_envelope"
  | "trust_registry_key_expired"
  | "events_data_too_large"
  | "malformed_payload"
  | "missing_external_key"
  | "payload_customer_not_authorized"
  | "envelope_payload_aice_id_mismatch"
  | "customer_not_found";

export class EnvelopeVerificationError extends Error {
  readonly code: EnvelopeVerificationCode;
  readonly details?: Record<string, unknown>;
  /**
   * Populated when the error originates from a step that runs AFTER
   * context-token verification has already succeeded (envelope verification,
   * Phase 2 cross-checks). Callers use this to emit audit entries that
   * reference the verified caller identity even on the failure path.
   */
  readonly contextClaims?: ContextTokenClaims;

  constructor(
    code: EnvelopeVerificationCode,
    message: string,
    options?: {
      cause?: unknown;
      details?: Record<string, unknown>;
      contextClaims?: ContextTokenClaims;
    },
  ) {
    super(
      message,
      options?.cause === undefined ? undefined : { cause: options.cause },
    );
    this.name = "EnvelopeVerificationError";
    this.code = code;
    this.details = options?.details;
    this.contextClaims = options?.contextClaims;
  }
}

export interface VerifiedMultipartTokens {
  contextClaims: ContextTokenClaims;
  envelopeClaims: EventsEnvelopeClaims | undefined;
  eventsData: Uint8Array | undefined;
}

export interface VerifiedPhase2Envelope {
  contextClaims: ContextTokenClaims;
  envelopeClaims: EventsEnvelopeClaims;
  eventsData: Uint8Array;
  /** UUID from the auth DB's `customers` table, resolved from `external_key`. */
  customerId: string;
  /** The payload root's `external_key`, verified against context-token scope. */
  externalKey: string;
}

// ---------------------------------------------------------------------------
// Multipart token verification (shared between Phase 1 and Phase 2)
// ---------------------------------------------------------------------------

/**
 * Parse `multipart/form-data`, verify the `context_token`, and — if
 * `events_envelope` + `events_data` are both supplied — verify the
 * events envelope.
 *
 * Presence semantics for `events_envelope` / `events_data` match Phase 1
 * exactly: both absent is the legal session-only handoff path (returns
 * `envelopeClaims: undefined, eventsData: undefined`); both present
 * triggers envelope verification; exactly one present is malformed.
 *
 * `FormData.get()` returns `null` for absent fields and `""` for
 * present-but-empty text fields. An empty string is treated as malformed,
 * not absent — preserving the Phase 1 rule that `events_data=""` (without
 * `events_envelope`) must NOT silently skip envelope validation.
 *
 * All failures throw {@link EnvelopeVerificationError}. The caller maps
 * `error.code` to its own HTTP status and audit event taxonomy — this
 * helper has no opinion on either.
 */
export async function verifyMultipartTokens(
  pool: Pool,
  request: NextRequest,
): Promise<VerifiedMultipartTokens> {
  let formData: FormData;
  try {
    formData = await request.formData();
  } catch (cause) {
    throw new EnvelopeVerificationError(
      "malformed_multipart",
      "Invalid multipart form data",
      { cause },
    );
  }

  const contextTokenField = formData.get("context_token");
  if (typeof contextTokenField !== "string" || !contextTokenField) {
    throw new EnvelopeVerificationError(
      "missing_context_token",
      "Missing context_token",
    );
  }

  let contextClaims: ContextTokenClaims;
  try {
    contextClaims = await verifyContextToken(pool, contextTokenField);
  } catch (cause) {
    if (cause instanceof TrustRegistryKeyExpiredError) {
      throw new EnvelopeVerificationError(
        "trust_registry_key_expired",
        cause.message,
        {
          cause,
          details: {
            aiceId: cause.aiceId,
            issuer: cause.issuer,
            kid: cause.kid,
            expiresAtMs: cause.expiresAtMs,
          },
        },
      );
    }
    throw new EnvelopeVerificationError(
      "invalid_context_token",
      "Invalid context token",
      { cause },
    );
  }

  const envelopeField = formData.get("events_envelope");
  const eventsDataField = formData.get("events_data");

  if (envelopeField === null && eventsDataField === null) {
    return { contextClaims, envelopeClaims: undefined, eventsData: undefined };
  }

  if (typeof envelopeField !== "string" || !envelopeField) {
    throw new EnvelopeVerificationError(
      "missing_events_envelope",
      "Missing events_envelope",
      { contextClaims },
    );
  }

  let eventsDataBytes: Uint8Array;
  if (eventsDataField instanceof File) {
    eventsDataBytes = new Uint8Array(await eventsDataField.arrayBuffer());
  } else if (
    typeof eventsDataField === "string" &&
    eventsDataField.length > 0
  ) {
    eventsDataBytes = new TextEncoder().encode(eventsDataField);
  } else {
    throw new EnvelopeVerificationError(
      "missing_events_data",
      "Missing events_data",
      { contextClaims },
    );
  }

  let envelopeClaims: EventsEnvelopeClaims;
  try {
    envelopeClaims = await verifyEventsEnvelope(
      pool,
      envelopeField,
      eventsDataBytes,
      contextClaims,
    );
  } catch (cause) {
    if (cause instanceof PayloadTooLargeError) {
      throw new EnvelopeVerificationError(
        "events_data_too_large",
        cause.message,
        {
          cause,
          contextClaims,
          details: {
            actualBytes: cause.actualBytes,
            maxBytes: cause.maxBytes,
          },
        },
      );
    }
    if (cause instanceof TrustRegistryKeyExpiredError) {
      throw new EnvelopeVerificationError(
        "trust_registry_key_expired",
        cause.message,
        {
          cause,
          contextClaims,
          details: {
            aiceId: cause.aiceId,
            issuer: cause.issuer,
            kid: cause.kid,
            expiresAtMs: cause.expiresAtMs,
          },
        },
      );
    }
    throw new EnvelopeVerificationError(
      "invalid_events_envelope",
      "Invalid events envelope",
      { cause, contextClaims },
    );
  }

  return { contextClaims, envelopeClaims, eventsData: eventsDataBytes };
}

// ---------------------------------------------------------------------------
// Phase 2-specific cross-checks
// ---------------------------------------------------------------------------

/**
 * Enforce the Phase 2 payload/envelope/context-token identifier rules
 * from RFC 0002 §6.1:
 *
 * - `events_data` parses as a JSON object whose root carries an
 *   `external_key` string.
 * - That `external_key` is a member of `contextClaims.customerIds`.
 * - If the payload root carries `source_aice_id`, it must equal the
 *   envelope's `aice_id`. Missing `source_aice_id` is allowed (the
 *   envelope `aice_id` is already authoritatively bound to the
 *   context token by the JWS verification step).
 * - The `external_key` resolves to a row in the auth DB's `customers`
 *   table; the resolved UUID is returned for per-customer routing.
 *
 * v1 parses the full `events_data` JSON to extract `external_key` /
 * `source_aice_id`. For multi-MB batches this is wasteful, but Phase 2
 * dispatchers parse the body anyway. A streaming-parse optimization is
 * a follow-up.
 */
export async function enforcePhase2CustomerScope(
  pool: Pool,
  eventsData: Uint8Array,
  contextClaims: ContextTokenClaims,
  envelopeClaims: EventsEnvelopeClaims,
): Promise<{ customerId: string; externalKey: string }> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder().decode(eventsData));
  } catch (cause) {
    throw new EnvelopeVerificationError(
      "malformed_payload",
      "events_data is not valid JSON",
      { cause, contextClaims },
    );
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new EnvelopeVerificationError(
      "malformed_payload",
      "events_data root must be a JSON object",
      { contextClaims },
    );
  }
  const root = parsed as Record<string, unknown>;

  const externalKey = root.external_key;
  if (typeof externalKey !== "string" || externalKey.length === 0) {
    throw new EnvelopeVerificationError(
      "missing_external_key",
      "events_data missing external_key",
      { contextClaims },
    );
  }

  if (!contextClaims.customerIds.includes(externalKey)) {
    throw new EnvelopeVerificationError(
      "payload_customer_not_authorized",
      "events_data external_key is not in context token customer_ids",
      { details: { externalKey }, contextClaims },
    );
  }

  // source_aice_id is conditional — per #219, the withdraw payload root is
  // `{ external_key, withdrawals }` with no aice_id. Missing is allowed;
  // present-and-mismatched is rejected.
  const sourceAiceId = root.source_aice_id;
  if (sourceAiceId !== undefined) {
    if (
      typeof sourceAiceId !== "string" ||
      sourceAiceId !== envelopeClaims.aiceId
    ) {
      throw new EnvelopeVerificationError(
        "envelope_payload_aice_id_mismatch",
        "events_data source_aice_id does not match envelope aice_id",
        {
          details: {
            payloadAiceId: sourceAiceId,
            envelopeAiceId: envelopeClaims.aiceId,
          },
          contextClaims,
        },
      );
    }
  }

  const customer = await getCustomerByExternalKey(pool, externalKey);
  if (!customer) {
    throw new EnvelopeVerificationError(
      "customer_not_found",
      "no customer row matches external_key",
      { details: { externalKey }, contextClaims },
    );
  }

  return { customerId: customer.id, externalKey };
}

// ---------------------------------------------------------------------------
// Phase 2 convenience wrapper
// ---------------------------------------------------------------------------

/**
 * Phase 2 entry point. Calls {@link verifyMultipartTokens} (rejecting
 * the session-only handoff path — Phase 2 requires `events_envelope` +
 * `events_data`) and then {@link enforcePhase2CustomerScope}.
 *
 * **IMPORTANT — jti replay protection is NOT handled here.** This
 * helper performs envelope / payload identity checks only; it does
 * NOT consume `contextClaims.jti` against any replay store. Phase 2
 * callers MUST consume the jti via their own replay store BEFORE
 * performing any side-effects (DB writes, external calls). Phase 1
 * gets replay protection from the `pending_connections.jti` UNIQUE
 * constraint hit at `createPendingConnection`; Phase 2 must define
 * its own mechanism in #218 / #219.
 */
export async function verifyPhase2Multipart(
  pool: Pool,
  request: NextRequest,
): Promise<VerifiedPhase2Envelope> {
  const tokens = await verifyMultipartTokens(pool, request);
  if (!tokens.envelopeClaims || !tokens.eventsData) {
    throw new EnvelopeVerificationError(
      "missing_events_envelope",
      "Phase 2 requires events_envelope and events_data",
    );
  }
  const { customerId, externalKey } = await enforcePhase2CustomerScope(
    pool,
    tokens.eventsData,
    tokens.contextClaims,
    tokens.envelopeClaims,
  );
  return {
    contextClaims: tokens.contextClaims,
    envelopeClaims: tokens.envelopeClaims,
    eventsData: tokens.eventsData,
    customerId,
    externalKey,
  };
}
