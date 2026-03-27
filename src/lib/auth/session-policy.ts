import type { PoolClient } from "pg";
import { getAuthPool, query } from "../db/client";
import { assertAuthorized } from "./authorization";
import { HttpError } from "./errors";

export interface SessionPolicyContext {
  idle_timeout_minutes: number;
  absolute_timeout_minutes: number;
}

export interface SessionPolicy {
  general: SessionPolicyContext;
  admin: SessionPolicyContext;
}

export const DEFAULT_POLICY: SessionPolicy = {
  general: { idle_timeout_minutes: 30, absolute_timeout_minutes: 480 },
  admin: { idle_timeout_minutes: 15, absolute_timeout_minutes: 120 },
};

// Minimum floor enforcement — prevents dangerously short timeouts
export const MIN_IDLE_MINUTES = 5;
export const MIN_ABSOLUTE_MINUTES = 60;

function enforceFloor(ctx: SessionPolicyContext): SessionPolicyContext {
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

// ---------------------------------------------------------------------------
// readSessionPolicy — returns current policy from DB (or defaults)
// ---------------------------------------------------------------------------

export async function readSessionPolicy(
  client: PoolClient,
  accountId: string,
): Promise<SessionPolicy> {
  await assertAuthorized(client, "admin", accountId, "system-settings:read");

  const rows = await client.query<{ value: SessionPolicy }>(
    `SELECT value FROM system_settings WHERE key = 'session_policy'`,
  );
  return rows.rows.length > 0 ? rows.rows[0].value : DEFAULT_POLICY;
}

// ---------------------------------------------------------------------------
// updateSessionPolicy — validates floors and persists to DB
// ---------------------------------------------------------------------------

function validateContext(label: string, ctx: unknown): SessionPolicyContext {
  if (typeof ctx !== "object" || ctx === null || Array.isArray(ctx)) {
    throw new HttpError(`${label} must be an object`, 400);
  }

  const { idle_timeout_minutes, absolute_timeout_minutes } = ctx as Record<
    string,
    unknown
  >;

  if (
    typeof idle_timeout_minutes !== "number" ||
    !Number.isFinite(idle_timeout_minutes) ||
    idle_timeout_minutes !== Math.floor(idle_timeout_minutes)
  ) {
    throw new HttpError(
      `${label}.idle_timeout_minutes must be an integer`,
      400,
    );
  }

  if (
    typeof absolute_timeout_minutes !== "number" ||
    !Number.isFinite(absolute_timeout_minutes) ||
    absolute_timeout_minutes !== Math.floor(absolute_timeout_minutes)
  ) {
    throw new HttpError(
      `${label}.absolute_timeout_minutes must be an integer`,
      400,
    );
  }

  if (idle_timeout_minutes < MIN_IDLE_MINUTES) {
    throw new HttpError(
      `${label}.idle_timeout_minutes must be at least ${MIN_IDLE_MINUTES}`,
      400,
    );
  }

  if (absolute_timeout_minutes < MIN_ABSOLUTE_MINUTES) {
    throw new HttpError(
      `${label}.absolute_timeout_minutes must be at least ${MIN_ABSOLUTE_MINUTES}`,
      400,
    );
  }

  return { idle_timeout_minutes, absolute_timeout_minutes };
}

export async function updateSessionPolicy(
  client: PoolClient,
  accountId: string,
  input: unknown,
): Promise<SessionPolicy> {
  await assertAuthorized(client, "admin", accountId, "system-settings:write");

  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    throw new HttpError("Request body must be a JSON object", 400);
  }

  const { general, admin } = input as Record<string, unknown>;
  if (general === undefined || admin === undefined) {
    throw new HttpError(
      "Both general and admin policy contexts are required",
      400,
    );
  }

  const policy: SessionPolicy = {
    general: validateContext("general", general),
    admin: validateContext("admin", admin),
  };

  await client.query(
    `INSERT INTO system_settings (key, value, updated_at)
     VALUES ('session_policy', $1::jsonb, NOW())
     ON CONFLICT (key)
     DO UPDATE SET value = $1::jsonb, updated_at = NOW()`,
    [JSON.stringify(policy)],
  );

  return policy;
}
