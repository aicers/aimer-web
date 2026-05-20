import "server-only";

import { cleanupExpiredAnalyzeRequests } from "../auth/analyze-bridge";
import { cleanupExpiredConnections } from "../auth/bridge";
import { cleanupTerminalPayloads } from "../auth/staged-events";
import { getAuthPool } from "../db/client";

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const DEFAULT_INTERVAL_MS = 5 * 60_000; // 5 minutes

function resolveIntervalMs(): number {
  const raw = process.env.AUTH_POOL_CLEANUP_INTERVAL_MS;
  if (!raw) return DEFAULT_INTERVAL_MS;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_INTERVAL_MS;
  return n;
}

// ---------------------------------------------------------------------------
// Idempotent install slot
// ---------------------------------------------------------------------------

interface InstallSlot {
  timer: NodeJS.Timeout | null;
  inFlight: boolean;
}

const slot: InstallSlot = { timer: null, inFlight: false };

/**
 * Tick the three auth-pool cleanup helpers in dependency order:
 *
 *   1. `cleanupExpiredAnalyzeRequests` — flips `pending` → `expired`
 *      and deletes terminal rows past the 24h grace.
 *   2. `cleanupTerminalPayloads` — removes Phase 1 staged payloads
 *      whose per-customer rows are all terminal.
 *   3. `cleanupExpiredConnections` — deletes parent `pending_connections`
 *      rows past the 24h grace.
 *
 * Order matters: `pending_analysis_requests.connection_id` is a
 * `NO ACTION` (RESTRICT-equivalent) FK to `pending_connections`. If
 * (3) runs first, any child PAR row still in the 24h grace window
 * (consumed / failed) would block the parent DELETE with an FK
 * violation. Always run (1) before (3).
 */
async function tick(): Promise<void> {
  const pool = getAuthPool();
  try {
    await cleanupExpiredAnalyzeRequests(pool);
  } catch (err) {
    console.error("[auth-pool-cleanup] PAR cleanup failed:", err);
  }
  try {
    await cleanupTerminalPayloads(pool);
  } catch (err) {
    console.error("[auth-pool-cleanup] staged payloads cleanup failed:", err);
  }
  try {
    await cleanupExpiredConnections(pool);
  } catch (err) {
    console.error("[auth-pool-cleanup] connections cleanup failed:", err);
  }
}

export function installAuthPoolCleanup(): void {
  if (slot.timer) return;
  const intervalMs = resolveIntervalMs();
  const fire = () => {
    if (slot.inFlight) return;
    slot.inFlight = true;
    tick()
      .catch((err) => {
        console.error("[auth-pool-cleanup] tick failed:", err);
      })
      .finally(() => {
        slot.inFlight = false;
      });
  };
  slot.timer = setInterval(fire, intervalMs);
  if (typeof slot.timer.unref === "function") slot.timer.unref();
}

export function uninstallAuthPoolCleanup(): void {
  if (slot.timer) {
    clearInterval(slot.timer);
    slot.timer = null;
  }
}
