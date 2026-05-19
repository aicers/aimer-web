// CIDR parsing and matching for the redaction engine.
//
// Pure synchronous code — no I/O, no async, no Node-specific APIs
// beyond Buffer/TextEncoder so the engine remains usable in tests
// without mocks.

import type { ParsedRange, RangeSet } from "./types";

// ---------------------------------------------------------------------------
// IP parsing
// ---------------------------------------------------------------------------

const IPV4_RE =
  /^(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(?:\.(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}$/;

export function parseIPv4(value: string): Uint8Array | null {
  if (!IPV4_RE.test(value)) return null;
  const parts = value.split(".").map((s) => Number.parseInt(s, 10));
  return new Uint8Array(parts);
}

/**
 * Parse an IPv6 literal (with optional `::` compression) into 16
 * network-order bytes. Returns `null` for any malformed input.
 * IPv4-mapped suffixes (e.g. `::ffff:1.2.3.4`) are NOT accepted by
 * v1 — the engine treats them as pure v6 textual matches only.
 */
export function parseIPv6(value: string): Uint8Array | null {
  if (value.length === 0 || value.includes(":::")) return null;
  // Forbid v4-in-v6 form to keep the parser simple — those
  // addresses are uncommon enough in our event corpus that the
  // tradeoff is acceptable for v1.
  if (value.includes(".")) return null;

  const doubleColonIdx = value.indexOf("::");
  let leftPart: string;
  let rightPart: string;
  if (doubleColonIdx === -1) {
    leftPart = value;
    rightPart = "";
  } else {
    leftPart = value.slice(0, doubleColonIdx);
    rightPart = value.slice(doubleColonIdx + 2);
    // A second "::" anywhere else is invalid.
    if (rightPart.includes("::")) return null;
  }

  const leftGroups = leftPart === "" ? [] : leftPart.split(":");
  const rightGroups = rightPart === "" ? [] : rightPart.split(":");

  if (leftGroups.length + rightGroups.length > 8) return null;
  if (doubleColonIdx === -1 && leftGroups.length + rightGroups.length !== 8) {
    return null;
  }

  const fillerCount = 8 - leftGroups.length - rightGroups.length;
  const filler: string[] = Array(fillerCount).fill("0");
  const allGroups = [...leftGroups, ...filler, ...rightGroups];

  const bytes = new Uint8Array(16);
  for (let i = 0; i < 8; i++) {
    const group = allGroups[i];
    if (group.length === 0 || group.length > 4) return null;
    if (!/^[0-9a-fA-F]+$/.test(group)) return null;
    const value16 = Number.parseInt(group, 16);
    bytes[i * 2] = (value16 >> 8) & 0xff;
    bytes[i * 2 + 1] = value16 & 0xff;
  }
  return bytes;
}

// ---------------------------------------------------------------------------
// CIDR parsing + matching
// ---------------------------------------------------------------------------

/**
 * Parse a CIDR like `203.0.113.0/24` or `2001:db8::/32` into a
 * `ParsedRange`. Returns `null` for malformed input — the caller (the
 * range-loading layer) is responsible for surfacing the validation
 * error to the operator.
 *
 * The returned `cidr` is **normalised**: trailing host bits are
 * masked off so `203.0.113.5/24` and `203.0.113.0/24` produce the
 * same string. Normalisation matters for the `policy_version` hash
 * because the hash is computed over the sorted CIDR list.
 */
export function parseCidr(value: string): ParsedRange | null {
  const slashIdx = value.indexOf("/");
  if (slashIdx === -1) return null;
  const addr = value.slice(0, slashIdx);
  const prefixStr = value.slice(slashIdx + 1);
  const prefix = Number.parseInt(prefixStr, 10);
  if (!Number.isInteger(prefix) || prefix < 0) return null;

  let bytes: Uint8Array | null;
  let ipVersion: 4 | 6;
  if (addr.includes(":")) {
    bytes = parseIPv6(addr);
    ipVersion = 6;
    if (prefix > 128) return null;
  } else {
    bytes = parseIPv4(addr);
    ipVersion = 4;
    if (prefix > 32) return null;
  }
  if (!bytes) return null;

  const network = applyMask(bytes, prefix);
  const normalised = `${bytesToString(network, ipVersion)}/${prefix}`;
  return {
    cidr: normalised,
    ipVersion,
    networkBytes: network,
    prefixLength: prefix,
  };
}

function applyMask(bytes: Uint8Array, prefix: number): Uint8Array {
  const out = new Uint8Array(bytes.length);
  for (let i = 0; i < bytes.length; i++) {
    const bitOffset = i * 8;
    if (bitOffset + 8 <= prefix) {
      out[i] = bytes[i];
    } else if (bitOffset >= prefix) {
      out[i] = 0;
    } else {
      const keepBits = prefix - bitOffset;
      const mask = (0xff << (8 - keepBits)) & 0xff;
      out[i] = bytes[i] & mask;
    }
  }
  return out;
}

function bytesToString(bytes: Uint8Array, ipVersion: 4 | 6): string {
  if (ipVersion === 4) {
    return Array.from(bytes).join(".");
  }
  const groups: string[] = [];
  for (let i = 0; i < 16; i += 2) {
    const value16 = (bytes[i] << 8) | bytes[i + 1];
    groups.push(value16.toString(16));
  }
  return groups.join(":");
}

/** True iff `ipBytes` is inside the network described by `range`. */
export function cidrContains(range: ParsedRange, ipBytes: Uint8Array): boolean {
  if (ipBytes.length !== range.networkBytes.length) return false;
  const masked = applyMask(ipBytes, range.prefixLength);
  for (let i = 0; i < masked.length; i++) {
    if (masked[i] !== range.networkBytes[i]) return false;
  }
  return true;
}

// ---------------------------------------------------------------------------
// Range set construction
// ---------------------------------------------------------------------------

/**
 * Build a `RangeSet` from raw CIDR strings. Invalid CIDRs are
 * silently skipped — the validation layer in the admin API
 * (#252) is the one that rejects bad input; the engine just needs
 * to be robust to a stale/dirty set.
 */
export function buildRangeSet(cidrs: readonly string[]): RangeSet {
  const ranges: ParsedRange[] = [];
  for (const raw of cidrs) {
    const parsed = parseCidr(raw);
    if (parsed) ranges.push(parsed);
  }
  const normalisedCidrs = ranges.map((r) => r.cidr).sort();
  return { normalisedCidrs, ranges };
}

// ---------------------------------------------------------------------------
// Private-range detection
// ---------------------------------------------------------------------------

const IPV4_PRIVATE: readonly ParsedRange[] = [
  parseCidr("10.0.0.0/8"),
  parseCidr("172.16.0.0/12"),
  parseCidr("192.168.0.0/16"),
  parseCidr("169.254.0.0/16"),
  parseCidr("127.0.0.0/8"),
].filter((r): r is ParsedRange => r !== null);

const IPV6_PRIVATE: readonly ParsedRange[] = [
  parseCidr("fc00::/7"),
  parseCidr("fe80::/10"),
  parseCidr("::1/128"),
].filter((r): r is ParsedRange => r !== null);

export function isPrivateIPv4(bytes: Uint8Array): boolean {
  return IPV4_PRIVATE.some((r) => cidrContains(r, bytes));
}

export function isPrivateIPv6(bytes: Uint8Array): boolean {
  return IPV6_PRIVATE.some((r) => cidrContains(r, bytes));
}

/**
 * Decide whether a public IP should be redacted, given the
 * customer's range set.
 *
 * Per RFC 0001 §"Redaction engine — v1 policy", an **empty** range
 * set means "redact all public IPs" (the safe default that protects
 * the customer until they explicitly opt into a narrower scope).
 */
export function shouldRedactPublicIP(
  bytes: Uint8Array,
  ipVersion: 4 | 6,
  ranges: RangeSet,
): boolean {
  if (ranges.ranges.length === 0) return true;
  for (const r of ranges.ranges) {
    if (r.ipVersion !== ipVersion) continue;
    if (cidrContains(r, bytes)) return true;
  }
  return false;
}
