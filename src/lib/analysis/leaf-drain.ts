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
  /**
   * Recent-window size (days) on the baseline_event event-time basis. `null`
   * means the scope is unbounded (all history) — the story side allows this;
   * the event side always pins a concrete day count.
   */
  windowDays: number | null;
  /** Resolved window start (ISO), or `null` for an unbounded window. */
  windowStart: string | null;
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

/**
 * The minimal shape of #466's story-side `DrainSignal` that
 * `storyDrainToLeafStatus` maps from. Declared structurally (NOT imported
 * from the server-only `story-backfill` module) so this pure module stays
 * dependency-free and importable by #469's gate and by tests.
 */
export interface StoryDrainLike {
  scope: {
    customerId: string;
    modelName: string;
    model: string;
    windowDays: number | null;
  };
  /** In-scope leaves excluding `source_unavailable` (the gate denominator). */
  totalLeaves: number;
  /** Leaves not yet re-analyzed under the target model (gate numerator). */
  outstanding: number;
  drained: boolean;
  counts: { source_unavailable?: number };
}

/**
 * Adapt #466's story-side `DrainSignal` to the shared `LeafDrainStatus` so
 * #469 can gate on the story- AND event-leaf signals through ONE shape
 * (#470 Scope §6). Without this, the story status route emits its own
 * `DrainSignal` shape (no `kind` / `universe` / `sourceUnavailable`, a
 * scope without `lang` or concrete window bounds) and #469 cannot query
 * both signals uniformly.
 *
 * The story side fixes `lang` to its single worker language and reports its
 * window as a day count, so the caller passes the resolved `lang` and the
 * concrete window bounds it computed for the scope. `universe` is the full
 * in-scope leaf set including the swept ones (`totalLeaves` +
 * `source_unavailable`), matching the event side's `universe`.
 */
export function storyDrainToLeafStatus(
  signal: StoryDrainLike,
  resolved: { lang: string; windowStart: string | null; windowEnd: string },
): LeafDrainStatus {
  const sourceUnavailable = signal.counts.source_unavailable ?? 0;
  return {
    kind: "story",
    scope: {
      customerId: signal.scope.customerId,
      lang: resolved.lang,
      modelName: signal.scope.modelName,
      model: signal.scope.model,
      windowDays: signal.scope.windowDays,
      windowStart: resolved.windowStart,
      windowEnd: resolved.windowEnd,
    },
    universe: signal.totalLeaves + sourceUnavailable,
    outstanding: signal.outstanding,
    sourceUnavailable,
    drained: signal.drained,
  };
}
