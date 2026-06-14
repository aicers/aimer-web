// RFC 0003 Tier-1 feed-refresh (3b, #570) — the self-fetch scheduler worker.
//
// Part 3a (#568) built the self-fetch ENGINE plus the operator-triggered
// "Fetch Now". This worker adds the BACKGROUND scheduler that calls that
// engine on a timer, gated by the operator-configured schedule
// (`feed-schedule.ts`) that is DISABLED by default. No new fetch/parse/import
// logic — it only DRIVES the existing engine periodically.
//
// Modeled on `analysis-job-worker.ts`: a module-slot timer
// (`Symbol.for("aimer.tifeed.selfFetchWorker")`), an in-flight guard so a slow
// tick never overlaps itself, idempotent install, and an `uninstall` for tests.
//
// Each tick is a NO-OP unless `self-fetch` is the active supply mode AND the
// schedule is enabled. Otherwise it does NOT call `fetchAndImportAll()` blindly
// (that would over-fetch when `intervalMs > floor`, since the engine only
// enforces the per-source floor, not the operator interval). Instead, for each
// FETCHABLE catalog source it computes the effective cadence
// `max(intervalMs ?? cadenceFloorMs, cadenceFloorMs)`, reads the source's
// `feed_fetch_state`, and fetches ONLY sources that are due
// (`now >= nextFetchAllowedAt(state, effectiveCadence)`; a never-fetched source
// is due). The engine remains the final hard-floor / single-flight guard, so
// there is no double-fetch risk.

import "server-only";

import type { Pool } from "pg";
import { TIER1_FEED_SOURCES } from "../analysis/enrichment/feed-catalog";
import {
  nextFetchAllowedAt,
  readFeedFetchState,
  SelfFetchFeedSource,
  type SelfFetchOutcome,
  selfFetchModeActive,
} from "../analysis/enrichment/feed-fetch";
import {
  effectiveCadenceMs,
  readSelfFetchSchedule,
  type SelfFetchSchedule,
} from "../analysis/enrichment/feed-schedule";
import { VENDOR_REPO_DEFAULT_CADENCE_FLOOR_MS } from "../analysis/enrichment/feed-vendor-repo";
import { getAuthPool, getFeedPool } from "../db/client";
import { getCurrentTimestamp } from "./time";

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const DEFAULT_POLL_INTERVAL_MS = 5 * 60 * 1000;

const POLL_INTERVAL_MS = resolveInt(
  process.env.TI_FEED_SELF_FETCH_POLL_INTERVAL_MS,
  DEFAULT_POLL_INTERVAL_MS,
);

function resolveInt(raw: string | undefined, fallback: number): number {
  if (!raw) return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}

// ---------------------------------------------------------------------------
// Tick
// ---------------------------------------------------------------------------

/** The minimal engine surface the tick drives (so tests can stub it). */
interface FetchEngine {
  fetchAndImport(sourcePolicyId: string): Promise<SelfFetchOutcome>;
}

export interface SelfFetchTickDeps {
  /** Auth pool the schedule is read from. Defaults to the auth pool. */
  authPool?: Pool;
  /** Feed pool the engine + `feed_fetch_state` read from. Defaults to feed pool. */
  feedPool?: Pool;
  /** Inject the engine (tests stub `fetchAndImport`). Defaults to a real one. */
  source?: FetchEngine;
  /** Override the mode gate (tests). Defaults to `selfFetchModeActive`. */
  modeActive?: () => boolean;
  /** Override the schedule read (tests). Defaults to `readSelfFetchSchedule`. */
  readSchedule?: (authPool: Pool) => Promise<SelfFetchSchedule>;
  /** Clock (tests pin it). Defaults to `getCurrentTimestamp`. */
  now?: () => Date;
}

/**
 * Run one scheduler tick. No-op unless `self-fetch` mode is active and the
 * schedule is enabled. Otherwise fetches every DUE fetchable source through
 * the engine (the final floor / single-flight guard). A single source's
 * failure is isolated so it does not block the others.
 */
