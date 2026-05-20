// Token-restoration utility used by the analysis result page.
//
// Restoring tokens means substituting every `<<REDACTED_*_NNN>>` token
// in `analysis_text` with its original entity from the decrypted
// `event_redaction_map`. The result page always restores (per RFC 0001
// §"UI — analysis result page"): callers who pass the route gate are
// authorized to see the original entities by definition.
//
// `<<UNVERIFIED_*_NNN>>` markers are intentionally NOT restored. There
// is no original entity behind them — they are the rendering. The UI
// renders them with a separate visual treatment.

import type { RedactionMap } from "@/lib/redaction";

const REDACTED_TOKEN_RE = /<<REDACTED_(IP|EMAIL|MAC)_(\d+)>>/g;

/**
 * Substitute every `<<REDACTED_*_NNN>>` token in `text` with the
 * original entity from `map`. Tokens with no map entry are passed
 * through unchanged — this is unreachable in correct code (the engine
 * never emits a token without writing the matching map entry), but
 * passing through is safer than crashing the result page.
 */
export function restoreRedactedTokens(text: string, map: RedactionMap): string {
  return text.replace(REDACTED_TOKEN_RE, (token) => {
    const entry = map[token];
    return entry ? entry.value : token;
  });
}
