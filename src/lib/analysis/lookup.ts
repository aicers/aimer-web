import type { Pool } from "pg";

/**
 * Row returned for a `baseline_event` row found by `event_key`.
 *
 * Typing rules (per RFC 0002 §8 / issue #220):
 * - `event_key` is `string`: the column is `NUMERIC(39, 0)`, which overflows
 *   JS `number` and which `pg` returns as a string by default.
 * - `event_time` / `received_at` are `Date`: `pg` parses `TIMESTAMPTZ` to
 *   `Date`; the helper does not stringify.
 * - JSONB columns are typed `Record<string, unknown>` (or nullable for
 *   `asset_context`) because `pg` already JSON-parses the value. The Phase 2
 *   ingest schema (#216) only stores objects, so the narrower typing is safe
 *   in practice even though JSONB in general may hold scalars.
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

/**
 * Discriminated result of an analysis lookup by `event_key`.
 *
 * The union (rather than `BaselineEventRow | null`) is intentional: it leaves
 * room for a future `"phase1"` variant without an API break. After the #250
 * schema refactor `detection_events.event_key` is already a plaintext
 * `NUMERIC(39, 0)` column, so promoting Phase 1 to a first-class analysis
 * source is a code change in `lookupAnalysisForEvent` (and a new variant
 * here), not a schema change. See the v1 limitation note on
 * {@link lookupAnalysisForEvent}.
 */
export type AnalysisLookupResult =
  | { source: "phase2"; row: BaselineEventRow }
  | { source: "none" };

/**
 * Resolve `event_key` to a Phase 2 baseline analysis row.
 *
 * **Customer scoping (caller contract).** `customerPool` MUST already be a
 * `Pool` scoped to the target customer's per-customer DB. The customer scope
 * IS the DB — this helper never sees `external_key` / `customer_id` and
 * never inspects them. RFC 0002 §8 describes the lookup key as
 * `(external_key, event_key)`; the `external_key` half is implied by the
 * caller's choice of pool. Phase 2 routes resolve the pool via
 * `src/lib/db/customer-runtime-pool.ts`; consumers of this helper
 * should do the same.
 *
 * **Input trust.** The helper passes `eventKey` through as `$1::numeric` and
 * relies on the PostgreSQL cast for shape rejection. Callers at the system
 * boundary (HTTP routes, future analysis UI) are responsible for
 * Zod-style validation (1–39 digits, non-negative) — mirroring
 * `eventKeyString` in `src/lib/event-key.ts`. This helper is
 * internal and trusts its input.
 *
 * **Resolution.**
 * 1. Look for any `baseline_event` row matching `event_key` across every
 *    `baseline_version`. The same event may be re-sent under a bumped
 *    version if it survives a rebaseline.
 * 2. Return the row with the most recent `received_at` — the canonical
 *    "current view of this event" for analysis. Ties on `received_at` are
 *    broken by `baseline_version DESC` (textual) so the result is
 *    deterministic.
 * 3. No match → `{ source: "none" }`.
 *
 * **v1 limitation — helper is Phase 2-only by design.** Phase 1
 * `detection_events` rows are NOT considered, even though after the #250
 * schema refactor they carry `event_key` as a plaintext `NUMERIC(39, 0)`
 * column and would be cheap to query. The Phase 2 row remains the
 * canonical analysis row by design (RFC 0002 §8); Phase 1 rows are reached
 * only through Phase 1-native surfaces (the Detection bridge audit log, or
 * a future Phase 1 list page) by their internal `detection_events.id`. If
 * #254 (or a later RFC) wants to promote Phase 1 to a first-class analysis
 * source, the path is to add a `"phase1"` variant to the union below — no
 * schema change is needed. The `AnalysisLookupResult` union is shaped to
 * admit that variant without an API break.
 *
 * **Operational meaning of `{ source: "none" }`.** Consumers (the future
 * analysis UI) MUST treat `none` as ambiguous between two cases that v1
 * cannot distinguish:
 *   1. The event was never sent to aimer-web at all.
 *   2. The event was sent via Phase 1 (Detection menu ad-hoc send) but not
 *      via Phase 2 baseline push — the `detection_events` row exists but is
 *      not reachable by `event_key` in v1 (the limitation above).
 * Recommended UI copy: "No baseline analysis available for this event"
 * rather than "Event not found." The first phrasing is true in both cases;
 * the second is misleading in case (2). The plaintext `event_key` column
 * is now present on `detection_events` (#250), so the UI can distinguish
 * cases (1) and (2) once #254 adds a Phase 1 lookup path here.
 */
