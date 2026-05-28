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
//     position in the canonical, deterministic order. Returns the
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

const STORY_TOKEN_RE = /<<REDACTED_(IP|EMAIL|MAC)_E(\d+)_([0-9]+)>>/g;
const EVENT_TOKEN_RE = /<<REDACTED_(IP|EMAIL|MAC)_([0-9]+)>>/g;

// Re-anchored event-token matcher used by the leak scan. The story
// prompt SHOULD only ever contain story-scope tokens; an event-scope
// token in the analysis output is a hallucination signal because the
// LLM cannot have read one from the input.
const RESIDUAL_EVENT_TOKEN_RE = /<<REDACTED_(?:IP|EMAIL|MAC)_[0-9]+>>/g;

// Plaintext-PII leak heuristics. The token rewrite consumes everything
// already redacted by the event-scope engine, so any of these patterns
// in the LLM output came from the model fabricating one — not from a
// leak through the redaction layer. Same lexical shapes as
// `src/lib/redaction/engine.ts`'s patterns; intentionally duplicated
// here so the module has no runtime dependency on the event-scope
// engine.
const PII_PATTERNS: ReadonlyArray<RegExp> = [
  /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g,
  /\b[0-9A-Fa-f]{2}(?:[:-][0-9A-Fa-f]{2}){5}\b/g,
  /\b(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(?:\.(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}\b/g,
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
  /** Member position in the deterministic input order, 0-indexed. */
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
  const rewrittenMembers = members.map((member, index) => {
    refs.push({ index, aiceId: member.aiceId, eventKey: member.eventKey });
    const json = JSON.stringify(member.event);
    const rewritten = json.replace(
      EVENT_TOKEN_RE,
      (_match, kind: string, nnn: string) => {
        const token = `<<REDACTED_${kind}_E${index}_${nnn}>>`;
        allowedTokens.add(token);
        return token;
      },
    );
    return {
      index,
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
 */
export function scanStoryAnalysisForLeaks(
  analysisText: string,
  allowedTokens: ReadonlySet<string>,
): ScanResult {
  const leaks: AnalysisLeak[] = [];

  // Reset stateful regex objects defensively — `lastIndex` is shared
  // across calls when /g is used.
  STORY_TOKEN_RE.lastIndex = 0;
  for (
    let m = STORY_TOKEN_RE.exec(analysisText);
    m !== null;
    m = STORY_TOKEN_RE.exec(analysisText)
  ) {
    if (!allowedTokens.has(m[0])) {
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
    leaks.push({ kind: "residual_event_token", match: m[0] });
  }

  for (const re of PII_PATTERNS) {
    re.lastIndex = 0;
    for (let m = re.exec(analysisText); m !== null; m = re.exec(analysisText)) {
      leaks.push({ kind: "plaintext_pii", match: m[0] });
    }
  }

  return { leaks, hasLeak: leaks.length > 0 };
}
