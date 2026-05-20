// CIDR validation pipeline for the Customer Settings UI (#252).
//
// Uses `ipaddr.js` for parsing + private-range / overlap checks. The
// engine module in `ranges.ts` ships its own bespoke parser used by
// the redaction path; the validation surface (admin API) uses the
// library because partial overlaps require an end-to-end subset /
// superset comparator and IPv6 ULA / link-local detection that we do
// not want to reimplement by hand.

import ipaddr from "ipaddr.js";

export type CidrError =
  | "cidr_invalid"
  | "cidr_private"
  | "cidr_duplicate"
  | "cidr_overlaps"
  | "cidr_cap_exceeded";

export interface ParsedCidr {
  /** Normalised text form, host bits zeroed (e.g. `203.0.113.0/24`). */
  normalised: string;
  ipVersion: 4 | 6;
  prefixLength: number;
}

/** Maximum number of registered ranges per customer (issue #252). */
export const RANGE_CAP_PER_CUSTOMER = 100;

// ---------------------------------------------------------------------------
// Parse + normalise
// ---------------------------------------------------------------------------

/**
 * Parse a CIDR and return its normalised form (host bits zeroed) plus
 * IP version. Returns `null` for syntactically invalid input.
 *
 * Examples:
 *   `203.0.113.5/24` → `{ normalised: "203.0.113.0/24", ipVersion: 4 }`
 *   `2001:db8::1/64` → `{ normalised: "2001:db8::/64",  ipVersion: 6 }`
 */
export function parseCidrInput(value: string): ParsedCidr | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed.includes("/")) return null;
  let parsed: [ipaddr.IPv4 | ipaddr.IPv6, number];
  try {
    parsed = ipaddr.parseCIDR(trimmed);
  } catch {
    return null;
  }
  const [addr, prefix] = parsed;
  // Mask host bits to canonicalise. `prefixLengthFromSubnetMask` and
  // friends operate on net addresses; we use `match` semantics via the
  // address-mask pair instead.
  const ipVersion: 4 | 6 = addr.kind() === "ipv4" ? 4 : 6;
  const netBytes = maskBytes(addr.toByteArray(), prefix);
  const network = ipaddr.fromByteArray(netBytes);
  // IPv6 emits the shortest RFC 5952 form via `toString()`; IPv4 has
  // a single canonical form so the choice doesn't matter.
  return {
    normalised: `${network.toString()}/${prefix}`,
    ipVersion,
    prefixLength: prefix,
  };
}

function maskBytes(bytes: number[], prefix: number): number[] {
  const out = bytes.slice();
  for (let i = 0; i < out.length; i++) {
    const bitOffset = i * 8;
    if (bitOffset + 8 <= prefix) continue;
    if (bitOffset >= prefix) {
      out[i] = 0;
      continue;
    }
    const keepBits = prefix - bitOffset;
    const mask = (0xff << (8 - keepBits)) & 0xff;
    out[i] = out[i] & mask;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Private / reserved range detection
// ---------------------------------------------------------------------------

/**
 * True iff the CIDR's network address falls inside one of the always-
 * redacted private classes: RFC 1918, IPv6 ULA (`fc00::/7`), loopback,
 * link-local. This mirrors the engine's "always redact" reject set in
 * `src/lib/redaction/ranges.ts:IPV4_PRIVATE` / `IPV6_PRIVATE`. The list
 * is deliberately a slight extension of `ipaddr.js`'s built-in
 * `range()` taxonomy — `range()` returns labels like `private`,
 * `loopback`, `linkLocal`, `uniqueLocal`, which we collapse to the
 * single rejection bucket.
 */
export function isReservedPrivate(parsed: ParsedCidr): boolean {
  const [addr] = ipaddr.parseCIDR(parsed.normalised);
  const range = addr.range();
  if (parsed.ipVersion === 4) {
    return range === "private" || range === "loopback" || range === "linkLocal";
  }
  // IPv6
  return (
    range === "uniqueLocal" ||
    range === "loopback" ||
    range === "linkLocal" ||
    // IPv4-mapped IPv6 needs an extra step: an address like
    // `::ffff:10.0.0.0/104` has range() === "ipv4Mapped" but the
    // embedded IPv4 is RFC 1918 and must also reject.
    isIpv4MappedPrivate(addr as ipaddr.IPv6)
  );
}

function isIpv4MappedPrivate(addr: ipaddr.IPv6): boolean {
  if (!addr.isIPv4MappedAddress()) return false;
  const v4 = addr.toIPv4Address();
  const r = v4.range();
  return r === "private" || r === "loopback" || r === "linkLocal";
}

// ---------------------------------------------------------------------------
// Subset / superset / equal overlap
// ---------------------------------------------------------------------------

/**
 * Returns true if `a` and `b` are equal, or one is a subset of the
 * other. IPv4 and IPv6 CIDRs form a tree, so the only relations are
 * equal / subset / superset / disjoint — partial overlap is
 * impossible.
 */
export function overlaps(a: ParsedCidr, b: ParsedCidr): boolean {
  if (a.ipVersion !== b.ipVersion) return false;
  if (a.normalised === b.normalised) return true;
  const aAddr = ipaddr.parseCIDR(a.normalised)[0];
  const bAddr = ipaddr.parseCIDR(b.normalised)[0];
  // `match([addr, prefix])` returns true if `this` is contained in
  // the network described by `[addr, prefix]`. So `a ⊂ b` iff
  // a.network matches b's prefix.
  if (a.prefixLength >= b.prefixLength && aAddr.match(bAddr, b.prefixLength)) {
    return true;
  }
  if (b.prefixLength >= a.prefixLength && bAddr.match(aAddr, a.prefixLength)) {
    return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Full validation pipeline
// ---------------------------------------------------------------------------

export interface ValidatedNewRange {
  parsed: ParsedCidr;
}

export type ValidationResult =
  | { ok: true; value: ValidatedNewRange }
  | { ok: false; error: CidrError };

/**
 * Apply the validation pipeline in the order specified by issue #252:
 *   1. `cidr_invalid`        — bad syntax
 *   2. `cidr_private`        — RFC 1918 / ULA / loopback / link-local
 *   3. `cidr_duplicate`      — exact match (after normalisation) of an existing entry
 *   4. `cidr_overlaps`       — subset / superset of an existing entry
 *   5. `cidr_cap_exceeded`   — customer already at the per-customer cap
 *
 * The cap is intentionally checked last, after parsing succeeds, so a
 * caller submitting a syntactically broken CIDR sees `cidr_invalid`
 * (the more actionable error) rather than `cidr_cap_exceeded`.
 */
export function validateNewRange(
  input: string,
  existing: readonly { normalised: string; ipVersion: 4 | 6 }[],
): ValidationResult {
  const parsed = parseCidrInput(input);
  if (!parsed) return { ok: false, error: "cidr_invalid" };

  if (isReservedPrivate(parsed)) {
    return { ok: false, error: "cidr_private" };
  }

  for (const ex of existing) {
    if (ex.normalised === parsed.normalised) {
      return { ok: false, error: "cidr_duplicate" };
    }
  }

  for (const ex of existing) {
    const exParsed = parseCidrInput(ex.normalised);
    if (!exParsed) continue;
    if (overlaps(parsed, exParsed)) {
      return { ok: false, error: "cidr_overlaps" };
    }
  }

  if (existing.length >= RANGE_CAP_PER_CUSTOMER) {
    return { ok: false, error: "cidr_cap_exceeded" };
  }

  return { ok: true, value: { parsed } };
}
