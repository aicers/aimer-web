// Event-leaf backfill background worker (#470 Scope §3, §5, §8).
//
// Events have no `*_analysis_job` worker drain to lean on, so this worker
// IS the drain: it claims an operator-created run, then re-analyzes its
// materialized work items by calling the shared `regenerateEventLeaf`
// helper (#463 extraction) per event — self-paced, observing the run's
// cooperative cancel flag, and writing categorized per-item status +
// aggregate counts to the `event_leaf_backfill_*` tables.
//
// SELF-PACING (the key difference from #466's story side): re-analysis is
// synchronous (one aimer call per event, no job-worker batch bound), so the
// worker paces its OWN calls — it processes at most
// `EVENT_BACKFILL_BATCH_SIZE` items per tick and ticks every
// `EVENT_BACKFILL_POLL_INTERVAL_MS`, bounding the LLM-cost burst to roughly
// BATCH_SIZE events per interval. The per-run `max_items` cap bounds total
// cost; the 7-day default window (see `event-leaf-backfill.ts`) bounds
// scope. All three are documented defaults.
//
// IDEMPOTENCY: before re-analyzing each item the worker re-checks whether a
// non-superseded target-variant leaf now exists (created since
// materialization, e.g. by a concurrent run or a manual regenerate) and
// skips it as `already_current` rather than duplicating work. It NEVER
// compares generations across models.

import "server-only";

import type { Pool } from "pg";
import { hasTargetVariantLeaf } from "../analysis/event-leaf-backfill";
import {
  type BackfillRun,
  claimItem,
  claimRun,
  countUnfinished,
  fetchPendingItems,
  finalizeRun,
  isCancelRequested,
  type PendingItem,
  reclaimStaleItems,
  recordItemResult,
} from "../analysis/event-leaf-backfill-store";
import {
  type RegenerateEventOutcome,
  regenerateEventLeaf,
} from "../analysis/regenerate-event";
import {
  isSupportedLang,
  type SupportedLang,
} from "../analysis/run-analyze-flow";
import { getAuthPool } from "../db/client";
import { getCustomerRuntimePool } from "../db/customer-runtime-pool";
import { getCurrentTimestamp } from "./time";

// ---------------------------------------------------------------------------
// Configuration (documented self-paced throttle defaults)
// ---------------------------------------------------------------------------

const DEFAULT_BATCH_SIZE = 5;
const DEFAULT_POLL_INTERVAL_MS = 10_000;

// How long an item may stay `processing` before another tick treats the
// claim as stale (the claiming worker crashed) and resets it to `pending`.
// Must comfortably exceed a single re-analysis model call so an in-flight
// item is never reclaimed out from under a live worker.
const ITEM_LEASE_MS = 15 * 60_000;

function resolvePositiveInt(raw: string | undefined, fallback: number): number {
  if (raw == null || raw === "") return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.floor(n);
}

export function resolveBatchSize(): number {
  return resolvePositiveInt(
    process.env.EVENT_BACKFILL_BATCH_SIZE,
    DEFAULT_BATCH_SIZE,
  );
}

function resolvePollIntervalMs(): number {
  return resolvePositiveInt(
    process.env.EVENT_BACKFILL_POLL_INTERVAL_MS,
    DEFAULT_POLL_INTERVAL_MS,
  );
}

// ---------------------------------------------------------------------------
// Tick (testable, dependency-injected)
// ---------------------------------------------------------------------------

export interface EventBackfillDeps {
  authPool: Pool;
  /** Resolve a customer runtime pool (read source + idempotency re-check). */
  getCustomerPool: (customerId: string) => Pool;
  /** The shared single-event re-analysis helper (injectable for tests). */
  regenerate: (args: {
    authPool: Pool;
    customerPool: Pool;
    run: BackfillRun;
    item: PendingItem;
  }) => Promise<RegenerateEventOutcome>;
  /** Items processed per tick (self-paced throttle). */
  batchSize: number;
  /** Injectable clock. */
  now: () => Date;
}

function defaultDeps(): EventBackfillDeps {
  return {
    authPool: getAuthPool(),
    getCustomerPool: getCustomerRuntimePool,
    regenerate: ({ authPool, customerPool, run, item }) =>
      regenerateEventLeaf({
        authPool,
        customerPool,
        customerId: run.customerId,
        aiceId: item.aiceId,
        eventKey: item.eventKey,
        // The create path only ever stores ENGLISH/KOREAN; narrow defensively.
        lang: (isSupportedLang(run.lang)
          ? run.lang
          : "ENGLISH") as SupportedLang,
        modelName: run.modelName,
        model: run.model,
        accountId: run.createdBy ?? "",
        auditMeta: { ipAddress: undefined, sid: `event-backfill:${run.id}` },
        force: true,
      }),
    batchSize: resolveBatchSize(),
    now: getCurrentTimestamp,
  };
}

export interface TickResult {
  claimed: boolean;
  runId?: string;
  processed: number;
  cancelled: boolean;
  completed: boolean;
}

/**
 * One worker tick: claim an active run and process up to `batchSize`
 * pending items via the shared regenerate helper, observing cancel and
 * recording categorized per-item status. Finalizes the run to `completed`
 * once no pending items remain, or to `cancelled` when the flag is set.
 * Bounded to one batch per tick so the LLM-cost burst stays self-paced.
 */
