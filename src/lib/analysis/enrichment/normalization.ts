// RFC 0003 P1a — indicator normalization (RFC §"Indicator normalization").
//
// Matching is only as good as normalization. Each normalizer produces a
// `NormalizedIndicator` carrying the canonical display value, the set of
// equivalent `matchValues` a feed may key on, normalization-derived
// classification flags, and a `normalizationVersion` stamp that scopes the
// enrichment cache key and in-run dedupe so matching stays consistent as
// rules evolve. The stamp is not persisted on the evidence record — audit
// rows store the redaction-consistent indicator reference plus its map
// scope, not the normalized indicator.
//
// IP parsing/CIDR reuse `ipaddr.js` (as `cidr-validation.ts` does) but apply
// the broader public allow-list below — the existing `isReservedPrivate` is
// narrower and insufficient here. Registered-domain extraction uses `tldts`.

import { domainToASCII, domainToUnicode } from "node:url";
import ipaddr from "ipaddr.js";
import { getDomain } from "tldts";
import type {
  DerivedUrlIndicators,
  HashType,
  NormalizedIndicator,
} from "./types";

/**
 * Stamped on every `NormalizedIndicator`. Bump when any normalization rule
 * changes so indicator matching stays consistent as rules evolve.
 */
export const NORMALIZATION_VERSION = "ti-norm-1";

export class NormalizationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NormalizationError";
  }
}

// ---------------------------------------------------------------------------
// IP
// ---------------------------------------------------------------------------

/**
 * Public iff global unicast (RFC 0003 normative allow-list). Uses the
 * `ipaddr.js` `range()` taxonomy: `range() === "unicast"` is public,
 * EVERYTHING else is non-public (private/loopback/linkLocal/broadcast/
 * multicast/unspecified/carrierGradeNat/reserved for IPv4; uniqueLocal/
 * loopback/linkLocal/multicast/unspecified/reserved/6to4/teredo for IPv6).
 * For an IPv4-mapped IPv6 address the embedded IPv4 is re-evaluated.
 */
function isPublicAddr(addr: ipaddr.IPv4 | ipaddr.IPv6): boolean {
  const range = addr.range();
  if (range === "ipv4Mapped" && addr.kind() === "ipv6") {
    return isPublicAddr((addr as ipaddr.IPv6).toIPv4Address());
  }
  return range === "unicast";
}

/**
 * Normalize an IP indicator. Produces the canonical address form, records
 * `isPublic` per the allow-list above, and sets `neverOffHost` for
 * non-public addresses (later honoured by floor + egress).
 *
 * @throws NormalizationError on syntactically invalid input.
 */
export function normalizeIp(value: string): NormalizedIndicator {
  const trimmed = value.trim();
  let addr: ipaddr.IPv4 | ipaddr.IPv6;
  try {
    addr = ipaddr.parse(trimmed);
  } catch {
    throw new NormalizationError(`invalid IP indicator: ${value}`);
  }
  const canonical = addr.toString();
  const isPublic = isPublicAddr(addr);
  return {
    entityType: "IP",
    value: canonical,
    matchValues: [canonical],
    normalizationVersion: NORMALIZATION_VERSION,
    isPublic,
    neverOffHost: !isPublic,
  };
}

/**
 * CIDR-membership test for IP matching. Returns `false` (never throws) on
 * any parse failure or version mismatch.
 */
