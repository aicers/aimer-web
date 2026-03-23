import { getAuthPool, query } from "../db/client";

export interface SessionPolicy {
  general: { idle_timeout_minutes: number; absolute_timeout_minutes: number };
  admin: { idle_timeout_minutes: number; absolute_timeout_minutes: number };
}

const DEFAULT_POLICY: SessionPolicy = {
  general: { idle_timeout_minutes: 30, absolute_timeout_minutes: 480 },
  admin: { idle_timeout_minutes: 15, absolute_timeout_minutes: 120 },
};

// Minimum floor enforcement — prevents dangerously short timeouts
const MIN_IDLE_MINUTES = 5;
const MIN_ABSOLUTE_MINUTES = 60;

function enforceFloor(ctx: {
  idle_timeout_minutes: number;
  absolute_timeout_minutes: number;
}) {
  return {
    idle_timeout_minutes: Math.max(ctx.idle_timeout_minutes, MIN_IDLE_MINUTES),
    absolute_timeout_minutes: Math.max(
      ctx.absolute_timeout_minutes,
      MIN_ABSOLUTE_MINUTES,
    ),
  };
}

function applyFloors(policy: SessionPolicy): SessionPolicy {
  return {
    general: enforceFloor(policy.general),
    admin: enforceFloor(policy.admin),
  };
}

let cached: { policy: SessionPolicy; expiresAt: number } | null = null;
const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

export async function getSessionPolicy(): Promise<SessionPolicy> {
  if (cached && Date.now() < cached.expiresAt) {
    return cached.policy;
  }

  try {
    const rows = await query<{ value: SessionPolicy }>(
      getAuthPool(),
      `SELECT value FROM system_settings WHERE key = 'session_policy'`,
    );
    const raw = rows.length > 0 ? rows[0].value : DEFAULT_POLICY;
    const policy = applyFloors(raw);
    cached = { policy, expiresAt: Date.now() + CACHE_TTL_MS };
    return policy;
  } catch {
    // If DB is unavailable, fall back to defaults (already above floors)
    return DEFAULT_POLICY;
  }
}

/** Clear the cached session policy (useful for tests). */
export function clearSessionPolicyCache(): void {
  cached = null;
}