export async function runEventBackfillTickOnce(
  deps: EventBackfillDeps = defaultDeps(),
): Promise<TickResult> {
  const authClient = await deps.authPool.connect();
  let processed = 0;
  try {
    const nowIso = deps.now().toISOString();
    const run = await claimRun(authClient, nowIso);
    if (!run)
      return {
        claimed: false,
        processed: 0,
        cancelled: false,
        completed: false,
      };

    // Cancel observed at claim time: finalize without processing.
    if (run.cancelRequested) {
      await finalizeRun(
        authClient,
        run.id,
        "cancelled",
        deps.now().toISOString(),
      );
      return {
        claimed: true,
        runId: run.id,
        processed: 0,
        cancelled: true,
        completed: false,
      };
    }

    // Reclaim items left `processing` by a crashed worker so they are
    // retried this tick rather than stranding the run short of completion.
    const staleBeforeIso = new Date(
      deps.now().getTime() - ITEM_LEASE_MS,
    ).toISOString();
    await reclaimStaleItems(authClient, run.id, staleBeforeIso);

    const items = await fetchPendingItems(authClient, run.id, deps.batchSize);
    if (items.length === 0) {
      // No pending items to pick up. Only finalize as completed once NO
      // unfinished items remain — an item still `processing` on another
      // replica must not let this worker declare the run done early.
      if ((await countUnfinished(authClient, run.id)) === 0) {
        await finalizeRun(
          authClient,
          run.id,
          "completed",
          deps.now().toISOString(),
        );
        return {
          claimed: true,
          runId: run.id,
          processed: 0,
          cancelled: false,
          completed: true,
        };
      }
      return {
        claimed: true,
        runId: run.id,
        processed: 0,
        cancelled: false,
        completed: false,
      };
    }

    const customerPool = deps.getCustomerPool(run.customerId);
    for (const item of items) {
      // Observe cancel between events so a cancel takes effect promptly.
      if (await isCancelRequested(authClient, run.id)) {
        await finalizeRun(
          authClient,
          run.id,
          "cancelled",
          deps.now().toISOString(),
        );
        return {
          claimed: true,
          runId: run.id,
          processed,
          cancelled: true,
          completed: false,
        };
      }

      // Claim the item (pending -> processing) BEFORE any model call. If
      // another replica already claimed it, skip without re-analyzing — this
      // is what keeps the per-event model call (and the cost bound) at
      // most-once across replicas.
      const claimed = await claimItem(
        authClient,
        run.id,
        item,
        deps.now().toISOString(),
      );
      if (!claimed) continue;

      // Idempotency re-check: a target-variant leaf may have appeared since
      // materialization (concurrent run / manual regenerate). Skip rather
      // than duplicate. No cross-model generation comparison.
      const present = await hasTargetVariantLeaf(
        customerPool,
        item.aiceId,
        item.eventKey,
        { lang: run.lang, modelName: run.modelName, model: run.model },
      );
      if (present) {
        await recordItemResult(
          authClient,
          run.id,
          item,
          "already_current",
          deps.now().toISOString(),
        );
        processed += 1;
        continue;
      }

      let outcome: RegenerateEventOutcome;
      try {
        outcome = await deps.regenerate({
          authPool: deps.authPool,
          customerPool,
          run,
          item,
        });
      } catch (err) {
        outcome = {
          kind: "error",
          errorCode: "storage_failed",
          message: err instanceof Error ? err.message : "regenerate threw",
        };
      }

      if (outcome.kind === "reanalyzed") {
        await recordItemResult(
          authClient,
          run.id,
          item,
          "reanalyzed",
          deps.now().toISOString(),
        );
      } else if (outcome.kind === "source_unavailable") {
        await recordItemResult(
          authClient,
          run.id,
          item,
          "source_unavailable",
          deps.now().toISOString(),
        );
      } else {
        await recordItemResult(
          authClient,
          run.id,
          item,
          "failed",
          deps.now().toISOString(),
          `${outcome.errorCode}: ${outcome.message}`,
        );
      }
      processed += 1;
    }

    // Finalize promptly if this batch drained the run. Count BOTH pending
    // and processing so a concurrent replica's in-flight item is not
    // mistaken for a drained run.
    const remaining = await countUnfinished(authClient, run.id);
    if (remaining === 0) {
      await finalizeRun(
        authClient,
        run.id,
        "completed",
        deps.now().toISOString(),
      );
      return {
        claimed: true,
        runId: run.id,
        processed,
        cancelled: false,
        completed: true,
      };
    }
    return {
      claimed: true,
      runId: run.id,
      processed,
      cancelled: false,
      completed: false,
    };
  } finally {
    authClient.release();
  }
}

// ---------------------------------------------------------------------------
// Installer (in-process setInterval, mirrors the reconcile worker)
// ---------------------------------------------------------------------------

const WORKER_SLOT = Symbol.for("aimer.analysis.eventBackfillWorker");

interface WorkerSlot {
  timer: NodeJS.Timeout | null;
  inFlight: boolean;
}

type GlobalWithSlot = typeof globalThis & {
  [WORKER_SLOT]?: WorkerSlot;
};

function getSlot(): WorkerSlot {
  const g = globalThis as GlobalWithSlot;
  let slot = g[WORKER_SLOT];
  if (!slot) {
    slot = { timer: null, inFlight: false };
    g[WORKER_SLOT] = slot;
  }
  return slot;
}

export function installEventBackfillWorker(deps?: EventBackfillDeps): void {
  const slot = getSlot();
  if (slot.timer) return;
  const intervalMs = resolvePollIntervalMs();
  const tick = () => {
    if (slot.inFlight) return;
    slot.inFlight = true;
    runEventBackfillTickOnce(deps)
      .catch((err) => {
        console.error("[event-backfill] tick failed:", err);
      })
      .finally(() => {
        slot.inFlight = false;
      });
  };
  slot.timer = setInterval(tick, intervalMs);
  if (typeof slot.timer.unref === "function") slot.timer.unref();
}

export function uninstallEventBackfillWorker(): void {
  const slot = getSlot();
  if (slot.timer) {
    clearInterval(slot.timer);
    slot.timer = null;
  }
}