export function ipInCidr(ip: string, cidr: string): boolean {
  try {
    const addr = ipaddr.parse(ip.trim());
    const [net, prefix] = ipaddr.parseCIDR(cidr.trim());
    if (addr.kind() !== net.kind()) return false;
    return addr.match(net, prefix);
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Domain
// ---------------------------------------------------------------------------

/**
 * Normalize a domain: lowercase, strip a trailing dot, and produce both the
 * A-label (canonical `value`) and U-label forms in `matchValues` so a feed
 * keyed on either form still matches (RFC: punycode/IDN, match both labels).
 *
 * @throws NormalizationError when the input is not a usable domain.
 */
export function normalizeDomain(value: string): NormalizedIndicator {
  const trimmed = value.trim().replace(/\.+$/, "").toLowerCase();
  if (trimmed.length === 0) {
    throw new NormalizationError(`invalid domain indicator: ${value}`);
  }
  const aLabel = domainToASCII(trimmed);
  if (aLabel.length === 0) {
    throw new NormalizationError(`invalid domain indicator: ${value}`);
  }
  const uLabel = domainToUnicode(aLabel);
  const matchValues = uLabel && uLabel !== aLabel ? [aLabel, uLabel] : [aLabel];
  return {
    entityType: "DOMAIN",
    value: aLabel,
    matchValues,
    normalizationVersion: NORMALIZATION_VERSION,
  };
}

// ---------------------------------------------------------------------------
// URL
// ---------------------------------------------------------------------------

/** Uppercase the hex digits of every percent-encoded triplet (RFC 3986). */
function upperPercentEncoding(input: string): string {
  return input.replace(/%[0-9a-fA-F]{2}/g, (m) => m.toUpperCase());
}

/**
 * Normalize a URL per the RFC canonicalization policy: scheme + host
 * lowercased; default port (`:80` http, `:443` https) stripped; fragment
 * dropped; empty path → `/`; percent-encoding hex uppercased; query order
 * and path case preserved (NOT sorted/lowercased). Returns the canonical
 * URL plus derived `{ url, host, registeredDomain }` indicators.
 *
 * @throws NormalizationError on unparseable input.
 */
export function normalizeUrl(value: string): NormalizedIndicator {
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    throw new NormalizationError(`invalid URL indicator: ${value}`);
  }
  // WHATWG URL already lowercases scheme + host and strips default ports;
  // `pathname` is "/" for an empty path. We drop the fragment and uppercase
  // percent-encoding ourselves to satisfy RFC 3986.
  const path = upperPercentEncoding(url.pathname || "/");
  const search = upperPercentEncoding(url.search);
  const canonical = `${url.protocol}//${url.host}${path}${search}`;
  const host = url.hostname;
  const registeredDomain = getDomain(host);
  const derived: DerivedUrlIndicators = {
    url: canonical,
    host,
    registeredDomain,
  };
  return {
    entityType: "URL",
    value: canonical,
    matchValues: [canonical],
    normalizationVersion: NORMALIZATION_VERSION,
    derived,
  };
}

// ---------------------------------------------------------------------------
// Hash
// ---------------------------------------------------------------------------

const HASH_LENGTHS: Record<number, HashType> = {
  32: "MD5",
  40: "SHA1",
  64: "SHA256",
};

/**
 * Normalize a file hash: lowercase, and distinguish MD5 / SHA-1 / SHA-256 by
 * digest length. `value` is the lowercased hex digest; `hashType` records the
 * family.
 *
 * @throws NormalizationError when the input is not hex of a known length.
 */
export function normalizeHash(value: string): NormalizedIndicator {
  const trimmed = value.trim().toLowerCase();
  const hashType = HASH_LENGTHS[trimmed.length];
  if (!hashType || !/^[0-9a-f]+$/.test(trimmed)) {
    throw new NormalizationError(`invalid hash indicator: ${value}`);
  }
  return {
    entityType: "HASH",
    value: trimmed,
    matchValues: [trimmed],
    normalizationVersion: NORMALIZATION_VERSION,
    hashType,
  };
}

// ---------------------------------------------------------------------------
// Canonical serialization (dedupe key)
// ---------------------------------------------------------------------------

/**
 * Deterministic, version-stamped serialization of a normalized indicator,
 * used as the dedupe key when extracting indicators (`indicator-extraction.ts`)
 * so the same indicator+version is processed once. Kept here (alongside the
 * normalizer) so it stays in lockstep with `NORMALIZATION_VERSION`.
 */
export function serializeIndicator(indicator: NormalizedIndicator): string {
  return [
    indicator.normalizationVersion,
    indicator.entityType,
    indicator.value,
  ].join("\0");
}
