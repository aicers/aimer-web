// Opaque keyset-pagination cursor codec (WS3 #392).
//
// The customer-scoped Threat Stories and Suspicious Events lists paginate
// server-side with a keyset (not offset) so ordering stays stable across
// pages. The cursor is opaque to the client but encodes every ordering-key
// component of the last row on the page; the loader decodes it and seeks
// past that row with an expanded lexicographic predicate.
//
// Encoding is base64url(JSON). It is NOT signed or encrypted — a tampered
// cursor can only shift which already-authorized rows the caller sees
// (the customer scope and permission gate are enforced independently on
// every request), and a malformed cursor decodes to `null` and is treated
// as "first page".

/** Encode any JSON-serializable cursor payload to an opaque token. */
export function encodeCursor(payload: unknown): string {
  return Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
}

/**
 * Decode an opaque cursor token, validating its shape with the supplied
 * type guard. Returns `null` for a missing, malformed, or shape-invalid
 * token so callers can fall back to the first page rather than throwing.
 */
export function decodeCursor<T>(
  cursor: string | null | undefined,
  isValid: (value: unknown) => value is T,
): T | null {
  if (!cursor) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
  } catch {
    return null;
  }
  return isValid(parsed) ? parsed : null;
}