export async function lookupAnalysisForEvent(
  customerPool: Pool,
  eventKey: string,
): Promise<AnalysisLookupResult> {
  const { rows } = await customerPool.query(
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
     ORDER BY received_at DESC, baseline_version DESC
     LIMIT 1`,
    [eventKey],
  );
  if (rows.length === 0) return { source: "none" };
  return { source: "phase2", row: rows[0] as BaselineEventRow };
}

/**
 * Row returned by {@link lookupAnalysisNarrative}.
 *
 * `target_keys` is typed `Record<string, unknown>` (not `Record<string,
 * string>`) on the read side intentionally: the writer's payload may evolve,
 * and a stricter return type would force callers into unsafe casts. The
 * *input* `targetKeys` parameter on {@link lookupAnalysisNarrative} IS
 * `Record<string, string>` because JSONB equality is value-type-sensitive
 * (`{"story_id": 1}` ≠ `{"story_id": "1"}`) and the aice-web-next wire
 * convention serializes BIGINT/NUMERIC ids as stringified digits. The
 * asymmetry is by design.
 */
export interface AnalysisNarrativeRow {
  content_hash: string;
  target_kind: "baseline_event" | "story" | "policy_run";
  target_keys: Record<string, unknown>;
  narrative: string;
  prompt_version: string;
  model_version: string;
  generated_at: Date;
}

/**
 * Resolve `(target_kind, target_keys)` to the most recent
 * `analysis_narrative` row, or `null`.
 *
 * **`targetKeys` value-type convention (string only).** All values in
 * `targetKeys` MUST be strings. PostgreSQL JSONB equality is
 * value-type-sensitive — `{"story_id": 1}` and `{"story_id": "1"}` do NOT
 * match — and the aice-web-next wire convention sends BIGINT/NUMERIC
 * identifiers as stringified digits (`eventKeyString` /
 * `stringifiedBigintPositive` in `_shared/schemas.ts`). The writer (the
 * LLM pipeline, separate track) MUST serialize `target_keys` using the same
 * string-only convention so JSONB equality matches at read time. The
 * `Record<string, string>` parameter type makes this contract unforgeable.
 *
 * Expected shape per kind:
 *   - `baseline_event`: `{ baseline_version, event_key }`
 *   - `story`:          `{ story_id, story_version }`
 *   - `policy_run`:     `{ run_id }`
 *
 * **Re-generation semantics — INSERT-only, no UPDATE.** The
 * `analysis_narrative` table is granted `SELECT, INSERT, DELETE` for
 * `aimer_customer` — no UPDATE. A different `prompt_version` or
 * `model_version` produces a different `content_hash`, so re-generation is
 * always a fresh INSERT, never an in-place mutation. Two narratives for the
 * same target (different `(prompt_version, model_version)` pairs) coexist
 * as separate rows. This helper picks the row with the most recent
 * `generated_at` across all such pairs — the "current narrative" for the
 * target. A caller needing a specific `(prompt_version, model_version)`
 * pair must narrow on the returned row's fields and re-query; a typed
 * version selector is out of scope for v1.
 *
 * **Query plan and the v1 no-GIN decision.** The existing
 * `(target_kind, generated_at)` btree index narrows by kind and supplies
 * the `generated_at` order; the `target_keys` equality runs as a residual
 * filter. Per-kind cardinality is bounded by retention. If observed p95
 * latency on this helper exceeds 50 ms in production, the escalation path
 * is `CREATE INDEX CONCURRENTLY analysis_narrative_target_keys_idx ON
 * analysis_narrative USING GIN (target_keys)` in a follow-up migration. Do
 * not pre-emptively add the index.
 *
 * **`content_hash` is not this helper's concern.** `content_hash` is
 * computed by the writer (RFC 0002 §11.2) at INSERT time. This helper
 * queries by `(target_kind, target_keys)` directly and surfaces the stored
 * hash on the returned row.
 *
 * **Customer scoping.** Same caller contract as
 * {@link lookupAnalysisForEvent}: `customerPool` is already scoped to the
 * target customer's DB; the helper does not inspect `external_key` or
 * `customer_id`.
 */
export async function lookupAnalysisNarrative(
  customerPool: Pool,
  targetKind: "baseline_event" | "story" | "policy_run",
  targetKeys: Record<string, string>,
): Promise<AnalysisNarrativeRow | null> {
  const { rows } = await customerPool.query(
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
  if (rows.length === 0) return null;
  return rows[0] as AnalysisNarrativeRow;
}
