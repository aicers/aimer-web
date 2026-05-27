// RFC 0002 Phase 0 (#294) — reconciliation worker installer.
//
// The reconcile scan (issue #294 decision 2) is the safety net for
// ingest-hook failures: a customer-DB ingest commit followed by an
// auth-DB hook failure leaves visible customer-DB rows with no
// corresponding state row. Reconciliation idempotently seeds the
// missing rows and forward-patches lagging columns so the worker
// tick observes the full state.
//
// Cadence: separate timer from the main job worker, runs every
// `ANALYSIS_RECONCILE_INTERVAL_MINUTES` minutes (default 15min).
// Isolation: per-customer failures are logged and the next customer
// continues — one bad customer cannot stall the whole scan.

import "server-only";

import type { Pool, PoolClient } from "pg";
import {
  type CustomerConnection,
  type ReconcileDeps,
  runReconcileTick,
} from "../analysis/reconcile";
import { getAuditPool, getAuthPool } from "../db/client";
import { getCustomerRuntimePool } from "../db/customer-runtime-pool";

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const DEFAULT_INTERVAL_MINUTES = 15;

function resolveIntervalMs(): number {
  const raw = process.env.ANALYSIS_RECONCILE_INTERVAL_MINUTES;
  const minutes = (() => {
    if (raw == null || raw === "") return DEFAULT_INTERVAL_MINUTES;
    const n = Number(raw);
    if (!Number.isFinite(n) || n <= 0) {
      console.warn(
        `[analysis-reconcile] invalid ANALYSIS_RECONCILE_INTERVAL_MINUTES=${raw}, falling back to ${DEFAULT_INTERVAL_MINUTES}`,
      );
      return DEFAULT_INTERVAL_MINUTES;
    }
    return n;
  })();
  return minutes * 60_000;
}

// ---------------------------------------------------------------------------
// Default production deps
// ---------------------------------------------------------------------------

async function defaultConnectCustomer(
  customerId: string,
): Promise<CustomerConnection> {
  const pool = getCustomerRuntimePool(customerId);
  const client = await pool.connect();
  return {
    query: client.query.bind(client) as PoolClient["query"],
    end: async () => {
      client.release();
    },
  };
}

function defaultDeps(authPool?: Pool): ReconcileDeps {
  return {
    authPool: authPool ?? getAuthPool(),
    auditPool: getAuditPool(),
    connectCustomer: defaultConnectCustomer,
  };
}

// ---------------------------------------------------------------------------
// One-shot driver (testable)
// ---------------------------------------------------------------------------

export async function runAnalysisReconcileOnce(
  deps?: ReconcileDeps,
): Promise<void> {
  const resolved = deps ?? defaultDeps();
  await runReconcileTick(resolved);
}

// ---------------------------------------------------------------------------
// Installer
// ---------------------------------------------------------------------------

const WORKER_SLOT = Symbol.for("aimer.analysis.reconcileWorker");

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

export function installAnalysisReconcileWorker(deps?: ReconcileDeps): void {
  const slot = getSlot();
  if (slot.timer) return;
  const intervalMs = resolveIntervalMs();
  const tick = () => {
    if (slot.inFlight) return;
    slot.inFlight = true;
    runAnalysisReconcileOnce(deps)
      .catch((err) => {
        console.error("[analysis-reconcile] tick failed:", err);
      })
      .finally(() => {
        slot.inFlight = false;
      });
  };
  slot.timer = setInterval(tick, intervalMs);
  if (typeof slot.timer.unref === "function") slot.timer.unref();
}

export function uninstallAnalysisReconcileWorker(): void {
  const slot = getSlot();
  if (slot.timer) {
    clearInterval(slot.timer);
    slot.timer = null;
  }
}
