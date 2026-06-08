// Shared leaf-backfill drain-completion signal shape (#466 / #470 / #469).
//
// Both leaf backfills — #466 (story leaves) and #470 (event leaves) —
// expose a scope-addressable drain-completion signal that #469 gates its
// report-variant refresh on. #469 refuses/defers refreshing a report
// variant whose story- OR event-leaf scope is not drained, so the two
// signals MUST share one shape and #469 can gate on both uniformly
// (#470 Scope §6). This module defines that common shape; the story and
// event sides each compute a `LeafDrainStatus` for their leaf kind.
//
// The signal is computed from the analysis-result tables themselves (not
// from any backfill run/item bookkeeping), on the report-builder
// event-time basis, so it stays correct across multiple runs:
//
//   - An event/story is OUTSTANDING when no non-superseded leaf exists for
//     the target `(lang, model_name, model)` variant — covering both work
//     candidates not yet re-analyzed AND failed re-analyses.
//   - `source_unavailable` leaves (redacted source retention-swept) are
//     EXCLUDED from outstanding: they can never be re-analyzed, so they
//     must not block #469's refresh forever.
//   - `drained` is `outstanding === 0`.
//
// Pure types only — no server-only dependency, so #469's gate and tests
// can import the shape freely.

/** Which leaf kind a drain status describes. */
export type LeafKind = "story" | "event";

/** The addressable scope a drain status answers for. */
export interface LeafDrainScope {
  customerId: string;
  lang: string;
  modelName: string;
  model: string;
  /** Recent-window size (days) on the baseline_event event-time basis. */
  windowDays: number;
  /** Resolved window bounds (ISO) the status was computed over. */
  windowStart: string;
  windowEnd: string;
}

/** Scope-addressable drain-completion status, common to story and event. */
export interface LeafDrainStatus {
  kind: LeafKind;
  scope: LeafDrainScope;
  /** Scoped existing leaf universe size for the scope. */
  universe: number;
  /**
   * Outstanding leaves: no non-superseded target-variant leaf present
   * (not-yet-run OR failed), `source_unavailable` excluded.
   */
  outstanding: number;
  /** Leaves excluded from `outstanding` because the source was swept. */
  sourceUnavailable: number;
  /** `true` when `outstanding === 0` — the scope is fully drained. */
  drained: boolean;
}
