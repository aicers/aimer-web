import "server-only";

import { createHash } from "node:crypto";
import { compactVerify, importJWK } from "jose";
import type { Pool } from "pg";
import type { ContextTokenClaims } from "./context-token";
import { PayloadTooLargeError, TrustRegistryKeyExpiredError } from "./errors";
import { lookupTrustRegistryKey } from "./trust-registry";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type CursorQuality = "strict" | "soft";

export interface EventsEnvelopeClaims {
  iss: string;
  aiceId: string;
  customerIds: string[];
  contextJti: string;
  payloadHash: string;
  eventCount: number;
  schemaVersion: string;
  /**
   * RFC 0002 Phase 0.5 (#295) — optional pre-batch cursor watermark.
   * Both `cursorEventTime` and `cursorQuality` must appear together
   * or both be absent; a half-present claim is rejected by
   * `verifyEventsEnvelope` as a malformed envelope.
   */
  cursorEventTime?: Date;
  cursorQuality?: CursorQuality;
}

// RFC 3339 / ISO 8601 with required `T` separator and explicit UTC
// offset (`Z` or `+HH:MM`). The sender (aice-web-next) emits
// `toISOString()` which always uses `Z`; we accept the broader RFC
// 3339 form so manual replays and SDK variants don't trip a
// false-positive malformed envelope.
const ISO_8601_UTC_PATTERN =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,9}))?(Z|([+-])(\d{2}):(\d{2}))$/;

function parseCursorEventTime(raw: unknown): Date {
  if (typeof raw !== "string") {
    throw new Error("Events envelope cursor_event_time is not ISO 8601 UTC");
  }
  const match = ISO_8601_UTC_PATTERN.exec(raw);
  if (!match) {
    throw new Error("Events envelope cursor_event_time is not ISO 8601 UTC");
  }
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = Number(match[6]);
  const fraction = match[7];
  const ms = fraction ? Number(`${fraction}000`.slice(0, 3)) : 0;
  // Range-check + round-trip via Date.UTC so calendar values that
  // Date silently normalizes (e.g. 2026-02-31 → 2026-03-03) are
  // rejected as malformed instead of stored as a real watermark.
  if (
    month < 1 ||
    month > 12 ||
    day < 1 ||
    day > 31 ||
    hour > 23 ||
    minute > 59 ||
    second > 59
  ) {
    throw new Error("Events envelope cursor_event_time is not ISO 8601 UTC");
  }
  const utcMs = Date.UTC(year, month - 1, day, hour, minute, second, ms);
  const probe = new Date(utcMs);
  if (
    probe.getUTCFullYear() !== year ||
    probe.getUTCMonth() !== month - 1 ||
    probe.getUTCDate() !== day ||
    probe.getUTCHours() !== hour ||
    probe.getUTCMinutes() !== minute ||
    probe.getUTCSeconds() !== second
  ) {
    throw new Error("Events envelope cursor_event_time is not ISO 8601 UTC");
  }
  let offsetMinutes = 0;
  if (match[8] !== "Z") {
    const sign = match[9] === "+" ? 1 : -1;
    const offsetHours = Number(match[10]);
    const offsetMins = Number(match[11]);
    if (offsetHours > 23 || offsetMins > 59) {
      throw new Error("Events envelope cursor_event_time is not ISO 8601 UTC");
    }
    offsetMinutes = sign * (offsetHours * 60 + offsetMins);
  }
  return new Date(utcMs - offsetMinutes * 60_000);
}

function parseCursorQuality(raw: unknown): CursorQuality {
  if (raw === "strict" || raw === "soft") return raw;
  throw new Error("Events envelope cursor_quality must be 'strict' or 'soft'");
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
    throw new PayloadTooLargeError(eventsData.byteLength, maxBytes);
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

  const lookup = await lookupTrustRegistryKey(
    pool,
    contextClaims.aiceId,
    contextClaims.iss,
    kid,
  );
  if (!lookup.entry) {
    if (lookup.rejection.reason === "expired") {
      throw new TrustRegistryKeyExpiredError(
        "Events envelope: trust registry key expired",
        {
          aiceId: contextClaims.aiceId,
          issuer: contextClaims.iss,
          kid,
          expiresAtMs: lookup.rejection.expiresAtMs,
        },
      );
    }
    throw new Error("Events envelope: unknown key in trust registry");
  }

  const publicKey = await importJWK(lookup.entry.publicKey, alg);
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
  const rawCursorEventTime = claims.cursor_event_time;
  const rawCursorQuality = claims.cursor_quality;

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

  // RFC 0002 Phase 0.5 (#295) — cursor_event_time + cursor_quality
  // must appear together. Partial presence indicates a sender bug, not
  // a backward-compat gap; reject the envelope so a botched sender
  // cannot accidentally short-circuit settle.
  const hasCursorTime = rawCursorEventTime !== undefined;
  const hasCursorQuality = rawCursorQuality !== undefined;
  if (hasCursorTime !== hasCursorQuality) {
    throw new Error(
      "Events envelope cursor_event_time and cursor_quality must appear together",
    );
  }
  let cursorEventTime: Date | undefined;
  let cursorQuality: CursorQuality | undefined;
  if (hasCursorTime) {
    cursorEventTime = parseCursorEventTime(rawCursorEventTime);
    cursorQuality = parseCursorQuality(rawCursorQuality);
  }

  // 4. Verify payload_hash matches SHA-256 of events_data
  // base64url encoding follows RFC 7515 (JWS) conventions used by the
  // sender (aice-web-next/src/lib/aimer/events-envelope.ts).
  const computedHash = createHash("sha256")
    .update(eventsData)
    .digest("base64url");
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
    ...(cursorEventTime !== undefined ? { cursorEventTime } : {}),
    ...(cursorQuality !== undefined ? { cursorQuality } : {}),
  };
}
