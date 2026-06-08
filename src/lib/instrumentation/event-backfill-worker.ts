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
// PER-RUN (not per-replica) THROTTLE: the worker installs in every server
// process, so the BATCH_SIZE-per-interval bound only holds if a single
// process drains a given run at a time. `claimRun` takes a single-owner
// lease and the worker heartbeats it per item (`renewLease`); while the
// lease is held no other replica can claim that run, so the burst stays
// `BATCH_SIZE` per interval regardless of replica count rather than
// `replicas × BATCH_SIZE`. A crashed owner's lease lapses and another
// worker resumes the run. Per-item claims remain the correctness backstop.
//
// IDEMPOTENCY: before re-analyzing each item the worker re-checks whether a
// non-superseded target-variant leaf now exists (created since
// materialization, e.g. by a concurrent run or a manual regenerate) and
// skips it as `already_current` rather than duplicating work. It NEVER
// compares generations across models.

import "server-only";

import { randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
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
  renewLease,
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

// How long a run lease is valid before another worker may take an
// (apparently crashed) owner's run over. The owner renews it after every
// item, so it only needs to exceed a single item's worst-case processing
// time — kept >= the item lease so a worker legitimately mid-item never
// loses its run lease while its in-flight item is still un-reclaimable.
const RUN_LEASE_MS = ITEM_LEASE_MS + DEFAULT_POLL_INTERVAL_MS;

// Stable identity for THIS process's worker, so a run's lease can be tied to
// one replica and renewed by it across ticks. Generated once per process.
const PROCESS_OWNER = randomUUID();

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
  /** This worker's stable lease owner id (one per process). */
  owner: string;
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
    owner: PROCESS_OWNER,
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
 * Finalize a drained run (no unfinished items left). Re-checks the cancel
 * flag FIRST so a cancel requested while the last item was in flight — i.e.
 * after the per-item cancel check but before the run drained — is honoured
 * as `cancelled` rather than silently reported as `completed`. `finalizeRun`
 * is status-guarded, so if another replica already finalized this run (e.g.
 * to `cancelled` at claim time) this is a harmless no-op and `completed`
 * never clobbers it.
 */
async function finalizeDrainedRun(
  authClient: PoolClient,
  runId: string,
  now: () => Date,
): Promise<{ cancelled: boolean }> {
  const cancelled = await isCancelRequested(authClient, runId);
  await finalizeRun(
    authClient,
    runId,
    cancelled ? "cancelled" : "completed",
    now().toISOString(),
  );
  return { cancelled };
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
    const leaseExpiresIso = new Date(
      deps.now().getTime() + RUN_LEASE_MS,
    ).toISOString();
    const run = await claimRun(authClient, nowIso, deps.owner, leaseExpiresIso);
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
      // No pending items to pick up. Only finalize once NO unfinished items
      // remain — an item still `processing` on another replica must not let
      // this worker declare the run done early. A late cancel is honoured
      // over `completed` (see finalizeDrainedRun).
      if ((await countUnfinished(authClient, run.id)) === 0) {
        const { cancelled } = await finalizeDrainedRun(
          authClient,
          run.id,
          deps.now,
        );
        return {
          claimed: true,
          runId: run.id,
          processed: 0,
          cancelled,
          completed: !cancelled,
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
      // Heartbeat the run lease before each item so a slow batch never lets
      // the lease expire under us and a second replica start a parallel
      // batch (which would break the per-run burst bound). If we have lost
      // the lease — we fell behind by more than RUN_LEASE_MS, so another
      // worker now owns the run — stop processing this batch; the new owner
      // continues. Items already recorded this tick stay recorded.
      const held = await renewLease(
        authClient,
        run.id,
        deps.owner,
        deps.now().toISOString(),
        new Date(deps.now().getTime() + RUN_LEASE_MS).toISOString(),
      );
      if (!held) {
        return {
          claimed: true,
          runId: run.id,
          processed,
          cancelled: false,
          completed: false,
        };
      }

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
    // mistaken for a drained run. Re-check the cancel flag before declaring
    // the run completed so a cancel requested during the last item's model
    // call is honoured as `cancelled`, not silently `completed`.
    const remaining = await countUnfinished(authClient, run.id);
    if (remaining === 0) {
      const { cancelled } = await finalizeDrainedRun(
        authClient,
        run.id,
        deps.now,
      );
      return {
        claimed: true,
        runId: run.id,
        processed,
        cancelled,
        completed: !cancelled,
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
