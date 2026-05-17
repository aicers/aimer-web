import type { Pool } from "pg";

/**
 * Read-side helpers that resolve `(external_key, event_key)` to a Phase 2
 * analysis row, and that fetch the associated `analysis_narrative` row.
 *
 * ## v1 scope: Phase 2 event-key lookup only
 *
 * `detection_events` (Phase 1) is **not** searchable by `event_key` in v1 —
 * the payload is encrypted BYTEA and aimer-web does not maintain a
 * plaintext `event_key` index on it. Phase 1 rows are reachable only
 * through Phase 1-native surfaces (the Detection bridge audit log or a
 * future Phase 1-specific list page) by their internal
 * `detection_events.id`, **not** by `event_key`.
 *
 * Consequently, when an analysis caller asks "give me the analysis for
 * `event_key = X`," this module looks only at `baseline_event` (Phase 2)
 * and returns either the Phase 2 row or `none`.
 *
 * This is a deliberate limitation per RFC 0002 §8 (the Phase 2 row is
 * the canonical analysis row by design), not a bug. If a future need
 * arises to look up Phase 1 rows by `event_key`, the path is to add a
 * plaintext `event_key` column (or sibling index table) to
 * `detection_events` — separate future work, additive RFC change.
 *
 * @see {@link https://github.com/aicers/aice-web-next/blob/main/rfcs/0002-aimer-web-phase2-contract.md RFC 0002}
 */

/**
 * A `baseline_event` row as returned by the analysis lookup. NUMERIC and
 * BIGINT columns are surfaced as strings — node-postgres returns these
 * as strings by default because the JS `number` type cannot safely
 * represent values beyond 2^53 (NUMERIC(39, 0) is i128 on the
 * aice-web-next side; even BIGINT may overflow).
 */
export interface BaselineEventRow {
  baseline_version: string;
  event_key: string;
  event_time: Date;
  kind: string;
  category: string | null;
  primary_asset: string | null;
  raw_score: number;
  selector_tags: string[];
  raw_event: Record<string, unknown>;
  score_window_context: Record<string, unknown>;
  window_signals: Record<string, unknown>;
  asset_context: Record<string, unknown> | null;
  scoring_weights_snapshot: Record<string, unknown>;
  source_aice_id: string;
  received_at: Date;
}

export type AnalysisLookupResult =
  | { source: "phase2"; row: BaselineEventRow }
  | { source: "none" };

/**
 * Resolve an `event_key` to the canonical Phase 2 `baseline_event` row.
 *
 * Returns the row with the most recent `received_at` when multiple
 * `baseline_version` values carry the same `event_key` (the event was
 * re-sent under a bumped baseline — `baseline_event.event_key` is not
 * unique across `baseline_version` per #216).
 *
 * Returns `{ source: "none" }` when no Phase 2 row exists. **This does
 * not mean the event never existed on aimer-web** — see the UI guidance
 * below for the two operational meanings the caller must distinguish.
 *
 * ## Guidance for the eventual analysis UI consumer
 *
 * `{ source: "none" }` has **two** distinct operational meanings that
 * the v1 lookup cannot tell apart:
 *
 *   1. The event was never sent to aimer-web at all.
 *   2. The event was sent via Phase 1 (Detection menu ad-hoc send) but
 *      not via Phase 2 baseline push. A `detection_events` row exists
 *      but is not reachable by `event_key` in v1 because its payload is
 *      encrypted BYTEA without a plaintext `event_key` index.
 *
 * Recommended UI copy: render "No baseline analysis available for this
 * event" rather than "Event not found" — the first phrasing is true in
 * both cases; the second is misleading in case (2). A future Phase 1
 * plaintext `event_key` index would let the UI distinguish the two.
 *
 * @param customerPool - Per-customer DB pool (the customer scope IS the DB)
 * @param eventKey     - Stringified NUMERIC(39, 0)
 */
export async function lookupAnalysisForEvent(
  customerPool: Pool,
  eventKey: string,
): Promise<AnalysisLookupResult> {
  const { rows } = await customerPool.query<BaselineEventRow>(
    `SELECT
       baseline_version,
       event_key::text AS event_key,
       event_time,
       kind,
       category,
       primary_asset,
       raw_score,
       selector_tags,
       raw_event,
       score_window_context,
       window_signals,
       asset_context,
       scoring_weights_snapshot,
       source_aice_id,
       received_at
     FROM baseline_event
     WHERE event_key = $1::numeric
     ORDER BY received_at DESC
     LIMIT 1`,
    [eventKey],
  );

  if (rows.length === 0) {
    return { source: "none" };
  }
  return { source: "phase2", row: rows[0] };
}

