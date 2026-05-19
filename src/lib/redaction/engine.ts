// Pure synchronous core of the redaction engine.
//
// Walks the input JSON, replaces matched entities with tokens of the
// shape `<<REDACTED_<KIND>_NNN>>`, and returns the redacted form
// alongside the merged map. No I/O — the envelope adapter
// (envelope-adapter.ts) is the only place that touches Transit.
//
// Phase 1 / Phase 2 aice_id naming gap (RFC 0001 storage model):
//   - Phase 1 detection_events.aice_id is the column name used as the
//     map's PK first column.
//   - Phase 2 baseline_event / story / policy_run carry the same
//     logical value as `source_aice_id`. story_member and
//     policy_event have no own aice_id column — they reach it through
//     their parent table (story / policy_run).
//   - The engine itself does not care about column names; callers
//     pass the resolved aice_id string. The note exists here so the
//     next reader does not re-discover the gap when wiring callers
//     into ingestion routes (#251).

import { createHash } from "node:crypto";
import {
  isPrivateIPv4,
  isPrivateIPv6,
  parseIPv4,
  parseIPv6,
  shouldRedactPublicIP,
} from "./ranges";
import type {
  EntityKind,
  RangeSet,
  RedactInput,
  RedactionMap,
  RedactOutput,
} from "./types";

// ---------------------------------------------------------------------------
// Regex patterns
// ---------------------------------------------------------------------------

// Email — deliberately a pragmatic match for typical log entries.
// Full RFC 5322 grammar is wider than what real logs contain and the
// false-positive rate of a strict regex is unhelpful for v1.
const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;

// MAC — canonical 6-octet form (colon- or hyphen-separated).
// Cisco's `xxxx.xxxx.xxxx` form is intentionally out of v1 scope.
const MAC_RE = /\b[0-9A-Fa-f]{2}(?:[:-][0-9A-Fa-f]{2}){5}\b/g;

