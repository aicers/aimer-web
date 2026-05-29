// RFC 0002 Phase 2 (#297) — report-scope token rewrite + leak scan.
//
// A periodic report synthesizes multiple already-analyzed leaves into one
// LLM prompt:
//
//   - story leaves carry story-scope tokens `<<REDACTED_KIND_E{i}_NNN>>`
//     (RFC 0002 Phase 1 / §"Token namespacing for multi-event LLM
//     inputs"), where `{i}` is the story member ordinal,
//   - event leaves carry bare event-scope tokens `<<REDACTED_KIND_NNN>>`
//     (RFC 0001).
//
// The same token string in two different leaves points to two different
// plaintext entities, so — exactly as the story worker re-namespaces
// event-scope tokens to story-scope before concatenating member events —
// this module folds BOTH input scopes into a single report-scope
// namespace `<<REDACTED_KIND_R{j}_SEQ>>`, where `{j}` is the leaf's
// 1-based position in the combined (stories-then-events) input order and
// `SEQ` is a fresh per-leaf counter assigned in first-seen order.
//
// The two-layer indirection (event → story-scope → report-scope) is
// RFC-mandated (§"Multi-event redaction tokens"); demap on display
// follows the same chain in reverse via the per-leaf `ReportTokenRef`
// returned here (report token → source token → per-event redaction map →
// plaintext).
//
// Distinct from `src/lib/analysis/story-token.ts` (story-scope helpers):
// those rewrite event-scope → story-scope for ONE story; these rewrite
// story-scope OR event-scope → report-scope for a whole report. Both are
// pure / synchronous and only operate on already-redacted strings; the
// encryption / map writes live in `src/lib/redaction/*`.

import "server-only";

import {
  isPrivateIPv4,
  isPrivateIPv6,
  parseIPv4,
  parseIPv6,
  shouldRedactPublicIP,
} from "../redaction/ranges";
import type { RangeSet } from "../redaction/types";

// Story-scope token: `<<REDACTED_IP_E1_001>>`. The `E{i}` group is the
// story member ordinal; the trailing group is the event-scope token
// number. Both are folded into the report-scope `SEQ` on rewrite.
const STORY_SCOPE_TOKEN_RE = /<<REDACTED_(IP|EMAIL|MAC)_E(\d+)_(\d+)>>/g;
// Event-scope token: `<<REDACTED_IP_001>>`. The kind is followed directly
// by digits (no `E{i}` segment), so this never matches a story-scope
// token.
const EVENT_SCOPE_TOKEN_RE = /<<REDACTED_(IP|EMAIL|MAC)_(\d+)>>/g;

// Report-scope token matcher used by the leak scan. The report prompt
// SHOULD only ever contain report-scope tokens; a lower-scope token in
// the output is a hallucination signal because the LLM never saw one.
const REPORT_TOKEN_RE = /<<REDACTED_(IP|EMAIL|MAC)_R(\d+)_(\d+)>>/g;
const RESIDUAL_STORY_SCOPE_TOKEN_RE = /<<REDACTED_(?:IP|EMAIL|MAC)_E\d+_\d+>>/g;
const RESIDUAL_EVENT_SCOPE_TOKEN_RE = /<<REDACTED_(?:IP|EMAIL|MAC)_\d+>>/g;