// ---------------------------------------------------------------------------
// analysis_narrative
// ---------------------------------------------------------------------------

export type AnalysisNarrativeTargetKind =
  | "baseline_event"
  | "story"
  | "policy_run";

/**
 * Keys that identify the narrative's target row. Shape depends on
 * `targetKind`:
 *
 *   - `baseline_event`: `{ baseline_version, event_key }`
 *   - `story`:          `{ story_id, story_version }`
 *   - `policy_run`:     `{ run_id }`
 *
 * Both string and number values are accepted because BIGINT and
 * NUMERIC identifiers travel as strings on the wire but may appear as
 * numbers in some upstream representations.
 */
export type AnalysisNarrativeTargetKeys = Record<string, string | number>;

export interface AnalysisNarrativeRow {
  content_hash: string;
  target_kind: AnalysisNarrativeTargetKind;
  target_keys: Record<string, unknown>;
  narrative: string;
  prompt_version: string;
  model_version: string;
  generated_at: Date;
}

/**
 * Fetch the most recent `analysis_narrative` row matching `(targetKind,
 * targetKeys)`. Returns `null` when no row matches; the caller decides
 * whether to trigger LLM analysis or render "Analysis pending".
 *
 * ## Re-generation semantics — INSERT-only, no UPDATE
 *
 * `analysis_narrative` has `GRANT SELECT, INSERT, DELETE` for
 * `aimer_customer` — **no UPDATE grant** (deviates from #216's
 * original spec; codified in #221). A different `prompt_version` or
 * `model_version` changes `content_hash`, so re-generation always
 * produces a new row with a new primary key rather than mutating an
 * existing one.
 *
 * Two narratives for the same target (different `prompt_version` /
 * `model_version`) therefore coexist as separate rows. This helper
 * returns "the current narrative" by picking the most recent
 * `generated_at` across all `(prompt_version, model_version)` pairs.
 * Callers that need a specific pair should narrow down on the returned
 * row's `prompt_version` / `model_version` fields and re-query if
 * needed (a typed-version selector helper is out of scope for v1).
 *
 * ## content_hash composition (writer responsibility, documented here
 * for caller awareness)
 *
 * `content_hash` is computed at INSERT time by the LLM pipeline
 * (separate track) as a stable hash of `target_kind` + `target_keys` +
 * the target row's `summary_payload` (or equivalent) +
 * `prompt_version` + `model_version`. The exact composition is
 * aimer-web's choice per RFC 0002 §11.2. This read helper does **not**
 * recompute the hash — it queries by `(target_kind, target_keys)`
 * directly and surfaces the stored hash.
 *
 * ## v1 query plan
 *
 * Queries by JSONB equality on `target_keys` within `target_kind`.
 * `analysis_narrative_target_kind_generated_at_idx` (`(target_kind,
 * generated_at)`) narrows by `target_kind` and orders the result;
 * `target_keys` equality runs as a filter. No GIN index is defined on
 * `target_keys` in v1 per #216 ("reverse lookup by target_keys is not
 * supported in v1"); if traffic to this path grows, add `CREATE INDEX
 * CONCURRENTLY ... USING GIN (target_keys)` in a follow-up migration.
 *
 * @param customerPool - Per-customer DB pool
 * @param targetKind   - `baseline_event` | `story` | `policy_run`
 * @param targetKeys   - Shape determined by `targetKind` (see type doc)
 */
export async function lookupAnalysisNarrative(
  customerPool: Pool,
  targetKind: AnalysisNarrativeTargetKind,
  targetKeys: AnalysisNarrativeTargetKeys,
): Promise<AnalysisNarrativeRow | null> {
  const { rows } = await customerPool.query<AnalysisNarrativeRow>(
    `SELECT
       content_hash,
       target_kind,
       target_keys,
       narrative,
       prompt_version,
       model_version,
       generated_at
     FROM analysis_narrative
     WHERE target_kind = $1
       AND target_keys = $2::jsonb
     ORDER BY generated_at DESC
     LIMIT 1`,
    [targetKind, JSON.stringify(targetKeys)],
  );

  return rows[0] ?? null;
}
