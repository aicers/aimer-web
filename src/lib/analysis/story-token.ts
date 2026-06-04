// RFC 0002 Phase 1 (#296) — story-scope token rewrite + leak scan.
//
// Story analysis composes multiple member events into one LLM prompt.
// Each member's event JSON arrives already redacted with event-scope
// tokens of the form `<<REDACTED_<KIND>_NNN>>`. The same token in two
// different events points to two different plaintext entities, so they
// must be re-namespaced before being concatenated.
//
// This module exposes two helpers consumed by the story-analysis
// worker:
//
//   - `buildStoryTokenMap(members)` rewrites every event-scope token
//     in each member's JSON to a story-scope token
//     `<<REDACTED_<KIND>_E{i}_NNN>>`, where `{i}` is the member's
//     1-based position in the canonical, deterministic order (so the
//     embedded `E{i}` equals aimer's `StoryMemberInput.ordinal`).
//     Returns the
//     rewritten members and a `refs` array carrying enough information
//     to detect hallucinations and to drive event-scope restore on the
//     rendering side.
//
//   - `scanStoryAnalysisForLeaks(analysisText, refs)` walks the LLM
//     output looking for residual unmapped tokens or plaintext PII.
//     A non-empty result means the LLM hallucinated a token or leaked
//     a plaintext PII value; the caller fails the job before any
//     `story_analysis_result` row is written.
//
// The module is intentionally separate from `src/lib/redaction/*`
// (event-scope helpers). The event-scope engine handles encryption /
// map writes; this module only operates on already-redacted strings.

import "server-only";

import {
  isPrivateIPv4,
  isPrivateIPv6,
  parseIPv4,
  parseIPv6,
  shouldRedactPublicIP,
} from "../redaction/ranges";
import type { RangeSet } from "../redaction/types";

const STORY_TOKEN_RE = /<<REDACTED_(IP|EMAIL|MAC)_E(\d+)_([0-9]+)>>/g;
const EVENT_TOKEN_RE = /<<REDACTED_(IP|EMAIL|MAC)_([0-9]+)>>/g;

// Re-anchored event-token matcher used by the leak scan. The story
// prompt SHOULD only ever contain story-scope tokens; an event-scope
// token in the analysis output is a hallucination signal because the
// LLM cannot have read one from the input.
const RESIDUAL_EVENT_TOKEN_RE = /<<REDACTED_(?:IP|EMAIL|MAC)_[0-9]+>>/g;

// Kind-agnostic backstop matcher. Unlike the matchers above it is NOT
// pinned to the kinds the redaction engine emits (`IP`/`EMAIL`/`MAC`),
// so it also catches an unknown-kind token the engine never produces —
// e.g. a hallucinated `<<REDACTED_HOSTNAME_E1_001>>` synthesised
// upstream (aicers/aimer#445). It matches all three token scopes: bare
// event `<<REDACTED_KIND_NNN>>`, story `<<REDACTED_KIND_E{i}_NNN>>`, and
// report `<<REDACTED_KIND_R{j}_NNN>>`. Any match not in `allowedTokens`
// is a token shape the scan cannot account for and must fail the job —
// defense-in-depth that survives even after the upstream synthesis is
// fixed (#380).
const REDACTION_TOKEN_SHAPE_RE = /<<REDACTED_[A-Z]+(?:_[ER]\d+)?_\d+>>/g;

