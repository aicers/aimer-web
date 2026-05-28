// Priority tier matrix lookup and comparator per RFC 0002 §"Priority tiering".
//
// Inputs are the LLM-returned severity and likelihood scores, each on
// [0.0, 1.0]. The 4x4 matrix maps every (severity_bucket, likelihood_bucket)
// pair onto one of four tiers, and `tierRank`/`maxTier` give a semantic
// (not lexicographic) ordering so aggregation never falls back to SQL
// `MAX(priority_tier)` on the TEXT column — that would yield
// `CRITICAL < HIGH < LOW < MEDIUM`, the opposite of intent.
//
// Phase 0 (#294) reuses this module for `story_analysis_result` and for
// periodic-report aggregation, so the helper lives here rather than inline
// in the event-analysis write path.

export type PriorityTier = "CRITICAL" | "HIGH" | "MEDIUM" | "LOW";

// RFC 0002 §"Priority tiering" defaults. Env-var wiring (#294) can override
// these later; admin tuning UI is a Phase 4 item.
const SEVERITY_THRESHOLDS = [0.4, 0.6, 0.8] as const;
const LIKELIHOOD_THRESHOLDS = [0.4, 0.6, 0.8] as const;

// Rows: severity bucket (0=lowest, 3=highest). Cols: likelihood bucket.
const MATRIX: readonly (readonly PriorityTier[])[] = [
  ["LOW", "LOW", "LOW", "LOW"],
  ["LOW", "LOW", "MEDIUM", "MEDIUM"],
  ["LOW", "MEDIUM", "HIGH", "HIGH"],
  ["MEDIUM", "HIGH", "CRITICAL", "CRITICAL"],
];

function bucket(value: number, thresholds: readonly number[]): number {
  let index = 0;
  for (const threshold of thresholds) {
    if (value >= threshold) {
      index += 1;
    } else {
      break;
    }
  }
  return index;
}

export function computePriorityTier(
  severityScore: number,
  likelihoodScore: number,
): PriorityTier {
  const s = bucket(severityScore, SEVERITY_THRESHOLDS);
  const l = bucket(likelihoodScore, LIKELIHOOD_THRESHOLDS);
  return MATRIX[s][l];
}

// RFC 0002 Phase 1 (#296, #330) — likelihood-floor signals applied at
// the matrix-lookup site (NOT persisted; the on-disk `likelihood_score`
// always holds the raw LLM value so calibration data and the floor
// policy stay revisable without rewriting history).
//
// Signal sources are locked at the caller (story-worker):
//   - `memberCount` = COUNT(*) over `story_member` rows for the
//      canonical (story_id, story_version). The `story` schema has no
//      precomputed count column.
//   - `knownIocHit` = `story.known_ioc_hit` for the canonical story
//      version, populated at ingest time from the Phase 2 payload.
export interface LikelihoodSignals {
  knownIocHit: boolean;
  memberCount: number;
}

function resolveFloorInt(raw: string | undefined, fallback: number): number {
  if (!raw) return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}

const MEMBER_COUNT_FLOOR_N = resolveFloorInt(
  process.env.ANALYSIS_LIKELIHOOD_MEMBER_COUNT_FLOOR_N,
  5,
);

const FLOOR_KNOWN_IOC = 0.95;
const FLOOR_MEMBER_COUNT = 0.7;

/**
 * Apply RFC 0002 §"Priority tiering — likelihood floors" to the raw
 * LLM likelihood before it feeds `computePriorityTier`. Never lowers
 * the score; only raises it to the configured floor when a signal is
 * present. Multiple signals stack via `max` semantics, not addition.
 */
export function applyLikelihoodFloors(
  rawLikelihood: number,
  signals: LikelihoodSignals,
): number {
  let floored = rawLikelihood;
  if (signals.knownIocHit && floored < FLOOR_KNOWN_IOC) {
    floored = FLOOR_KNOWN_IOC;
  }
  if (
    signals.memberCount >= MEMBER_COUNT_FLOOR_N &&
    floored < FLOOR_MEMBER_COUNT
  ) {
    floored = FLOOR_MEMBER_COUNT;
  }
  return floored;
}

const TIER_RANK: Record<PriorityTier, number> = {
  LOW: 0,
  MEDIUM: 1,
  HIGH: 2,
  CRITICAL: 3,
};

export function tierRank(tier: PriorityTier): number {
  return TIER_RANK[tier];
}

export function maxTier(...tiers: PriorityTier[]): PriorityTier {
  if (tiers.length === 0) {
    throw new Error("maxTier requires at least one tier");
  }
  let best = tiers[0];
  for (const tier of tiers) {
    if (TIER_RANK[tier] > TIER_RANK[best]) {
      best = tier;
    }
  }
  return best;
}
