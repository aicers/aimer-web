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
 * a future Phase 1 list page) by their internal `detection_events.id`.
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
