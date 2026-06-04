// RFC 0003 P1a — `EnrichmentFact` trivial constructor.
//
// P1a defines the type + this constructor only. The redaction-token-aware
// fact pipeline (`F{k}` fact-scope, `input_fact_refs`,
// `enrichment_redaction_map`) is RFC 0001 Amendment A (#424) territory,
// consumed by the C1 injection issue — NOT implemented here.

import type { EnrichmentFact } from "./types";

/**
 * Build a narrative enrichment fact. `redactionTokens` lists tokens the text
 * references (empty for now); Amendment A will populate the redaction map.
 */
export function createEnrichmentFact(
  text: string,
  redactionTokens: readonly string[] = [],
): EnrichmentFact {
  return { text, redactionTokens: [...redactionTokens] };
}