// Plaintext-PII leak heuristics. Email + MAC are always-redacted
// kinds in the event-scope engine, so any match here is a leak or a
// hallucination (the prompt cannot have carried one in unredacted).
// IPv4/IPv6 are policy-driven and handled separately below.
const EMAIL_PII_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
const MAC_PII_RE = /\b[0-9A-Fa-f]{2}(?:[:-][0-9A-Fa-f]{2}){5}\b/g;
const IPV4_PII_RE =
  /\b(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(?:\.(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}\b/g;
// Same broad IPv6 candidate matcher used by `src/lib/redaction/engine.ts`;
// validated with `parseIPv6` so version-style strings like `09:30:00`
// don't trip the scan.
const IPV6_PII_CANDIDATE_RE =
  /(?<![A-Za-z0-9:.])[A-Fa-f0-9]{0,4}(?::[A-Fa-f0-9]{0,4}){2,}(?![A-Za-z0-9:.])/g;

const ALWAYS_REDACTED_PII_PATTERNS: ReadonlyArray<RegExp> = [
  EMAIL_PII_RE,
  MAC_PII_RE,
];

export interface StoryMemberInput {
  /** AICE ID of the member's event source (matches the canonical story version). */
  aiceId: string;
  /** Canonical numeric event key (NUMERIC(39,0) — pass as string). */
  eventKey: string;
  /** Already event-scope-redacted JSON payload. */
  event: unknown;
}

export interface StoryMemberRef {
  /**
   * Member position in the deterministic input order, 1-based. This is
   * the `{i}` embedded in the member's `<<REDACTED_*_E{i}_*>>` tokens
   * and equals the member's `StoryMemberInput.ordinal` sent to aimer
   * (aimer's contract is a contiguous `1..N` ordinal namespace that
   * must agree with the in-payload `E{i}` tokens — RFC 0002 #344).
   */
  index: number;
  aiceId: string;
  eventKey: string;
}

export interface BuildStoryTokenMapResult {
  /**
   * Rewritten member payloads, in input order. Each member's event JSON
   * has had every `<<REDACTED_KIND_NNN>>` token replaced with
   * `<<REDACTED_KIND_E{i}_NNN>>`.
   */
  rewrittenMembers: Array<{
    index: number;
    aiceId: string;
    eventKey: string;
    event: unknown;
  }>;
  /** Per-member references for downstream provenance. */
  refs: StoryMemberRef[];
  /**
   * Exact set of story-scope tokens that appeared in the rewritten
   * input. The hallucination scan rejects any `<<REDACTED_*_E{i}_*>>`
   * the LLM emits that is not in this set — including tokens whose
   * member index is valid but whose token number was never produced
   * (those are fabrications, not decodes).
   */
  allowedTokens: Set<string>;
}

/**
 * Rewrite event-scope redaction tokens to story-scope per RFC 0002
 * §"Token namespacing for multi-event LLM inputs". Pure / synchronous;
 * does no I/O.
 *
 * Caller responsibilities:
 *   - Pass members in the canonical, deterministic order. The index
 *     baked into the token string IS that order — re-ordering after
 *     the fact corrupts the token namespace.
 *   - Persist `refs` (or its serialized `input_event_refs` form) on
 *     the result row so renderers can do the inverse rewrite when
 *     restoring tokens for the analyst UI.
 */
export function buildStoryTokenMap(
  members: ReadonlyArray<StoryMemberInput>,
): BuildStoryTokenMapResult {
  const refs: StoryMemberRef[] = [];
  const allowedTokens = new Set<string>();
  const rewrittenMembers = members.map((member, arrayIndex) => {
    // 1-based ordinal: the `E{i}` token namespace and aimer's
    // `StoryMemberInput.ordinal` are a contiguous `1..N` sequence that
    // MUST agree (RFC 0002 #344). The array position is 0-based, so the
    // ordinal is `arrayIndex + 1`.
    const ordinal = arrayIndex + 1;
    refs.push({
      index: ordinal,
      aiceId: member.aiceId,
      eventKey: member.eventKey,
    });
    const json = JSON.stringify(member.event);
    const rewritten = json.replace(
      EVENT_TOKEN_RE,
      (_match, kind: string, nnn: string) => {
        const token = `<<REDACTED_${kind}_E${ordinal}_${nnn}>>`;
        allowedTokens.add(token);
        return token;
      },
    );
    return {
      index: ordinal,
      aiceId: member.aiceId,
      eventKey: member.eventKey,
      event: JSON.parse(rewritten) as unknown,
    };
  });
  return { rewrittenMembers, refs, allowedTokens };
}

export type LeakKind =
  | "unmapped_story_token"
  | "residual_event_token"
  | "unknown_kind_token"
  | "plaintext_pii";

export interface AnalysisLeak {
  kind: LeakKind;
  /** The leaked substring (token or PII match). */
  match: string;
  /** Member index parsed from `<<REDACTED_*_E{i}_*>>`, when applicable. */
  index?: number;
}

export interface ScanResult {
  leaks: AnalysisLeak[];
  /** Convenience flag: `leaks.length > 0`. */
  hasLeak: boolean;
}

/**
 * Walk the LLM's analysis narrative for tokens that don't map back to
 * `allowedTokens` (the exact rewritten set produced by
 * `buildStoryTokenMap`) or for plaintext PII patterns. Used by the
 * worker to detect hallucinated decodes before any result row is
 * written — RFC 0001 §"LLM hallucination handling" adapted to story
 * scope.
 *
 * Membership uses the full token string (kind + member index + token
 * number) rather than just the member index, so a token like
 * `<<REDACTED_IP_E0_999>>` is rejected even when member 0 exists —
 * the LLM cannot have read a number that was never in the input.
 *
 * The check is intentionally permissive in two ways the RFC calls
 * out: it ignores narrative prose that re-says the redacted value
 * count (e.g. "5 tokens"), and it does not require story-scope tokens
 * be QUOTED in the output — analysts read raw markdown.
 *
 * IPv4/IPv6 leak detection mirrors the **redaction-engine policy**:
 * a literal is flagged only if the engine WOULD HAVE redacted it
 * given the customer's `ranges` (private always; public per
 * `shouldRedactPublicIP`, which treats an empty range set as
 * "redact no public" — public IPs pass through). Public out-of-range
 * IPs that legitimately passed through redaction into
 * `story_member.event` are NOT flagged
 * — otherwise the LLM faithfully echoing such an input would
 * permanently fail the job for any customer that narrowed their
 * redaction scope.
 */
export function scanStoryAnalysisForLeaks(
  analysisText: string,
  allowedTokens: ReadonlySet<string>,
  ranges: RangeSet,
): ScanResult {
  const leaks: AnalysisLeak[] = [];
  // Token strings already classified by a kind-specific check below, so
  // the generic backstop doesn't re-flag them under `unknown_kind_token`.
  const classified = new Set<string>();

  // Reset stateful regex objects defensively — `lastIndex` is shared
  // across calls when /g is used.
  STORY_TOKEN_RE.lastIndex = 0;
  for (
    let m = STORY_TOKEN_RE.exec(analysisText);
    m !== null;
    m = STORY_TOKEN_RE.exec(analysisText)
  ) {
    if (!allowedTokens.has(m[0])) {
      classified.add(m[0]);
      leaks.push({
        kind: "unmapped_story_token",
        match: m[0],
        index: Number(m[2]),
      });
    }
  }

  RESIDUAL_EVENT_TOKEN_RE.lastIndex = 0;
  for (
    let m = RESIDUAL_EVENT_TOKEN_RE.exec(analysisText);
    m !== null;
    m = RESIDUAL_EVENT_TOKEN_RE.exec(analysisText)
  ) {
    classified.add(m[0]);
    leaks.push({ kind: "residual_event_token", match: m[0] });
  }

  // Kind-agnostic backstop: any redaction-token shape not in
  // `allowedTokens` and not already classified above is a token the
  // scan cannot restore — including unknown-kind tokens the engine never
  // emits (e.g. `<<REDACTED_HOSTNAME_E1_001>>`, #380).
  REDACTION_TOKEN_SHAPE_RE.lastIndex = 0;
  for (
    let m = REDACTION_TOKEN_SHAPE_RE.exec(analysisText);
    m !== null;
    m = REDACTION_TOKEN_SHAPE_RE.exec(analysisText)
  ) {
    if (allowedTokens.has(m[0]) || classified.has(m[0])) continue;
    classified.add(m[0]);
    leaks.push({ kind: "unknown_kind_token", match: m[0] });
  }

  for (const re of ALWAYS_REDACTED_PII_PATTERNS) {
    re.lastIndex = 0;
    for (let m = re.exec(analysisText); m !== null; m = re.exec(analysisText)) {
      leaks.push({ kind: "plaintext_pii", match: m[0] });
    }
  }

  IPV4_PII_RE.lastIndex = 0;
  for (
    let m = IPV4_PII_RE.exec(analysisText);
    m !== null;
    m = IPV4_PII_RE.exec(analysisText)
  ) {
    const bytes = parseIPv4(m[0]);
    if (!bytes) continue;
    if (isPrivateIPv4(bytes) || shouldRedactPublicIP(bytes, 4, ranges)) {
      leaks.push({ kind: "plaintext_pii", match: m[0] });
    }
  }

  // IPv6 needs structural validation: the broad regex matches things
  // like `09:30:00` (timestamps) that aren't addresses. Defer to the
  // same `parseIPv6` the redaction engine uses, then apply the same
  // private/range-set policy as the IPv4 branch.
  IPV6_PII_CANDIDATE_RE.lastIndex = 0;
  for (
    let m = IPV6_PII_CANDIDATE_RE.exec(analysisText);
    m !== null;
    m = IPV6_PII_CANDIDATE_RE.exec(analysisText)
  ) {
    const bytes = parseIPv6(m[0]);
    if (!bytes) continue;
    if (isPrivateIPv6(bytes) || shouldRedactPublicIP(bytes, 6, ranges)) {
      leaks.push({ kind: "plaintext_pii", match: m[0] });
    }
  }

  return { leaks, hasLeak: leaks.length > 0 };
}
