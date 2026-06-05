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

// Domain / FQDN candidate — at least two dot-separated labels ending in
// a TLD-shaped label. Unicode letters/digits are allowed so IDN
// U-labels match; `normalizeDomain` folds them to punycode and rejects
// non-hostname shapes (dotted numerics, version strings) before the
// owned-suffix test. The leading/trailing boundaries forbid characters
// that can sit inside a hostname so a match never starts/ends mid-label.
// This is the single source of truth for the engine's redaction pass
// (`engine.ts`) AND the story/report leak scanners, so a customer-owned
// domain echoed verbatim by the LLM is detected with the exact same
// shape the engine would have redacted.
const DOMAIN_CANDIDATE_PATTERN =
  /(?<![\p{L}\p{N}._-])(?:[\p{L}\p{N}](?:[\p{L}\p{N}-]*[\p{L}\p{N}])?\.)+[\p{L}\p{N}-]{2,}(?![\p{L}\p{N}_-])/gu;

/**
 * A fresh global FQDN-candidate regex. Returns a new instance each call
 * so concurrent `exec` / `matchAll` loops never share `lastIndex`.
 */
export function domainCandidateRegex(): RegExp {
  return new RegExp(
    DOMAIN_CANDIDATE_PATTERN.source,
    DOMAIN_CANDIDATE_PATTERN.flags,
  );
}

/**
 * Find every FQDN candidate in `text` that the customer's owned-domain
 * policy would redact — i.e. each substring `shouldRedactOwnedDomain`
 * accepts. External domains (an attacker C2 host, an unrelated vendor)
 * are skipped, mirroring the engine's external-domain pass-through. An
 * empty owned-domain set matches nothing.
 *
 * Used by the story/report hallucination scanners to flag an owned
 * domain the LLM echoed in plaintext (RFC 0001 Amendment A.2), parallel
 * to how the IP-leak scan flags an address the engine would have
 * redacted. Returns matches in document order, including duplicates, so
 * callers can report one leak per occurrence.
 */
export function findOwnedDomainLeaks(
  text: string,
  set: OwnedDomainSet,
): string[] {
  if (set.normalisedSuffixes.length === 0) return [];
  const leaks: string[] = [];
  for (const m of text.matchAll(domainCandidateRegex())) {
    if (shouldRedactOwnedDomain(m[0], set)) leaks.push(m[0]);
  }
  return leaks;
}

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