export async function runSelfFetchTickOnce(
  deps: SelfFetchTickDeps = {},
): Promise<void> {
  const modeActive = deps.modeActive ?? selfFetchModeActive;
  if (!modeActive()) return;

  const authPool = deps.authPool ?? getAuthPool();
  const readSchedule = deps.readSchedule ?? readSelfFetchSchedule;
  const schedule = await readSchedule(authPool);
  if (!schedule.enabled) return;

  const feedPool = deps.feedPool ?? getFeedPool();
  const source = deps.source ?? new SelfFetchFeedSource({ feedPool });
  const now = (deps.now ?? getCurrentTimestamp)();

  for (const catalogSource of TIER1_FEED_SOURCES) {
    // A source is schedulable via either a flat self-fetch config or a
    // vendor-repo config; each carries its own hard cadence floor. Skip a
    // source with neither (e.g. `spamhaus/edrop`, merged into DROP).
    const cadenceFloorMs =
      catalogSource.fetch?.cadenceFloorMs ??
      (catalogSource.vendorRepo
        ? (catalogSource.vendorRepo.cadenceFloorMs ??
          VENDOR_REPO_DEFAULT_CADENCE_FLOOR_MS)
        : undefined);
    if (cadenceFloorMs === undefined) continue;

    const cadence = effectiveCadenceMs(schedule.intervalMs, cadenceFloorMs);
    const state = await readFeedFetchState(
      feedPool,
      catalogSource.sourcePolicyId,
    );
    const allowedAt = nextFetchAllowedAt(state, cadence);
    // A never-fetched source (`allowedAt === null`) is due immediately.
    const due = allowedAt === null || now.getTime() >= allowedAt.getTime();
    if (!due) continue;

    try {
      await source.fetchAndImport(catalogSource.sourcePolicyId);
    } catch (err) {
      console.error(
        `[self-fetch-worker] fetch failed for ${catalogSource.sourcePolicyId}:`,
        err,
      );
    }
  }

  getSlot().lastRunAt = now;
}

// ---------------------------------------------------------------------------
// Installer (module-slot timer) — mirrors `analysis-job-worker.ts`
// ---------------------------------------------------------------------------

const WORKER_SLOT = Symbol.for("aimer.tifeed.selfFetchWorker");

interface WorkerSlot {
  timer: NodeJS.Timeout | null;
  inFlight: boolean;
  /** In-memory last-run timestamp (NOT persisted; per-source state is). */
  lastRunAt: Date | null;
}

type GlobalWithWorkerSlot = typeof globalThis & {
  [WORKER_SLOT]?: WorkerSlot;
};

function getSlot(): WorkerSlot {
  const g = globalThis as GlobalWithWorkerSlot;
  let slot = g[WORKER_SLOT];
  if (!slot) {
    slot = { timer: null, inFlight: false, lastRunAt: null };
    g[WORKER_SLOT] = slot;
  }
  return slot;
}

/** The worker's last successful enabled-tick time (in-memory), or `null`. */
export function getLastSelfFetchRunAt(): Date | null {
  return getSlot().lastRunAt;
}

/**
 * Install the background self-fetch scheduler. Idempotent: a second call while
 * the timer is live is a no-op. The timer is `unref`'d so it never keeps the
 * process alive on its own. The tick itself no-ops cheaply outside `self-fetch`
 * mode or while the schedule is disabled, so it is safe to install always.
 */
export function installSelfFetchWorker(): void {
  const slot = getSlot();
  if (slot.timer) return;
  const tick = () => {
    if (slot.inFlight) return;
    slot.inFlight = true;
    runSelfFetchTickOnce()
      .catch((err) => {
        console.error("[self-fetch-worker] tick failed:", err);
      })
      .finally(() => {
        slot.inFlight = false;
      });
  };
  slot.timer = setInterval(tick, POLL_INTERVAL_MS);
  if (typeof slot.timer.unref === "function") slot.timer.unref();
}

/** Stop the background scheduler (tests / shutdown). */
export function uninstallSelfFetchWorker(): void {
  const slot = getSlot();
  if (slot.timer) {
    clearInterval(slot.timer);
    slot.timer = null;
  }
}
