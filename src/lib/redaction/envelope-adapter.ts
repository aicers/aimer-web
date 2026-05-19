// Envelope adapter for the redaction map.
//
// The pure engine (engine.ts) returns a `RedactionMap` JSON object.
// Persistence calls Transit to wrap a fresh DEK and AES-GCM the
// serialised map. Keeping this in its own file means the engine's
// unit tests do not need to mock Transit.

import "server-only";

import { decryptPayload, encryptPayload } from "../crypto/envelope";
import { customerTransitKeyName } from "../db/customer-db";
import type { RedactionMap } from "./types";

export interface EncryptedMap {
  ciphertext: Buffer;
  wrappedDek: string;
}

/**
 * Serialise + encrypt a `RedactionMap` for storage in
 * `event_redaction_map`. The customer's Transit key is used so map
 * rows roll with KEK rotation just like detection_events did before
 * the schema refactor.
 */
export async function encryptRedactionMap(
  customerId: string,
  map: RedactionMap,
): Promise<EncryptedMap> {
  const plaintext = Buffer.from(JSON.stringify(map), "utf8");
  const keyName = customerTransitKeyName(customerId);
  return encryptPayload(plaintext, keyName);
}

/**
 * Decrypt + deserialise a `RedactionMap` row. Throws if the
 * ciphertext fails AES-GCM auth or the plaintext is not valid JSON.
 */
export async function decryptRedactionMap(
  customerId: string,
  ciphertext: Buffer,
  wrappedDek: string,
): Promise<RedactionMap> {
  const keyName = customerTransitKeyName(customerId);
  const plaintext = await decryptPayload(ciphertext, wrappedDek, keyName);
  const parsed = JSON.parse(plaintext.toString("utf8"));
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("redaction: decrypted map is not a JSON object");
  }
  return parsed as RedactionMap;
}
