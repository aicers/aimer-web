import { calculateJwkThumbprint } from "jose";

export class InvalidJwkError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidJwkError";
  }
}

export interface JwkThumbprint {
  /** RFC 7638 SHA-256 thumbprint, base64url-encoded (43 chars, no padding). */
  base64url: string;
  /** Same 32-byte digest as colon-separated 4-byte (8 hex char) blocks. */
  hex: string;
}

/**
 * Compute the RFC 7638 SHA-256 JWK Thumbprint of a public-key JWK and return
 * the canonical `base64url` plus the colon-separated `hex` rendering that
 * the registration UI shows alongside it.
 *
 * Throws `InvalidJwkError` if the value cannot be parsed as a JWK that `jose`
 * can hash (unsupported `kty`, missing required parameters, etc.).
 */
export async function computeJwkThumbprint(
  jwk: unknown,
): Promise<JwkThumbprint> {
  if (typeof jwk !== "object" || jwk === null || Array.isArray(jwk)) {
    throw new InvalidJwkError("publicKey must be a JWK object");
  }
  let base64url: string;
  try {
    base64url = await calculateJwkThumbprint(
      jwk as Parameters<typeof calculateJwkThumbprint>[0],
      "sha256",
    );
  } catch (err) {
    const detail = err instanceof Error ? err.message : "unknown error";
    throw new InvalidJwkError(`Invalid JWK: ${detail}`);
  }
  return { base64url, hex: formatThumbprintHex(base64url) };
}

/**
 * Convert a base64url-encoded SHA-256 digest (43 chars, no padding) into
 * 64 hex chars grouped in 4-byte / 8-hex-char blocks separated by `:`.
 */
export function formatThumbprintHex(base64url: string): string {
  const bytes = base64urlToBytes(base64url);
  if (bytes.length !== 32) {
    throw new InvalidJwkError(
      `Expected 32-byte SHA-256 digest, got ${bytes.length} bytes`,
    );
  }
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join(
    "",
  );
  const groups: string[] = [];
  for (let i = 0; i < hex.length; i += 8) {
    groups.push(hex.slice(i, i + 8));
  }
  return groups.join(":");
}

function base64urlToBytes(input: string): Uint8Array {
  const padLen = (4 - (input.length % 4)) % 4;
  const b64 = input.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat(padLen);
  const binary =
    typeof Buffer !== "undefined"
      ? Buffer.from(b64, "base64")
      : Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
  return binary instanceof Uint8Array ? binary : new Uint8Array(binary);
}
