import "server-only";

import { cleanupExpiredAnalyzeRequests } from "../auth/analyze-bridge";
import { cleanupExpiredConnections } from "../auth/bridge";
import {
  cleanupTerminalPayloads,
  expireStagedEvents,
} from "../auth/staged-events";
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
 * Tick the four auth-pool cleanup helpers in dependency order:
 *
 *   1. `cleanupExpiredAnalyzeRequests` — flips `pending` → `expired`
 *      and deletes terminal PAR rows past the 24h grace.
 *   2. `expireStagedEvents` — flips Phase 1 `staged_event_customers`
 *      rows from `pending` to `expired` whenever their parent
 *      `staged_event_payloads.expires_at` is in the past. Without
 *      this, an unprocessed Phase 1 payload (never listed / approved)
 *      keeps its customer rows in `pending` forever, blocks
 *      `cleanupTerminalPayloads`, and ultimately wedges
 *      `cleanupExpiredConnections` on the FK from
 *      `staged_event_payloads.connection_id`.
 *   3. `cleanupTerminalPayloads` — removes Phase 1 staged payloads
 *      whose per-customer rows are all terminal.
 *   4. `cleanupExpiredConnections` — deletes parent
 *      `pending_connections` rows past the 24h grace.
 *
 * Order matters: `pending_analysis_requests.connection_id` and
 * `staged_event_payloads.connection_id` are both `NO ACTION`
 * (RESTRICT-equivalent) FKs to `pending_connections`. If (4) runs
 * before (1)-(3), any child row still in the 24h grace window
 * (consumed / failed PAR, or a stale Phase 1 payload whose customers
 * are still `pending`) would block the parent DELETE with an FK
 * violation. Always run (1)-(3) before (4); always run (2) before
 * (3) so stale-pending customer rows can be cleaned out.
 */
async function tick(): Promise<void> {
  const pool = getAuthPool();
  try {
    await cleanupExpiredAnalyzeRequests(pool);
  } catch (err) {
    console.error("[auth-pool-cleanup] PAR cleanup failed:", err);
  }
  try {
    await expireStagedEvents(pool);
  } catch (err) {
    console.error("[auth-pool-cleanup] staged events expire failed:", err);
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

/**
 * Test-only entry point: run a single cleanup tick synchronously
 * without installing the interval. Not exported via index — imported
 * directly by unit tests.
 */
export async function runCleanupTickForTests(): Promise<void> {
  await tick();
}

export function uninstallAuthPoolCleanup(): void {
  if (slot.timer) {
    clearInterval(slot.timer);
    slot.timer = null;
  }
}
