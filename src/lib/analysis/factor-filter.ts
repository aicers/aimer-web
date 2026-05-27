// Score-factor shape filter per RFC 0002 §"Score factor articulation".
//
// The LLM returns up to several short noun phrases per axis articulating
// the severity / likelihood scores. The phrases are persisted verbatim
// after passing a shape filter: drop empty / overlong / sentence-start
// items, cap the survivors at 5, and substitute the sentinel
// `["insufficient evidence"]` when nothing survives.
//
// Phase 1 (`story_analysis_result`, #296) reuses this filter for its
// `severity_factors` / `likelihood_factors` columns, so the helper lives
// here rather than inline in the event-analysis write path. Sibling to
// `priority-tier.ts`.

export type FactorAxis = "severity" | "likelihood";
export type FactorDropReason = "empty" | "oversized" | "sentence_start";

export interface FilterFactorsResult {
  /** Always at least one item; the sentinel fires when recovery is needed. */
  kept: string[];
  /**
   * Items rejected by the shape filter (empty / oversized / sentence-start).
   * Cap-truncated items are NOT included here — those land in `truncated`.
   */
  dropped: Array<{ item: string; reason: FactorDropReason }>;
  /**
   * Items removed by the > 5 cap (RFC 0002:725's "soft trim"). Returned for
   * debugging / metrics only; the cap is intentionally non-audited per the
   * RFC's `reason` enumeration (which has no cap value).
   */
  truncated: string[];
  /** True iff `kept === ['insufficient evidence']` after recovery. */
  usedSentinel: boolean;
}

const MAX_LENGTH = 80;
const MAX_COUNT = 5;
const SENTENCE_START_PREFIXES = ["The ", "This "] as const;
const SENTINEL: readonly string[] = ["insufficient evidence"];

/**
 * Apply the RFC 0002 §"Score factor articulation" shape filter to a raw
 * LLM-returned factor list. The `axis` parameter is accepted for symmetry
 * with the caller's audit payload (which carries `axis`); the filter
 * itself does not differ between axes.
 *
 * Filter pipeline (in order):
 *   1. Drop empty (`item.trim() === ''`) or `> 80` characters.
 *   2. Drop items beginning with `"The "` or `"This "`.
 *   3. Cap survivors at 5; overflow → `truncated`, not `dropped`.
 *   4. If `kept` is empty after steps 1-3, replace with the sentinel
 *      `['insufficient evidence']` and set `usedSentinel = true`.
 */
export function filterFactors(
  raw: readonly string[],
  _axis: FactorAxis,
): FilterFactorsResult {
  const dropped: Array<{ item: string; reason: FactorDropReason }> = [];
  const survivors: string[] = [];

  for (const item of raw) {
    if (item.trim() === "") {
      dropped.push({ item, reason: "empty" });
      continue;
    }
    if (item.length > MAX_LENGTH) {
      dropped.push({ item, reason: "oversized" });
      continue;
    }
    if (SENTENCE_START_PREFIXES.some((prefix) => item.startsWith(prefix))) {
      dropped.push({ item, reason: "sentence_start" });
      continue;
    }
    survivors.push(item);
  }

  const kept = survivors.slice(0, MAX_COUNT);
  const truncated = survivors.slice(MAX_COUNT);

  if (kept.length === 0) {
    return {
      kept: [...SENTINEL],
      dropped,
      truncated,
      usedSentinel: true,
    };
  }
  return { kept, dropped, truncated, usedSentinel: false };
}