// IPv4 — dotted-quad with bounded octets so it does not eat random
// version-style strings like `1.2.3.4.5`.
const IPV4_RE =
  /\b(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(?:\.(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}\b/g;

// IPv6 — broad candidate match anchored by non-hex/colon/dot
// boundaries. We accept anything that looks like at least two
// colon-separated hex groups (or `::` compression) and let
// `parseIPv6()` in the replace callback validate the exact grammar.
// Non-IPv6 candidates that happen to match (e.g. `09:30:00`) pass
// through unchanged because `parseIPv6` returns `null` for them.
// Excludes IPv4-embedded forms (matched by IPV4_RE independently);
// v1 does not need v4-in-v6 token round-tripping.
const IPV6_RE =
  /(?<![A-Za-z0-9:.])[A-Fa-f0-9]{0,4}(?::[A-Fa-f0-9]{0,4}){2,}(?![A-Za-z0-9:.])/g;

const TOKEN_PREFIX_BY_KIND: Record<EntityKind, string> = {
  ip: "<<REDACTED_IP_",
  email: "<<REDACTED_EMAIL_",
  mac: "<<REDACTED_MAC_",
};

const TOKEN_SUFFIX = ">>";

// ---------------------------------------------------------------------------
// Internal state
// ---------------------------------------------------------------------------

interface AssignmentState {
  /** Reverse index: entity value -> existing token. */
  reverse: Map<string, string>;
  /** Forward index: token -> { kind, value }. */
  forward: Map<string, { kind: EntityKind; value: string }>;
  /** Next free counter per entity kind (1-based). */
  nextCounter: Record<EntityKind, number>;
  /** True if any new token has been appended in this redaction pass. */
  mapChanged: boolean;
}

function initState(existingMap: RedactionMap): AssignmentState {
  const reverse = new Map<string, string>();
  const forward = new Map<string, { kind: EntityKind; value: string }>();
  const maxByKind: Record<EntityKind, number> = { ip: 0, email: 0, mac: 0 };

  for (const [token, entry] of Object.entries(existingMap)) {
    // Shared-map invariant 3 (token-value injectivity): each entity
    // value gets exactly one token. A corrupted/concurrently mis-merged
    // map can carry two tokens for the same value — silently keeping
    // the last one would propagate the corruption. Flag it loudly so a
    // bad map is rejected at the engine boundary rather than carried
    // forward into the next merge.
    const priorToken = reverse.get(entry.value);
    if (priorToken !== undefined && priorToken !== token) {
      throw new Error(
        `redaction: existing map violates token-value injectivity: value ${JSON.stringify(entry.value)} appears under tokens ${priorToken} and ${token}`,
      );
    }
    forward.set(token, entry);
    reverse.set(entry.value, token);
    const match = token.match(/_(\d+)>>$/);
    if (match) {
      const n = Number.parseInt(match[1], 10);
      if (n > maxByKind[entry.kind]) maxByKind[entry.kind] = n;
    }
  }

  return {
    reverse,
    forward,
    nextCounter: {
      ip: maxByKind.ip + 1,
      email: maxByKind.email + 1,
      mac: maxByKind.mac + 1,
    },
    mapChanged: false,
  };
}

function assignToken(
  state: AssignmentState,
  kind: EntityKind,
  value: string,
): string {
  const existing = state.reverse.get(value);
  if (existing) {
    const entry = state.forward.get(existing);
    if (entry && entry.kind !== kind) {
      // Token-value injectivity is violated by the existing map.
      // Shared-map invariant 3 says this is unreachable in correct
      // code; flag it loudly rather than silently shadow.
      throw new Error(
        `redaction: value ${JSON.stringify(value)} already mapped to token ${existing} with kind ${entry.kind}, refusing to assign kind ${kind}`,
      );
    }
    return existing;
  }
  const n = state.nextCounter[kind]++;
  const token = `${TOKEN_PREFIX_BY_KIND[kind]}${String(n).padStart(3, "0")}${TOKEN_SUFFIX}`;
  state.forward.set(token, { kind, value });
  state.reverse.set(value, token);
  state.mapChanged = true;
  return token;
}

// ---------------------------------------------------------------------------
// String-level redaction
// ---------------------------------------------------------------------------

/**
 * Replace every matched entity inside `input` with its token,
 * appending new map entries as needed.
 *
 * Order matters: we redact MAC and email **before** IP because both
 * shapes can contain runs of digits/colons that the IP regex would
 * otherwise consume. Email's `@` and MAC's `:` separators are
 * disjoint from a bare IP so the order is safe even though the
 * regexes do not coordinate.
 */
function redactString(
  input: string,
  state: AssignmentState,
  ranges: RangeSet,
): string {
  let out = input.replace(EMAIL_RE, (m) => assignToken(state, "email", m));
  out = out.replace(MAC_RE, (m) => assignToken(state, "mac", m));
  out = out.replace(IPV6_RE, (m) => {
    const bytes = parseIPv6(m);
    if (!bytes) return m;
    if (isPrivateIPv6(bytes)) return assignToken(state, "ip", m);
    if (shouldRedactPublicIP(bytes, 6, ranges)) {
      return assignToken(state, "ip", m);
    }
    return m;
  });
  out = out.replace(IPV4_RE, (m) => {
    const bytes = parseIPv4(m);
    if (!bytes) return m;
    if (isPrivateIPv4(bytes)) return assignToken(state, "ip", m);
    if (shouldRedactPublicIP(bytes, 4, ranges)) {
      return assignToken(state, "ip", m);
    }
    return m;
  });
  return out;
}

// ---------------------------------------------------------------------------
// JSON walker
// ---------------------------------------------------------------------------

function walk(
  value: unknown,
  state: AssignmentState,
  ranges: RangeSet,
): unknown {
  if (typeof value === "string") {
    return redactString(value, state, ranges);
  }
  if (Array.isArray(value)) {
    return value.map((v) => walk(v, state, ranges));
  }
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      // Structural keys are preserved as-is (RFC 0001 cross-cutting
      // expectations: "tokens substituted at any depth, structural
      // keys preserved").
      out[k] = walk(v, state, ranges);
    }
    return out;
  }
  return value;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Compute the composite `redaction_policy_version` for a write.
 *
 * Format: `engine:<semver>|ranges:<sha256-short>` where
 * `<sha256-short>` is the first 12 hex chars of the SHA-256 of the
 * sorted, normalised CIDR list serialised as JSON. Empty range set
 * hashes to a fixed sentinel ("empty") so the retroactive job can
 * tell "operator removed all ranges" apart from "operator added
 * ranges and then removed them again".
 */
export function computePolicyVersion(
  engineVersion: string,
  ranges: RangeSet,
): string {
  let rangesShort: string;
  if (ranges.normalisedCidrs.length === 0) {
    rangesShort = "empty";
  } else {
    const json = JSON.stringify(ranges.normalisedCidrs);
    rangesShort = createHash("sha256").update(json).digest("hex").slice(0, 12);
  }
  return `engine:${engineVersion}|ranges:${rangesShort}`;
}

/**
 * Redact a payload. The output's `mergedMap` is the input
 * `existingMap` with any newly-discovered entities appended, exactly
 * preserving the existing tokens (shared-map invariants 1 + 2 + 3).
 */
export function redact(input: RedactInput): RedactOutput {
  const state = initState(input.existingMap);
  const redacted = walk(input.payload, state, input.ranges);

  const mergedMap: RedactionMap = {};
  for (const [token, entry] of state.forward) {
    mergedMap[token] = entry;
  }

  return {
    redacted,
    mergedMap,
    policyVersion: computePolicyVersion(input.engineVersion, input.ranges),
    mapChanged: state.mapChanged,
  };
}

// ---------------------------------------------------------------------------
// Hallucination scan
// ---------------------------------------------------------------------------

const UNVERIFIED_PREFIX_BY_KIND: Record<EntityKind, string> = {
  ip: "<<UNVERIFIED_IP_",
  email: "<<UNVERIFIED_EMAIL_",
  mac: "<<UNVERIFIED_MAC_",
};

export interface HallucinationScanResult {
  scanned: string;
  /** Per-kind count of substitutions. */
  counts: Record<EntityKind, number>;
}

/**
 * Re-run the redaction regexes against an LLM response. Three cases:
 *
 *   1. The match's value is in `existingMap` — the LLM echoed a real
 *      input value back as plaintext (e.g. it ignored a token and
 *      restated `10.0.0.1`). Replace with the existing
 *      `<<REDACTED_<KIND>_NNN>>` token so the stored
 *      `analysis_text` never contains the plaintext. Not counted as
 *      a hallucination — the value did come from the original event.
 *   2. The match's value is NOT in `existingMap` — the LLM produced
 *      an entity the original input did not contain (training
 *      residue or hallucination). Replace with an
 *      `<<UNVERIFIED_<KIND>_NNN>>` marker and increment the per-kind
 *      counter. Per RFC 0001 §"LLM hallucination handling", the
 *      counter is per-response (resets each call).
 *   3. The match's value is a non-redactable public IP outside the
 *      customer's ranges — passes through unchanged.
 *
 * Storage contract: `analysis_text` written to `event_analysis_result`
 * must never contain raw plaintext entities. The UI restore path
 * relies on token presence to redact, so a plaintext leak here is
 * unrecoverable downstream.
 */
export function scanHallucinations(
  response: string,
  existingMap: RedactionMap,
  ranges: RangeSet,
): HallucinationScanResult {
  // Reverse index: value -> existing token. The forward map is
  // token-keyed, so build this once for value lookups.
  const knownTokens = new Map<string, string>();
  for (const [token, entry] of Object.entries(existingMap)) {
    knownTokens.set(entry.value, token);
  }
  const counts: Record<EntityKind, number> = { ip: 0, email: 0, mac: 0 };

  function substitute(kind: EntityKind, original: string): string {
    const existingToken = knownTokens.get(original);
    if (existingToken) return existingToken;
    counts[kind]++;
    const n = counts[kind];
    return `${UNVERIFIED_PREFIX_BY_KIND[kind]}${String(n).padStart(3, "0")}${TOKEN_SUFFIX}`;
  }

  let out = response.replace(EMAIL_RE, (m) => substitute("email", m));
  out = out.replace(MAC_RE, (m) => substitute("mac", m));
  out = out.replace(IPV6_RE, (m) => {
    const bytes = parseIPv6(m);
    if (!bytes) return m;
    if (isPrivateIPv6(bytes) || shouldRedactPublicIP(bytes, 6, ranges)) {
      return substitute("ip", m);
    }
    return m;
  });
  out = out.replace(IPV4_RE, (m) => {
    const bytes = parseIPv4(m);
    if (!bytes) return m;
    if (isPrivateIPv4(bytes) || shouldRedactPublicIP(bytes, 4, ranges)) {
      return substitute("ip", m);
    }
    return m;
  });

  return { scanned: out, counts };
}

/** Engine semver — bump when regex / IP matching / token format changes. */
export const ENGINE_VERSION = "1.0.0";
