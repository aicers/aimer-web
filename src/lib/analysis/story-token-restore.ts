// RFC 0002 Phase 1 (#296) — story-scope token restore on the
// rendering side.
//
// The story analysis worker rewrites every `<<REDACTED_KIND_NNN>>`
// token in each member's event JSON to `<<REDACTED_KIND_E{i}_NNN>>`
// (see `story-token.ts`), where `{i}` is the member's position in
// `input_event_refs`. The LLM is asked to preserve those tokens
// verbatim in its output.
//
// To render the analysis text back to plaintext for an analyst, RFC
// 0002 §"Token namespacing for multi-event LLM inputs" specifies:
//
//   parse `<<REDACTED_KIND_E{i}_NNN>>`,
//   look up index `i` in `input_event_refs` to get `(aice_id, event_key)`,
//   decrypt that event's redaction map,
//   resolve `<<REDACTED_KIND_NNN>>` to the original value.
//
// This module is the rendering side of that procedure. The loader
// resolves and decrypts every referenced map up front, then passes a
// `Map<index, RedactionMap>` to `restoreStoryAnalysisTokens`.

import type { RedactionMap } from "@/lib/redaction";

const STORY_TOKEN_RE = /<<REDACTED_(IP|EMAIL|MAC)_E(\d+)_(\d+)>>/g;

/**
 * Substitute every `<<REDACTED_KIND_E{i}_NNN>>` token in `text` with
 * its plaintext entity, resolved through the event redaction map
 * keyed by `i`. Tokens whose index has no map (out-of-range, decrypt
 * failure, or the event row vanished) are passed through unchanged
 * so the page still renders — same defensive posture as RFC 0001's
 * event-scope `restoreRedactedTokens`.
 */
export function restoreStoryAnalysisTokens(
  text: string,
  mapsByIndex: ReadonlyMap<number, RedactionMap>,
): string {
  return text.replace(
    STORY_TOKEN_RE,
    (token, kind: string, idxStr: string, nnn: string) => {
      const idx = Number(idxStr);
      const map = mapsByIndex.get(idx);
      if (!map) return token;
      const eventToken = `<<REDACTED_${kind}_${nnn}>>`;
      const entry = map[eventToken];
      return entry ? entry.value : token;
    },
  );
}
