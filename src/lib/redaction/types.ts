// Shared types for the redaction engine and its envelope adapter.
//
// The pure core (engine.ts) operates on these types without any I/O
// so it stays unit-testable. The envelope adapter
// (envelope-adapter.ts) converts a RedactionMap to/from the
// (ciphertext, wrapped_dek) pair stored in `event_redaction_map`.

export type EntityKind = "ip" | "email" | "mac";

/**
 * The decrypted form of one `event_redaction_map.ciphertext` payload.
 *
 * Token strings look like `<<REDACTED_IP_001>>` /
 * `<<REDACTED_EMAIL_001>>` / `<<REDACTED_MAC_001>>`. The map is
 * append-only per the shared-map invariants in
 * RFC 0001 §"Shared map across ingestion paths".
 */
export type RedactionMap = Record<string, { kind: EntityKind; value: string }>;

/**
 * A customer-registered public IP range, normalised to its network
 * address and prefix length in bytes.
 */
export interface ParsedRange {
  /** Original CIDR string (for round-trip and policy_version hashing). */
  cidr: string;
  ipVersion: 4 | 6;
  /** Network bytes (length 4 for v4, 16 for v6). */
  networkBytes: Uint8Array;
  /** Prefix length in bits (0–32 for v4, 0–128 for v6). */
  prefixLength: number;
}

export interface RangeSet {
  /** Original normalised CIDR strings, sorted, used for policy_version hashing. */
  normalisedCidrs: string[];
  ranges: ParsedRange[];
}

export interface RedactInput {
  /** The JSON value to redact (object, array, scalar). */
  payload: unknown;
  /**
   * Existing map for this `(aice_id, event_key)` — empty object when
   * this is the first writer for the event.
   */
  existingMap: RedactionMap;
  ranges: RangeSet;
  /** Semantic version of the engine code (regex / IP-range logic / token format). */
  engineVersion: string;
}

export interface RedactOutput {
  redacted: unknown;
  /** Merged map: existing entries preserved + any new tokens appended. */
  mergedMap: RedactionMap;
  /** Composite `engine:<semver>|ranges:<sha256-short>` for this write. */
  policyVersion: string;
  /** True if mergedMap differs from existingMap (new tokens were added). */
  mapChanged: boolean;
}
