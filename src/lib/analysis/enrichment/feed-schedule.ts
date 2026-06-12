// RFC 0003 Tier-1 feed-refresh (3b, #570) — the self-fetch scheduler config.
//
// The background self-fetch scheduler (`self-fetch-worker.ts`) is gated by an
// operator-configured schedule stored in the auth DB `system_settings`
// (key `ti_feed_self_fetch_schedule`, JSONB `{ enabled, intervalMs? }`).
//
// **Default off, on purpose.** Fleet/SaaS deployments use the central mirror
// (part 4); per-instance scheduled self-fetch at fleet scale risks over-fetch
// (the engine's single-flight advisory lock is per feed-DB, so it does not
// coordinate across per-customer DBs). So the schedule ships DISABLED and is
// opt-in for on-prem / independent / sovereignty operators.
//
// `intervalMs` is the desired refresh cadence; it is clamped UP to each
// source's `cadenceFloorMs` (the engine floor is the hard minimum — effective
// cadence = `max(intervalMs, cadenceFloorMs)`). When unset, the per-source
// floor cadence is used (fetch as fresh as the license allows; 304s make this
// cheap). The engine remains the final hard-floor / single-flight guard, so
// the schedule only DRIVES the existing engine periodically.
//
// SERVER-ONLY. Reads/writes the auth DB.

import "server-only";

import type { Pool, PoolClient } from "pg";
import { auditLog } from "@/lib/audit";
import { assertAuthorized } from "@/lib/auth/authorization";
import { HttpError } from "@/lib/auth/errors";
import { getAuthPool } from "@/lib/db/client";

/** `system_settings` key holding the self-fetch schedule. */
export const TI_FEED_SCHEDULE_KEY = "ti_feed_self_fetch_schedule";

/** Permission gating schedule writes (shared with the rest of `ti-feed`). */
const PERM_WRITE = "ti-feed:write";

/** The operator-configured self-fetch schedule. */
export interface SelfFetchSchedule {
  /** Whether the background scheduler may fetch at all. Defaults to `false`. */
  enabled: boolean;
  /**
   * Desired refresh cadence (ms). Clamped UP to each source's
   * `cadenceFloorMs` at tick time. When unset, the per-source floor cadence
   * is used.
   */
  intervalMs?: number;
}

/** The default (and defensive-fallback) schedule: disabled. */
export const DISABLED_SCHEDULE: SelfFetchSchedule = { enabled: false };

// A Pool or a checked-out PoolClient — both expose `.query`.
type Queryable = Pool | PoolClient;

/**
 * Coerce an arbitrary stored value into a `SelfFetchSchedule`. Defensive: a
 * value that is not an object, or whose `enabled` is not a boolean, coerces
 * to DISABLED (a bad/stale row must never silently start fetching). A valid
 * `enabled` with a malformed `intervalMs` keeps `enabled` and drops the
 * interval (so the tick falls back to the per-source floor cadence).
 */
export function coerceSchedule(value: unknown): SelfFetchSchedule {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return { ...DISABLED_SCHEDULE };
  }
  const obj = value as Record<string, unknown>;
  if (typeof obj.enabled !== "boolean") {
    return { ...DISABLED_SCHEDULE };
  }
  const schedule: SelfFetchSchedule = { enabled: obj.enabled };
  if (
    typeof obj.intervalMs === "number" &&
    Number.isFinite(obj.intervalMs) &&
    obj.intervalMs > 0
  ) {
    schedule.intervalMs = Math.floor(obj.intervalMs);
  }
  return schedule;
}

/**
 * Validate a request body into a `SelfFetchSchedule`. Throws `HttpError` 400
 * on a malformed body (the write path is strict, unlike the defensive read).
 */
export function parseScheduleInput(input: unknown): SelfFetchSchedule {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    throw new HttpError("Request body must be a JSON object", 400);
  }
  const obj = input as Record<string, unknown>;
  if (typeof obj.enabled !== "boolean") {
    throw new HttpError("enabled is required and must be a boolean", 400);
  }
  const schedule: SelfFetchSchedule = { enabled: obj.enabled };
  if (obj.intervalMs !== undefined && obj.intervalMs !== null) {
    if (
      typeof obj.intervalMs !== "number" ||
      !Number.isFinite(obj.intervalMs) ||
      obj.intervalMs <= 0
    ) {
      throw new HttpError("intervalMs must be a positive number", 400);
    }
    schedule.intervalMs = Math.floor(obj.intervalMs);
  }
  return schedule;
}

/**
 * The effective per-source cadence (ms) the scheduler enforces: the operator
 * interval clamped UP to the source's hard floor. When `intervalMs` is unset,
 * this is exactly the floor (reproducing the engine's floor cadence).
 */
export function effectiveCadenceMs(
  intervalMs: number | undefined,
  cadenceFloorMs: number,
): number {
  return Math.max(intervalMs ?? cadenceFloorMs, cadenceFloorMs);
}

/**
 * Read the self-fetch schedule, or DISABLED when unset/malformed. Defensive
 * at the DB tier: any read/coercion failure logs and returns DISABLED rather
 * than throwing — a broken settings row must never start background fetching.
 */
export async function readSelfFetchSchedule(
  db: Queryable = getAuthPool(),
): Promise<SelfFetchSchedule> {
  try {
    const res = await db.query<{ value: unknown }>(
      `SELECT value FROM system_settings WHERE key = $1`,
      [TI_FEED_SCHEDULE_KEY],
    );
    if (res.rows.length === 0) return { ...DISABLED_SCHEDULE };
    return coerceSchedule(res.rows[0].value);
  } catch (err) {
    console.warn(
      JSON.stringify({
        level: "warn",
        event: "ti_feed.self_fetch_schedule.read_failed",
        error: err instanceof Error ? err.message : String(err),
        action: "fell back to disabled",
      }),
    );
    return { ...DISABLED_SCHEDULE };
  }
}

/**
 * Set the self-fetch schedule. Admin context only (`ti-feed:write`). Validates
 * the body at save and records an audited write.
 */
export async function setSelfFetchSchedule(
  client: PoolClient,
  accountId: string,
  input: unknown,
  auditMeta?: { ipAddress: string; sid: string },
): Promise<SelfFetchSchedule> {
  await assertAuthorized(client, "admin", accountId, PERM_WRITE);
  const schedule = parseScheduleInput(input);
  const prev = await readSelfFetchSchedule(client);
  await client.query(
    `INSERT INTO system_settings (key, value, updated_at)
     VALUES ($1, $2::jsonb, NOW())
     ON CONFLICT (key)
     DO UPDATE SET value = $2::jsonb, updated_at = NOW()`,
    [TI_FEED_SCHEDULE_KEY, JSON.stringify(schedule)],
  );
  void auditLog({
    actorId: accountId,
    authContext: "admin",
    action: "system.ti_feed_self_fetch_schedule_updated",
    targetType: "system_settings",
    targetId: TI_FEED_SCHEDULE_KEY,
    ipAddress: auditMeta?.ipAddress,
    sid: auditMeta?.sid,
    details: { before: prev, after: schedule },
  });
  return schedule;
}
