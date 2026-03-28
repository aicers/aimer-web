import "server-only";

import { createHash } from "node:crypto";
import { compactVerify, importJWK } from "jose";
import type { Pool } from "pg";
import type { ContextTokenClaims } from "./context-token";
import { lookupTrustRegistryKey } from "./trust-registry";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface EventsEnvelopeClaims {
  iss: string;
  aiceId: string;
  customerIds: string[];
  contextJti: string;
  payloadHash: string;
  eventCount: number;
  schemaVersion: string;
}

// ---------------------------------------------------------------------------
// Limits
// ---------------------------------------------------------------------------

const DEFAULT_MAX_PAYLOAD_BYTES = 50 * 1024 * 1024; // 50 MB

function getMaxPayloadBytes(): number {
  const envVal = process.env.BRIDGE_MAX_PAYLOAD_BYTES;
  if (envVal) {
    const parsed = Number(envVal);
    if (Number.isFinite(parsed) && parsed > 0) return parsed;
  }
  return DEFAULT_MAX_PAYLOAD_BYTES;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Verify a detection event envelope (JWS compact serialization) and
 * its associated binary payload.
 *
 * Steps:
 * 1. Check payload size cap (before any crypto)
 * 2. Verify JWS signature using trust registry key
 * 3. Parse envelope claims
 * 4. Verify payload_hash matches SHA-256 of events_data
 * 5. Verify context_jti matches context token's jti
 * 6. Verify iss, aice_id, customer_ids match context token
 *
 * Throws on any verification failure.
 */
export async function verifyEventsEnvelope(
  pool: Pool,
  envelope: string,
  eventsData: Uint8Array,
  contextClaims: ContextTokenClaims,
): Promise<EventsEnvelopeClaims> {
  // 1. Size cap check — before any crypto
  const maxBytes = getMaxPayloadBytes();
  if (eventsData.byteLength > maxBytes) {
    throw new Error(
      `Events data exceeds size cap (${eventsData.byteLength} > ${maxBytes} bytes)`,
    );
  }

  // 2. Verify JWS signature
  // Decode protected header to extract kid and alg
  const envelopeParts = envelope.split(".");
  if (envelopeParts.length !== 3) {
    throw new Error("Invalid events envelope format");
  }

  const header = JSON.parse(
    Buffer.from(envelopeParts[0], "base64url").toString("utf8"),
  );
  const kid = header.kid;
  const alg = header.alg;
  if (typeof kid !== "string" || typeof alg !== "string") {
    throw new Error("Events envelope header missing kid or alg");
  }

  const entry = await lookupTrustRegistryKey(
    pool,
    contextClaims.aiceId,
    contextClaims.iss,
    kid,
  );
  if (!entry) {
    throw new Error("Events envelope: unknown key in trust registry");
  }

  const publicKey = await importJWK(entry.publicKey, alg);
  const { payload: rawPayload } = await compactVerify(envelope, publicKey);

  // 3. Parse envelope claims
  const claims = JSON.parse(new TextDecoder().decode(rawPayload));

  const iss = claims.iss;
  const aiceId = claims.aice_id;
  const customerIds = claims.customer_ids;
  const contextJti = claims.context_jti;
  const payloadHash = claims.payload_hash;
  const eventCount = claims.event_count;
  const schemaVersion = claims.schema_version;

  if (typeof iss !== "string") {
    throw new Error("Events envelope missing iss");
  }
  if (typeof aiceId !== "string") {
    throw new Error("Events envelope missing aice_id");
  }
  if (!Array.isArray(customerIds)) {
    throw new Error("Events envelope missing customer_ids");
  }
  if (typeof contextJti !== "string") {
    throw new Error("Events envelope missing context_jti");
  }
  if (typeof payloadHash !== "string") {
    throw new Error("Events envelope missing payload_hash");
  }
  if (typeof eventCount !== "number") {
    throw new Error("Events envelope missing event_count");
  }
  if (typeof schemaVersion !== "string") {
    throw new Error("Events envelope missing schema_version");
  }

  // 4. Verify payload_hash matches SHA-256 of events_data
  const computedHash = createHash("sha256").update(eventsData).digest("hex");
  if (computedHash !== payloadHash) {
    throw new Error("Events envelope payload_hash mismatch");
  }

  // 5. Verify context_jti binding
  if (contextJti !== contextClaims.jti) {
    throw new Error("Events envelope context_jti does not match context token");
  }

  // 6. Verify iss, aice_id, customer_ids match context token exactly
  if (iss !== contextClaims.iss) {
    throw new Error("Events envelope iss does not match context token");
  }
  if (aiceId !== contextClaims.aiceId) {
    throw new Error("Events envelope aice_id does not match context token");
  }

  const contextSet = new Set(contextClaims.customerIds);
  const envelopeSet = new Set(customerIds as string[]);
  if (
    contextSet.size !== envelopeSet.size ||
    ![...contextSet].every((id) => envelopeSet.has(id))
  ) {
    throw new Error(
      "Events envelope customer_ids does not match context token",
    );
  }

  return {
    iss,
    aiceId,
    customerIds: customerIds as string[],
    contextJti,
    payloadHash,
    eventCount,
    schemaVersion,
  };
}
