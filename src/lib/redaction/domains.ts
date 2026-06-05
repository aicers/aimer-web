// Owned-domain normalisation and suffix matching for the redaction
// engine (RFC 0001 Amendment A.2). Parallel to `ranges.ts`: pure
// synchronous code with no I/O so the engine stays unit-testable.
//
// A customer registers the domains they OWN. Only those domains (and
// their subdomains) are masked in event payloads; external domains
// (e.g. an attacker C2 host) pass through unredacted — mirroring how
// `shouldRedactPublicIP` passes external IPs through. The matcher is
// suffix-anchored on label boundaries so `domain.example` masks
// `domain.example` and `a.b.domain.example` but never `notdomain.example`.

import { domainToASCII } from "node:url";
import type { OwnedDomainSet } from "./types";

/**
 * Normalise a domain candidate for suffix matching: lowercase, strip a
 * trailing dot (FQDN root) and any leading dots (leading-dot suffix
 * form), then fold IDN U-labels to their punycode A-label form so a
 * Unicode domain and its `xn--` encoding compare equal (RFC 0001 §A.2).
 *
 * Returns `null` for input that is not a plausible hostname — empty,
 * single-label, or with a non-alphabetic TLD (e.g. a bare IPv4 literal
 * or a version string like `1.2.3`) — so callers pass it through
 * unredacted rather than masking it.
 */
export function normalizeDomain(raw: string): string | null {
  const lowered = raw.trim().toLowerCase();
  // Strip leading dots (suffix form `.domain.example`) and trailing
  // dots (FQDN root `domain.example.`) before folding.
  const stripped = lowered.replace(/^\.+/, "").replace(/\.+$/, "");
  if (stripped.length === 0) return null;
  // Fold IDN to punycode. `domainToASCII` returns "" for input it
  // cannot encode; fall back to the stripped form in that case.
  const ascii = domainToASCII(stripped);
  const normalized = (ascii.length > 0 ? ascii : stripped).replace(/\.+$/, "");
  if (!normalized.includes(".")) return null;
  const labels = normalized.split(".");
  const tld = labels[labels.length - 1];
  // Require an alphabetic or punycode TLD so dotted numerics (IPv4
  // literals, version strings) are never treated as hostnames.
  if (!/^[a-z]{2,}$/.test(tld) && !tld.startsWith("xn--")) return null;
  return normalized;
}

/** Empty owned-domain set — redacts no domains (parallel to an empty `RangeSet`). */
export const EMPTY_OWNED_DOMAIN_SET: OwnedDomainSet = {
  normalisedSuffixes: [],
};

/**
 * Build an `OwnedDomainSet` from raw suffix strings. Invalid/empty
 * suffixes are silently skipped — the admin validation layer is the
 * one that rejects bad operator input; the engine just needs to be
 * robust to a stale/dirty set. The result is normalised, de-duplicated,
 * and sorted so the `policy_version` `domains:` hash is stable.
 */
export function buildOwnedDomainSet(
  suffixes: readonly string[],
): OwnedDomainSet {
  const set = new Set<string>();
  for (const raw of suffixes) {
    const norm = normalizeDomain(raw);
    if (norm) set.add(norm);
  }
  return { normalisedSuffixes: Array.from(set).sort() };
}

/**
 * True iff `domain` is one of the customer's registered owned domains
 * or a subdomain of one. Suffix-anchored on label boundaries: the
 * suffix `domain.example` matches `domain.example` and
 * `a.b.domain.example`, but NOT `notdomain.example`.
 *
 * Per RFC 0001 §A.2 an **empty** owned-domain set masks nothing —
 * external domains flow through unredacted, parallel to an empty
 * `RangeSet` passing public IPs through.
 */
export function shouldRedactOwnedDomain(
  domain: string,
  set: OwnedDomainSet,
): boolean {
  if (set.normalisedSuffixes.length === 0) return false;
  const norm = normalizeDomain(domain);
  if (!norm) return false;
  for (const suffix of set.normalisedSuffixes) {
    if (norm === suffix || norm.endsWith(`.${suffix}`)) return true;
  }
  return false;
}
