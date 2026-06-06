// RFC 0003 C1 (#440) — fact-scope token rename + restore.
//
// Enrichment facts arrive from `story_enrichment_fact` already redacted
// with SELF-scoped tokens `<<REDACTED_KIND_NNN>>` (the per-fact map the
// enrichment worker wrote). Different facts reuse the same self-scoped
// numbers for different plaintext, so — exactly as `story-token.ts`
// re-namespaces a member event's tokens to story-scope `E{i}` before the
// member events are concatenated into one prompt — this module folds each
// customer-asset fact's self-scoped tokens into a fact-scope namespace
// `<<REDACTED_KIND_F{k}_NNN>>`, where `{k}` is the fact's 1-based position
// within the story.
//
//   - `buildFactTokenMap(facts)` renames every self-scoped token to
//     fact-scope (pure string rename — no decrypt, no re-redaction).
//     External fact indicators carry no token and pass through raw.
//     Returns the rewritten fact texts (the redacted `enrichmentFacts`
//     sent to aimer) and a `refs` array mapping `{k} -> fact_id` for
//     `input_fact_refs`.
//
//   - `restoreStoryFactTokens(text, mapsByIndex)` is the rendering-side
//     inverse: parse `F{k}`, look up `k` in `input_fact_refs` to get the
//     fact's `enrichment_redaction_map`, and resolve the self-scoped
//     token back to plaintext.
//
// Parallel to `story-token.ts` / `story-token-restore.ts` (the `E{i}`
// machinery); both are pure / synchronous and only operate on
// already-redacted strings.

import type { RedactionMap } from "@/lib/redaction";

// Self-scoped event/fact token as written by the redaction engine.
const SELF_TOKEN_RE = /<<REDACTED_(IP|EMAIL|MAC|DOMAIN)_([0-9]+)>>/g;
// Fact-scope token: `<<REDACTED_IP_F1_001>>`.
const FACT_TOKEN_RE = /<<REDACTED_(IP|EMAIL|MAC|DOMAIN)_F(\d+)_(\d+)>>/g;

export interface FactInput {
  /** `story_enrichment_fact.fact_id` (BIGINT as decimal string). */
  factId: string;
  /** Redacted narrative text with self-scoped `<<REDACTED_*_NNN>>` tokens. */
  text: string;
}

export interface FactRef {
  /** 1-based fact index within this story; the `{k}` embedded in `F{k}`. */
  index: number;
  factId: string;
}

export interface BuildFactTokenMapResult {
  /**
   * Redacted fact texts in input order, with every self-scoped token
   * renamed to its fact-scope `<<REDACTED_KIND_F{k}_NNN>>` form. These are
   * the redacted `enrichmentFacts` strings sent to aimer (forwarded
   * verbatim into the prompt).
   */
  rewrittenFacts: string[];
  /**
   * Per-fact references in input order. `refs[k-1].index === k` and
   * `refs[k-1].factId` anchors that fact's `enrichment_redaction_map` row.
   * Persisted as `input_fact_refs` so the renderer can demap `F{k}`.
   */
  refs: FactRef[];
  /**
   * Exact set of fact-scope tokens produced. Folded into the story
   * worker's hallucination-scan allow-list so a legitimate `F{k}` the LLM
   * echoes is not flagged, while a fabricated one still is.
   */
  allowedTokens: Set<string>;
}

/**
 * Rename self-scoped redaction tokens in each fact to fact-scope `F{k}`.
 * Pure / synchronous; does no I/O. Every fact gets a `{k}` (1-based input
 * order) and a `refs` entry, even when it has no tokens (external
 * indicators), so `{k}` aligns positionally with `rewrittenFacts` and the
 * renderer can map any `F{k}` it later sees.
 */
export function buildFactTokenMap(
  facts: ReadonlyArray<FactInput>,
): BuildFactTokenMapResult {
  const refs: FactRef[] = [];
  const allowedTokens = new Set<string>();
  const rewrittenFacts = facts.map((fact, arrayIndex) => {
    const k = arrayIndex + 1;
    refs.push({ index: k, factId: fact.factId });
    SELF_TOKEN_RE.lastIndex = 0;
    return fact.text.replace(
      SELF_TOKEN_RE,
      (_match, kind: string, nnn: string) => {
        const token = `<<REDACTED_${kind}_F${k}_${nnn}>>`;
        allowedTokens.add(token);
        return token;
      },
    );
  });
  return { rewrittenFacts, refs, allowedTokens };
}

/**
 * Substitute every `<<REDACTED_KIND_F{k}_NNN>>` token in `text` with its
 * plaintext entity, resolved through the fact redaction map keyed by `k`.
 * Tokens whose index has no map (out-of-range, decrypt failure, or the
 * fact row vanished) are passed through unchanged so the page still
 * renders — same defensive posture as the `E{i}` restore.
 */
export function restoreStoryFactTokens(
  text: string,
  mapsByIndex: ReadonlyMap<number, RedactionMap>,
): string {
  return text.replace(
    FACT_TOKEN_RE,
    (token, kind: string, idxStr: string, nnn: string) => {
      const idx = Number(idxStr);
      const map = mapsByIndex.get(idx);
      if (!map) return token;
      const selfToken = `<<REDACTED_${kind}_${nnn}>>`;
      const entry = map[selfToken];
      return entry ? entry.value : token;
    },
  );
}
