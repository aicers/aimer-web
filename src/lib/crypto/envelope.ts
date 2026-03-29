import "server-only";

import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { dekCache } from "./dek-cache";
import {
  type DataKey,
  decryptDataKey,
  generateDataKey,
  getTransitConfig,
} from "./transit";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const AES_ALGORITHM = "aes-256-gcm";
const IV_BYTES = 12;
const AUTH_TAG_BYTES = 16;
const DEFAULT_KEY_NAME = "staging-events";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface EncryptedPayload {
  /** IV (12B) || GCM ciphertext || auth tag (16B) */
  ciphertext: Buffer;
  /** Transit-wrapped DEK (base64 string) */
  wrappedDek: string;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function zeroDek(dek: DataKey | Buffer): void {
  const buf = Buffer.isBuffer(dek) ? dek : dek.plaintext;
  buf.fill(0);
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Encrypt a plaintext payload using envelope encryption.
 *
 * 1. Generate a fresh DEK via OpenBao Transit
 * 2. AES-256-GCM encrypt the payload with the DEK
 * 3. Zero the plaintext DEK
 * 4. Return ciphertext + Transit-wrapped DEK
 */
export async function encryptPayload(
  plaintext: Buffer,
  keyName = DEFAULT_KEY_NAME,
): Promise<EncryptedPayload> {
  const config = getTransitConfig();
  const dataKey = await generateDataKey(config, keyName);

  try {
    const iv = randomBytes(IV_BYTES);
    const cipher = createCipheriv(AES_ALGORITHM, dataKey.plaintext, iv);
    const encrypted = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    const authTag = cipher.getAuthTag();

    const ciphertext = Buffer.concat([iv, encrypted, authTag]);

    return { ciphertext, wrappedDek: dataKey.wrappedDek };
  } finally {
    zeroDek(dataKey);
  }
}

/**
 * Decrypt a payload that was encrypted with `encryptPayload`.
 *
 * 1. Unwrap the DEK via OpenBao Transit
 * 2. AES-256-GCM decrypt
 * 3. Zero the DEK
 * 4. Return plaintext
 */
export async function decryptPayload(
  ciphertext: Buffer,
  wrappedDek: string,
  keyName = DEFAULT_KEY_NAME,
): Promise<Buffer> {
  const minLength = IV_BYTES + AUTH_TAG_BYTES;
  if (ciphertext.length < minLength) {
    throw new Error("Ciphertext too short");
  }

  const cached = dekCache.get(keyName, wrappedDek);
  const dek =
    cached ?? (await decryptDataKey(getTransitConfig(), keyName, wrappedDek));
  if (!cached) {
    dekCache.set(keyName, wrappedDek, dek);
  }

  try {
    const iv = ciphertext.subarray(0, IV_BYTES);
    const authTag = ciphertext.subarray(ciphertext.length - AUTH_TAG_BYTES);
    const encryptedData = ciphertext.subarray(
      IV_BYTES,
      ciphertext.length - AUTH_TAG_BYTES,
    );

    const decipher = createDecipheriv(AES_ALGORITHM, dek, iv);
    decipher.setAuthTag(authTag);
    return Buffer.concat([decipher.update(encryptedData), decipher.final()]);
  } finally {
    zeroDek(dek);
  }
}
