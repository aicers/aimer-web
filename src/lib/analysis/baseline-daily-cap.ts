// Per-customer baseline auto-analysis daily cap resolution (#493).
//
// The tier-B (budget-gated) cap on individual baseline-event auto-analysis
// resolves through the same three-tier order as the default model (#473):
//
//   1. per-customer override  — `customer_baseline_analysis_cap` row
//   2. admin-set global       — `system_settings.baseline_auto_analysis_daily_cap`
//   3. env fallback           — `BASELINE_AUTO_ANALYSIS_DAILY_CAP`
//
// The cap is a non-negative integer count of tier-B baseline events admitted
// per customer-tz calendar day. `0` disables tier B entirely (tier A is
// uncapped regardless). Mirrors `resolveDefaultModel` in `default-model.ts`
// — defensive at every DB tier: a missing / malformed stored value is
// logged and skipped, never thrown, so resolution always returns a number.
//
// SERVER-ONLY. Reads the auth DB.

import "server-only";

import type { Pool, PoolClient } from "pg";
import { getAuthPool } from "../db/client";

/** `system_settings` key holding the admin-set global cap. */
export const GLOBAL_BASELINE_CAP_KEY = "baseline_auto_analysis_daily_cap";

const DEFAULT_ENV_CAP = 0;

/**
 * The env-level fallback cap — the ultimate (third-tier) default. Defaults
 * to `0` (tier B disabled) when `BASELINE_AUTO_ANALYSIS_DAILY_CAP` is unset
 * or invalid, so an unconfigured deployment never auto-spends on tier B.
 */
export function getEnvBaselineDailyCap(): number {
  return (
    coerceCap(process.env.BASELINE_AUTO_ANALYSIS_DAILY_CAP) ?? DEFAULT_ENV_CAP
  );
}

// A Pool or a checked-out PoolClient — both expose `.query`.
type Queryable = Pool | PoolClient;

function logResolverEvent(
  event: string,
  customerId: string,
  detail: Record<string, unknown>,
): void {
  console.warn(
    JSON.stringify({
      level: "warn",
      event: `analysis.baseline_daily_cap.${event}`,
      customer_id: customerId,
      ...detail,
    }),
  );
}

/**
 * Coerce an arbitrary stored value into a non-negative integer cap, or
 * `null` if it is not a well-formed one. Accepts a bare number, a numeric
 * string, or a `{ dailyCap }` / `{ daily_cap }` object (the shape the
 * admin settings surface may persist into the `system_settings` JSONB).
 */
function coerceCap(value: unknown): number | null {
  let n: unknown = value;
  if (value !== null && typeof value === "object" && !Array.isArray(value)) {
    const obj = value as Record<string, unknown>;
    n = obj.dailyCap ?? obj.daily_cap;
  }
  if (typeof n === "string") {
    if (n.trim().length === 0) return null;
    n = Number(n);
  }
  if (typeof n !== "number" || !Number.isFinite(n)) return null;
  if (!Number.isInteger(n) || n < 0) return null;
  return n;
}

/**
 * Resolve the tier-B daily cap for `customerId` per the three-tier order
 * (customer override → admin global → env). Defensive at every DB tier: a
 * missing, malformed, or negative stored value is logged and skipped, never
 * thrown. Always returns a non-negative integer — the env default is the
 * guaranteed floor.
 *
 * @param db optional Pool/PoolClient to run on (defaults to the auth pool).
 *   Pass a transaction client to share its connection.
 */
export async function resolveBaselineDailyCap(
  customerId: string,
  db: Queryable = getAuthPool(),
): Promise<number> {
  // Tier 1: per-customer override.
  try {
    const res = await db.query<{ daily_cap: number }>(
      `SELECT daily_cap
         FROM customer_baseline_analysis_cap
        WHERE customer_id = $1`,
      [customerId],
    );
    if (res.rows.length > 0) {
      const cap = coerceCap(res.rows[0].daily_cap);
      if (cap !== null) return cap;
      logResolverEvent("stale_customer_override", customerId, {
        stored: res.rows[0].daily_cap,
        action: "fell back to global/env",
      });
    }
  } catch (err) {
    logResolverEvent("customer_lookup_failed", customerId, {
      error: err instanceof Error ? err.message : String(err),
    });
  }

  // Tier 2: admin-set global default.
  try {
    const res = await db.query<{ value: unknown }>(
      `SELECT value FROM system_settings WHERE key = $1`,
      [GLOBAL_BASELINE_CAP_KEY],
    );
    if (res.rows.length > 0) {
      const cap = coerceCap(res.rows[0].value);
      if (cap !== null) return cap;
      logResolverEvent("stale_global_default", customerId, {
        stored: res.rows[0].value,
        action: "fell back to env",
      });
    }
  } catch (err) {
    logResolverEvent("global_lookup_failed", customerId, {
      error: err instanceof Error ? err.message : String(err),
    });
  }

  // Tier 3: env fallback (trusted base).
  return getEnvBaselineDailyCap();
}
