import "server-only";

import { LATEST_BASELINE_CTE } from "@/lib/analysis/baseline-dedup";
import { getCustomerRuntimePool } from "@/lib/db/customer-runtime-pool";

// ---------------------------------------------------------------------------
// Group creation-time cost preview figures (#511, RFC 0004 "Cost guard").
//
// The recurring token cost a group incurs scales with member count: each
// generation run cross-reads every member DB and combines their events into
// one LLM input (Option B). This module computes the informational figures
// the preview endpoint returns; the calculation method and its coefficients
// NEVER cross the API boundary — only the resulting figures do.
// ---------------------------------------------------------------------------

/**
 * The recurring generation cadence — four periods, each recurring. Always
 * present in the preview (unlike the computed figures it does not depend on
 * cross-DB reads). Order is LIVE-first (freshest), matching `ALL_PERIODS`.
 */
export const GENERATION_CADENCE = [
  "LIVE",
  "DAILY",
  "WEEKLY",
  "MONTHLY",
] as const;

// Trailing window (days) over which report-feeding events are counted. A
// fixed 30-day window, NOT the period buckets.
const RECENT_EVENT_WINDOW_DAYS = 30;

// Coarse server-side cost model. Deliberately rough (RFC 0004: the monthly
// figure is an explicit "rough estimate"); precision is a non-goal. Folds the
// recurring cadence (LIVE/DAILY/WEEKLY/MONTHLY re-reads over a month) into the
// per-event and per-member coefficients so the estimate stays a single
// server-side constant. These values must never be surfaced.
const COST_MODEL = {
  // Cumulative LLM input tokens one report-feeding event contributes across a
  // month of recurring generation (re-read by the four cadence periods).
  tokensPerEventPerMonth: 12,
  // Per-member, per-month prompt scaffolding + cross-DB read overhead tokens,
  // independent of event volume.
  tokensPerMemberPerMonth: 20_000,
  // Blended USD per 1K tokens (input + output).
  usdPer1kTokens: 0.01,
} as const;

/**
 * Combined recent report-feeding event volume: the sum, over all members, of
 * each member's deduped `baseline_event` count (canonical `LATEST_BASELINE_CTE`
 * dedup) by `event_time` over a trailing 30-day window, read from each
 * member's runtime customer DB pool (Option B cross-read).
 */
export async function computeCombinedRecentEventVolume(
  memberIds: string[],
): Promise<number> {
  const counts = await Promise.all(memberIds.map((id) => recentEventCount(id)));
  return counts.reduce((sum, n) => sum + n, 0);
}

async function recentEventCount(customerId: string): Promise<number> {
  const pool = getCustomerRuntimePool(customerId);
  const { rows } = await pool.query<{ count: number }>(
    `${LATEST_BASELINE_CTE}
     SELECT COUNT(*)::int AS count
       FROM latest_baseline lb
      WHERE lb.event_time >= NOW() - ($1 || ' days')::interval`,
    [String(RECENT_EVENT_WINDOW_DAYS)],
  );
  return rows[0]?.count ?? 0;
}

export interface MonthlyCostEstimate {
  estimatedMonthlyTokens: number;
  estimatedMonthlyCostUsd: number;
}

/**
 * Derive the rough monthly token / USD-cost estimate from member count,
 * combined recent event volume, and the (cadence-folded) cost model. Coarse
 * by design.
 */
export function estimateMonthlyCost(
  memberCount: number,
  combinedRecentEventVolume: number,
): MonthlyCostEstimate {
  const estimatedMonthlyTokens = Math.round(
    combinedRecentEventVolume * COST_MODEL.tokensPerEventPerMonth +
      memberCount * COST_MODEL.tokensPerMemberPerMonth,
  );
  const estimatedMonthlyCostUsd =
    Math.round(
      (estimatedMonthlyTokens / 1000) * COST_MODEL.usdPer1kTokens * 100,
    ) / 100;
  return { estimatedMonthlyTokens, estimatedMonthlyCostUsd };
}
