// RFC 0002 Phase 2 (#297) — baseline drift formulas.
//
// A periodic report carries two baseline-drift signals derived purely
// from the statistical shift in `baseline_event` category counts between
// the report window and the previous period (RFC 0002 §"For periodic
// reports"). No LLM call and no per-event PII is involved — only counts.
//
//   - `baseline_drift_severity`: min-max-normalized magnitude of the
//     largest category-count delta vs the prior period, clamped `[0, 1]`.
//   - `baseline_drift_likelihood`: `1.0` if any per-category fractional
//     delta exceeds `ANALYSIS_BASELINE_DRIFT_NOISE_THRESHOLD`, else
//     `0.0`. Statistical drift, once it clears noise, is treated as a
//     high-confidence signal — the data does not lie about its own
//     distribution.
//
// First-bucket bootstrap: when the previous period has no events, both
// signals are `0.0` (there is no prior distribution to drift from).
//
// The signals map onto the priority matrix via
// `matrix(baseline_drift_severity, baseline_drift_likelihood)` and into
// the informational `aggregate_*_score` max-per-axis (RFC 0002
// §"Priority tiering"). The exact normalizer lives here, alongside the
// worker, so the formula is revisable in one place.

const DEFAULT_NOISE_THRESHOLD = 0.3;

function resolveFloat(raw: string | undefined, fallback: number): number {
  if (!raw) return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

// Fractional delta vs the prior period that counts as material drift
// rather than noise. Default 0.3 (a 30% swing in any category).
export const BASELINE_DRIFT_NOISE_THRESHOLD = resolveFloat(
  process.env.ANALYSIS_BASELINE_DRIFT_NOISE_THRESHOLD,
  DEFAULT_NOISE_THRESHOLD,
);

export interface CategoryCount {
  /** `baseline_event.category`; `null` is the no-category bucket. */
  category: string | null;
  count: number;
}

export interface CategoryDelta {
  category: string | null;
  /**
   * Signed fractional change vs the prior period:
   * `(current - prior) / max(prior, 1)`. The `max(prior, 1)` floor keeps
   * the value finite for an emerging category (prior `0`) while staying
   * monotone in the emergence magnitude.
   */
  delta: number;
}

export interface BaselineDrift {
  severity: number;
  likelihood: number;
  /** Per-category fractional deltas, for the prompt's baseline section. */
  categoryDeltas: CategoryDelta[];
}

/**
 * Deterministic category ordering shared by `categoryDeltas` and the
 * `categoryDistribution` array: a `null` (no-category) bucket sorts last,
 * then by category name ascending. Both arrays are order-sensitive in the
 * canonical `input_hash`, so they must use one comparator.
 */
export function compareCategoryNullLast(
  a: string | null,
  b: string | null,
): number {
  if (a === null) return b === null ? 0 : 1;
  if (b === null) return -1;
  return a < b ? -1 : a > b ? 1 : 0;
}

function toMap(
  counts: ReadonlyArray<CategoryCount>,
): Map<string | null, number> {
  const m = new Map<string | null, number>();
  for (const c of counts) {
    m.set(c.category, (m.get(c.category) ?? 0) + c.count);
  }
  return m;
}

function sum(map: Map<string | null, number>): number {
  let total = 0;
  for (const v of map.values()) total += v;
  return total;
}

/**
 * Compute the two baseline-drift signals + per-category deltas from the
 * current-window and previous-period category distributions. Pure /
 * synchronous; the noise threshold is read once at module init from
 * `ANALYSIS_BASELINE_DRIFT_NOISE_THRESHOLD`.
 */
export function computeBaselineDrift(
  current: ReadonlyArray<CategoryCount>,
  previous: ReadonlyArray<CategoryCount>,
): BaselineDrift {
  const cur = toMap(current);
  const prev = toMap(previous);
  const priorTotal = sum(prev);

  // The union of category keys present in either period.
  const categories = new Set<string | null>([...cur.keys(), ...prev.keys()]);

  const categoryDeltas: CategoryDelta[] = [];
  let maxAbsCountDelta = 0;
  let anyExceedsNoise = false;
  for (const category of categories) {
    const c = cur.get(category) ?? 0;
    const p = prev.get(category) ?? 0;
    const absCountDelta = Math.abs(c - p);
    if (absCountDelta > maxAbsCountDelta) maxAbsCountDelta = absCountDelta;
    const fractional = (c - p) / Math.max(p, 1);
    categoryDeltas.push({ category, delta: fractional });
    if (Math.abs(fractional) > BASELINE_DRIFT_NOISE_THRESHOLD) {
      anyExceedsNoise = true;
    }
  }
  // Deterministic ordering for hash stability + display: nulls last,
  // then by category name.
  categoryDeltas.sort((a, b) =>
    compareCategoryNullLast(a.category, b.category),
  );

  // First-bucket bootstrap: no prior distribution ⇒ no drift signal.
  if (priorTotal === 0) {
    return { severity: 0, likelihood: 0, categoryDeltas };
  }

  // Severity: largest absolute category-count delta, normalized by the
  // prior period's total volume and clamped to [0, 1]. A category that
  // doubled relative to the period scale registers proportionally; a
  // wholesale category replacement saturates at 1.0.
  const severity = Math.min(1, Math.max(0, maxAbsCountDelta / priorTotal));
  const likelihood = anyExceedsNoise ? 1.0 : 0.0;
  return { severity, likelihood, categoryDeltas };
}
