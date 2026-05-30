// RFC 0002 Phase 2 (#297) — report-scope token restore on the
// rendering side.
//
// The report worker folds story-scope (`E{i}`) and event-scope tokens
// into a single report-scope namespace `<<REDACTED_KIND_R{j}_SEQ>>`
// (see `report-token.ts`). `periodic_report_result` does NOT persist the
// per-token map; the loader re-derives it by replaying
// `buildReportTokenMap` over the cited leaf narratives (pinned by
// `input_story_refs` / `input_event_refs` generation), then resolves
// each report token's source token to plaintext through the relevant
// event redaction map.
//
// This module is the final substitution step: given a fully resolved
// `report token → plaintext` map, substitute it into the narrative.
// Tokens with no resolved plaintext (missing map row, decrypt failure,
// superseded leaf) are passed through unchanged so the page still
// renders — same defensive posture as the story-scope restore.

const REPORT_TOKEN_RE = /<<REDACTED_(?:IP|EMAIL|MAC)_R\d+_\d+>>/g;

export function restoreReportAnalysisTokens(
  text: string,
  plaintextByReportToken: ReadonlyMap<string, string>,
): string {
  return text.replace(REPORT_TOKEN_RE, (token) => {
    const value = plaintextByReportToken.get(token);
    return value ?? token;
  });
}