// Plaintext-PII leak heuristics — identical policy to story-token.ts.
// Email + MAC are always-redacted kinds, so any match is a leak. IPv4/
// IPv6 are policy-driven (private always; public per the customer range
// set) and validated structurally before flagging.
const EMAIL_PII_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
const MAC_PII_RE = /\b[0-9A-Fa-f]{2}(?:[:-][0-9A-Fa-f]{2}){5}\b/g;
const IPV4_PII_RE =
  /\b(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(?:\.(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}\b/g;
const IPV6_PII_CANDIDATE_RE =
  /(?<![A-Za-z0-9:.])[A-Fa-f0-9]{0,4}(?::[A-Fa-f0-9]{0,4}){2,}(?![A-Za-z0-9:.])/g;

const ALWAYS_REDACTED_PII_PATTERNS: ReadonlyArray<RegExp> = [
  EMAIL_PII_RE,
  MAC_PII_RE,
];

export type ReportLeafKind = "story" | "event";

export interface ReportTokenMapping {
  /** Report-scope token embedded in the LLM input (`<<REDACTED_*_R{j}_*>>`). */
  reportToken: string;
  /**
   * The source token this report token replaced — a story-scope
   * `<<REDACTED_*_E{i}_*>>` (when `kind === "story"`) or an event-scope
   * `<<REDACTED_*_*>>` (when `kind === "event"`). Demap reverses through
   * this string: story-scope tokens still carry the `E{i}` member ordinal
   * the renderer needs to pick the right per-event redaction map.
   */
  sourceToken: string;
}

export interface ReportTokenRef {
  /** Leaf position in the combined input order, 1-based. The `{j}` in `R{j}`. */
  index: number;
  kind: ReportLeafKind;
  /** Per-leaf report-token → source-token mappings (for demap on display). */
  tokens: ReportTokenMapping[];
}

/** One leaf's text fields fed to the report prompt. */
export interface ReportLeafText {
  /** The leaf's analysis narrative. */
  analysis: string;
  /** Leaf severity factors (RFC 0002 round-11 pass-through). */
  severityFactors?: ReadonlyArray<string>;
  /** Leaf likelihood factors (RFC 0002 round-11 pass-through). */
  likelihoodFactors?: ReadonlyArray<string>;
}

/** A leaf's factor arrays after report-scope rewrite. */
export interface RewrittenLeafFactors {
  severityFactors: string[];
  likelihoodFactors: string[];
}

export interface BuildReportTokenMapResult {
  /** Story leaf narratives, rewritten to report scope, in input order. */
  rewrittenStoryTexts: string[];
  /** Event leaf narratives, rewritten to report scope, in input order. */
  rewrittenEventTexts: string[];
  /** Story leaf factors, rewritten to report scope, in input order. */
  rewrittenStoryFactors: RewrittenLeafFactors[];
  /** Event leaf factors, rewritten to report scope, in input order. */
  rewrittenEventFactors: RewrittenLeafFactors[];
  /**
   * Per-leaf references, in combined order (all story leaves first, then
   * all event leaves). `refs[k]` describes story leaf `k` for
   * `k < storyLeaves.length`; the remainder describe the event leaves.
   */
  refs: ReportTokenRef[];
  /**
   * Exact set of report-scope tokens that appear in the rewritten input.
   * The hallucination scan rejects any `<<REDACTED_*_R{j}_*>>` the LLM
   * emits that is not in this set.
   */
  allowedTokens: Set<string>;
}

/**
 * Rewrite every text field of one leaf (analysis first, then factor
 * arrays) through a SHARED per-leaf token map, so a redacted entity that
 * appears in both the narrative and a factor folds to the same report
 * token. Processing the analysis first keeps its token numbering stable
 * for the display-time replay, which only re-reads `analysis` — factors
 * are not stored in the narrative sections, so any factor-only token
 * never needs to be re-derived on display.
 */
function rewriteLeafFields(
  texts: ReadonlyArray<string>,
  leafIndex: number,
  kind: ReportLeafKind,
  re: RegExp,
  allowedTokens: Set<string>,
): { rewritten: string[]; ref: ReportTokenRef } {
  // Dedupe identical source tokens to one report token per leaf so a
  // redacted entity that recurs maps consistently across all fields.
  const seen = new Map<string, string>();
  const tokens: ReportTokenMapping[] = [];
  let seq = 0;
  const rewritten = texts.map((text) => {
    re.lastIndex = 0;
    return text.replace(re, (full: string, kindMatch: string) => {
      const existing = seen.get(full);
      if (existing) return existing;
      seq += 1;
      const reportToken = `<<REDACTED_${kindMatch}_R${leafIndex}_${String(
        seq,
      ).padStart(3, "0")}>>`;
      seen.set(full, reportToken);
      tokens.push({ reportToken, sourceToken: full });
      allowedTokens.add(reportToken);
      return reportToken;
    });
  });
  return { rewritten, ref: { index: leafIndex, kind, tokens } };
}

/**
 * Rewrite already-redacted story-scope and event-scope tokens into a
 * single report-scope namespace per RFC 0002 §"Multi-event redaction
 * tokens". Pure / synchronous; does no I/O.
 *
 * `{j}` is the leaf's 1-based position in the combined order
 * (`storyLeaves` first, then `eventLeaves`), so report tokens from
 * different leaves never collide even when their source token numbers
 * match. Each leaf's analysis AND its factor arrays are folded into the
 * one per-leaf namespace, so a stray scope token in a factor (factors are
 * normally pure noun phrases, but the rewrite is defensive — RFC 0002
 * round-11) never reaches the prompt in story/event scope. Caller
 * responsibilities:
 *   - Pass leaves in the deterministic selection order; the `{j}` baked
 *     into each token IS that order.
 *   - Persist `refs` so renderers can reverse the chain when restoring
 *     tokens for the analyst UI.
 */
export function buildReportTokenMap(
  storyLeaves: ReadonlyArray<ReportLeafText>,
  eventLeaves: ReadonlyArray<ReportLeafText>,
): BuildReportTokenMapResult {
  const allowedTokens = new Set<string>();
  const refs: ReportTokenRef[] = [];
  const rewrittenStoryTexts: string[] = [];
  const rewrittenEventTexts: string[] = [];
  const rewrittenStoryFactors: RewrittenLeafFactors[] = [];
  const rewrittenEventFactors: RewrittenLeafFactors[] = [];

  const rewriteOne = (
    leaf: ReportLeafText,
    leafIndex: number,
    kind: ReportLeafKind,
    re: RegExp,
  ): {
    analysis: string;
    factors: RewrittenLeafFactors;
    ref: ReportTokenRef;
  } => {
    const sev = leaf.severityFactors ?? [];
    const lik = leaf.likelihoodFactors ?? [];
    const { rewritten, ref } = rewriteLeafFields(
      [leaf.analysis, ...sev, ...lik],
      leafIndex,
      kind,
      re,
      allowedTokens,
    );
    return {
      analysis: rewritten[0],
      factors: {
        severityFactors: rewritten.slice(1, 1 + sev.length),
        likelihoodFactors: rewritten.slice(1 + sev.length),
      },
      ref,
    };
  };

  let leafIndex = 0;
  for (const leaf of storyLeaves) {
    leafIndex += 1;
    const { analysis, factors, ref } = rewriteOne(
      leaf,
      leafIndex,
      "story",
      STORY_SCOPE_TOKEN_RE,
    );
    rewrittenStoryTexts.push(analysis);
    rewrittenStoryFactors.push(factors);
    refs.push(ref);
  }
  for (const leaf of eventLeaves) {
    leafIndex += 1;
    const { analysis, factors, ref } = rewriteOne(
      leaf,
      leafIndex,
      "event",
      EVENT_SCOPE_TOKEN_RE,
    );
    rewrittenEventTexts.push(analysis);
    rewrittenEventFactors.push(factors);
    refs.push(ref);
  }

  return {
    rewrittenStoryTexts,
    rewrittenEventTexts,
    rewrittenStoryFactors,
    rewrittenEventFactors,
    refs,
    allowedTokens,
  };
}

export type ReportLeakKind =
  | "unmapped_report_token"
  | "residual_story_token"
  | "residual_event_token"
  | "plaintext_pii";

export interface ReportAnalysisLeak {
  kind: ReportLeakKind;
  /** The leaked substring (token or PII match). */
  match: string;
  /** Leaf index parsed from `<<REDACTED_*_R{j}_*>>`, when applicable. */
  index?: number;
}

export interface ReportScanResult {
  leaks: ReportAnalysisLeak[];
  /** Convenience flag: `leaks.length > 0`. */
  hasLeak: boolean;
}

function collectAllowedTokens(
  refs: ReadonlyArray<ReportTokenRef>,
): Set<string> {
  const set = new Set<string>();
  for (const ref of refs) {
    for (const t of ref.tokens) set.add(t.reportToken);
  }
  return set;
}

/**
 * Walk the LLM's report narrative for report-scope tokens that don't map
 * back to `refs`, for residual lower-scope tokens the LLM could not have
 * read, or for plaintext PII. A non-empty result means the LLM
 * hallucinated a decode or leaked a value; the worker fails the job
 * before any `periodic_report_result` row is written.
 *
 * IPv4/IPv6 leak detection mirrors the redaction-engine policy exactly as
 * `scanStoryAnalysisForLeaks` does: a literal is flagged only if the
 * engine would have redacted it given the customer's `ranges` (private
 * always; public per `shouldRedactPublicIP`, empty range set ⇒ redact all
 * public). Public out-of-range IPs that legitimately reached the prompt
 * are not flagged.
 */
export function scanReportAnalysisForLeaks(
  reportText: string,
  refs: ReadonlyArray<ReportTokenRef>,
  ranges: RangeSet,
): ReportScanResult {
  const leaks: ReportAnalysisLeak[] = [];
  const allowedTokens = collectAllowedTokens(refs);

  REPORT_TOKEN_RE.lastIndex = 0;
  for (
    let m = REPORT_TOKEN_RE.exec(reportText);
    m !== null;
    m = REPORT_TOKEN_RE.exec(reportText)
  ) {
    if (!allowedTokens.has(m[0])) {
      leaks.push({
        kind: "unmapped_report_token",
        match: m[0],
        index: Number(m[2]),
      });
    }
  }

  RESIDUAL_STORY_SCOPE_TOKEN_RE.lastIndex = 0;
  for (
    let m = RESIDUAL_STORY_SCOPE_TOKEN_RE.exec(reportText);
    m !== null;
    m = RESIDUAL_STORY_SCOPE_TOKEN_RE.exec(reportText)
  ) {
    leaks.push({ kind: "residual_story_token", match: m[0] });
  }

  RESIDUAL_EVENT_SCOPE_TOKEN_RE.lastIndex = 0;
  for (
    let m = RESIDUAL_EVENT_SCOPE_TOKEN_RE.exec(reportText);
    m !== null;
    m = RESIDUAL_EVENT_SCOPE_TOKEN_RE.exec(reportText)
  ) {
    leaks.push({ kind: "residual_event_token", match: m[0] });
  }

  for (const re of ALWAYS_REDACTED_PII_PATTERNS) {
    re.lastIndex = 0;
    for (let m = re.exec(reportText); m !== null; m = re.exec(reportText)) {
      leaks.push({ kind: "plaintext_pii", match: m[0] });
    }
  }

  IPV4_PII_RE.lastIndex = 0;
  for (
    let m = IPV4_PII_RE.exec(reportText);
    m !== null;
    m = IPV4_PII_RE.exec(reportText)
  ) {
    const bytes = parseIPv4(m[0]);
    if (!bytes) continue;
    if (isPrivateIPv4(bytes) || shouldRedactPublicIP(bytes, 4, ranges)) {
      leaks.push({ kind: "plaintext_pii", match: m[0] });
    }
  }

  IPV6_PII_CANDIDATE_RE.lastIndex = 0;
  for (
    let m = IPV6_PII_CANDIDATE_RE.exec(reportText);
    m !== null;
    m = IPV6_PII_CANDIDATE_RE.exec(reportText)
  ) {
    const bytes = parseIPv6(m[0]);
    if (!bytes) continue;
    if (isPrivateIPv6(bytes) || shouldRedactPublicIP(bytes, 6, ranges)) {
      leaks.push({ kind: "plaintext_pii", match: m[0] });
    }
  }

  return { leaks, hasLeak: leaks.length > 0 };
}
