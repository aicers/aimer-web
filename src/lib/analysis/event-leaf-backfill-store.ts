// Auth-DB store for event-leaf backfill runs/items (#470).
//
// CRUD + lifecycle for `event_leaf_backfill_runs` / `event_leaf_backfill_items`.
// Shared by the API routes (create / status / cancel) and the background
// worker (claim / drain / finalize). The run/item tables are backfill
// CONTROL bookkeeping — they make background progress, cancel, per-item
// status, and no-silent-caps reporting possible without an event-analysis
// job worker. The drain signal is computed elsewhere from
// `event_analysis_result` itself (see `event-leaf-drain.ts`), not from
// these rows.
//
// SERVER-ONLY. Auth DB only — the customer-DB universe scan is done by the
// caller (create) and the worker (idempotency re-check) against a customer
// pool.

import "server-only";

import type { Pool, PoolClient } from "pg";
import type { ScopeWindow, TargetVariant } from "./event-leaf-backfill";
import { loadUniverse, planBackfill } from "./event-leaf-backfill";

export type RunStatus =
  | "pending"
  | "running"
  | "completed"
  | "cancelled"
  | "failed";

export type ItemStatus =
  | "pending"
  | "reanalyzed"
  | "already_current"
  | "source_unavailable"
  | "failed"
  | "cap_excluded";

/** The no-silent-caps aggregate counts on a run (Scope §8). */
export interface RunCounts {
  totalUniverse: number;
  reanalyzedCount: number;
  alreadyCurrentCount: number;
  sourceUnavailableCount: number;
  failedCount: number;
  capExcludedCount: number;
}

export interface BackfillRun extends RunCounts {
  id: string;
  customerId: string;
  lang: string;
  modelName: string;
  model: string;
  windowDays: number;
  windowStart: string;
  windowEnd: string;
  maxItems: number | null;
  status: RunStatus;
  cancelRequested: boolean;
  errorMessage: string | null;
  createdBy: string | null;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  lastProgressAt: string;
}

interface RunRow {
  id: string;
  customer_id: string;
  lang: string;
  model_name: string;
  model: string;
  window_days: number;
  window_start: Date | string;
  window_end: Date | string;
  max_items: number | null;
  status: RunStatus;
  cancel_requested: boolean;
  total_universe: number;
  reanalyzed_count: number;
  already_current_count: number;
  source_unavailable_count: number;
  failed_count: number;
  cap_excluded_count: number;
  error_message: string | null;
  created_by: string | null;
  created_at: Date | string;
  started_at: Date | string | null;
  finished_at: Date | string | null;
  last_progress_at: Date | string;
}

function iso(v: Date | string): string {
  return v instanceof Date ? v.toISOString() : String(v);
}

function isoOrNull(v: Date | string | null): string | null {
  return v == null ? null : iso(v);
}

function mapRun(r: RunRow): BackfillRun {
  return {
    id: r.id,
    customerId: r.customer_id,
    lang: r.lang,
    modelName: r.model_name,
    model: r.model,
    windowDays: r.window_days,
    windowStart: iso(r.window_start),
    windowEnd: iso(r.window_end),
    maxItems: r.max_items,
    status: r.status,
    cancelRequested: r.cancel_requested,
    totalUniverse: r.total_universe,
    reanalyzedCount: r.reanalyzed_count,
    alreadyCurrentCount: r.already_current_count,
    sourceUnavailableCount: r.source_unavailable_count,
    failedCount: r.failed_count,
    capExcludedCount: r.cap_excluded_count,
    errorMessage: r.error_message,
    createdBy: r.created_by,
    createdAt: iso(r.created_at),
    startedAt: isoOrNull(r.started_at),
    finishedAt: isoOrNull(r.finished_at),
    lastProgressAt: iso(r.last_progress_at),
  };
}

const RUN_COLUMNS = `id, customer_id, lang, model_name, model,
    window_days, window_start, window_end, max_items, status, cancel_requested,
    total_universe, reanalyzed_count, already_current_count,
    source_unavailable_count, failed_count, cap_excluded_count,
    error_message, created_by, created_at, started_at, finished_at,
    last_progress_at`;

export interface CreateRunParams {
  customerId: string;
  target: TargetVariant;
  windowDays: number;
  window: ScopeWindow;
  maxItems: number | null;
  createdBy: string;
}

/**
 * Create a backfill run and materialize its work items in one auth-DB
 * transaction, seeding the aggregate counts from a fresh universe scan
 * (the same `loadUniverse` / `planBackfill` the preview uses, so create
 * counts match the confirmed preview). The customer-DB universe scan
 * happens first (read-only); only the auth-DB writes are transactional.
 *
 * If an active run already exists for the same customer + target variant
 * (the partial unique index), the existing run is returned instead of
 * spawning a duplicate.
 */
export async function createRun(
  authClient: PoolClient,
  customerPool: Pool,
  params: CreateRunParams,
): Promise<{ run: BackfillRun; created: boolean }> {
  const existing = await findActiveRun(
    authClient,
    params.customerId,
    params.target,
  );
  if (existing) return { run: existing, created: false };

  const members = await loadUniverse(
    customerPool,
    params.window,
    params.target,
  );
  const plan = planBackfill(members, params.maxItems);

  await authClient.query("BEGIN");
  try {
    const insertRun = await authClient.query<RunRow>(
      `INSERT INTO event_leaf_backfill_runs
         (customer_id, lang, model_name, model,
          window_days, window_start, window_end, max_items,
          status, total_universe, already_current_count,
          source_unavailable_count, cap_excluded_count, created_by)
       VALUES ($1, $2, $3, $4, $5, $6::timestamptz, $7::timestamptz, $8,
               'pending', $9, $10, $11, $12, $13)
       RETURNING ${RUN_COLUMNS}`,
      [
        params.customerId,
        params.target.lang,
        params.target.modelName,
        params.target.model,
        params.windowDays,
        params.window.windowStart.toISOString(),
        params.window.windowEnd.toISOString(),
        params.maxItems,
        plan.counts.totalUniverse,
        plan.counts.alreadyCurrent,
        plan.counts.sourceUnavailable,
        plan.counts.capExcluded,
        params.createdBy,
      ],
    );
    const run = mapRun(insertRun.rows[0]);

    // Materialize ONLY the work items the run will touch as `pending`.
    // already_current / source_unavailable / cap_excluded stay aggregate
    // counts (Mechanism §). Bulk-insert via UNNEST.
    if (plan.workItems.length > 0) {
      const aiceIds = plan.workItems.map((w) => w.aiceId);
      const eventKeys = plan.workItems.map((w) => w.eventKey);
      await authClient.query(
        `INSERT INTO event_leaf_backfill_items (run_id, aice_id, event_key, status)
         SELECT $1, a, k::numeric, 'pending'
           FROM unnest($2::text[], $3::text[]) AS w(a, k)`,
        [run.id, aiceIds, eventKeys],
      );
    }
    await authClient.query("COMMIT");
    return { run, created: true };
  } catch (err) {
    await authClient.query("ROLLBACK").catch(() => {});
    // Lost the race against a concurrent create for the same variant —
    // return the now-existing active run rather than erroring.
    const raced = await findActiveRun(
      authClient,
      params.customerId,
      params.target,
    );
    if (raced) return { run: raced, created: false };
    throw err;
  }
}

/** Find an active (pending/running) run for a customer + target variant. */
export async function findActiveRun(
  client: PoolClient | Pool,
  customerId: string,
  target: TargetVariant,
): Promise<BackfillRun | null> {
  const { rows } = await client.query<RunRow>(
    `SELECT ${RUN_COLUMNS}
       FROM event_leaf_backfill_runs
      WHERE customer_id = $1 AND lang = $2 AND model_name = $3 AND model = $4
        AND status IN ('pending', 'running')
      ORDER BY created_at DESC
      LIMIT 1`,
    [customerId, target.lang, target.modelName, target.model],
  );
  return rows[0] ? mapRun(rows[0]) : null;
}

/** Fetch a run by id (any status), scoped to a customer for authz safety. */
export async function getRun(
  client: PoolClient | Pool,
  customerId: string,
  runId: string,
): Promise<BackfillRun | null> {
  const { rows } = await client.query<RunRow>(
    `SELECT ${RUN_COLUMNS}
       FROM event_leaf_backfill_runs
      WHERE id = $1 AND customer_id = $2`,
    [runId, customerId],
  );
  return rows[0] ? mapRun(rows[0]) : null;
}

/** List recent runs for a customer (most recent first). */
export async function listRuns(
  client: PoolClient | Pool,
  customerId: string,
  limit = 20,
): Promise<BackfillRun[]> {
  const { rows } = await client.query<RunRow>(
    `SELECT ${RUN_COLUMNS}
       FROM event_leaf_backfill_runs
      WHERE customer_id = $1
      ORDER BY created_at DESC
      LIMIT $2`,
    [customerId, limit],
  );
  return rows.map(mapRun);
}

/**
 * Request cancellation of a run. Sets the cooperative `cancel_requested`
 * flag the worker polls; a still-`pending` run with no claimed worker is
 * finalized to `cancelled` immediately. Returns the updated run, or null
 * if it does not exist / is already terminal.
 */
export async function requestCancel(
  client: PoolClient | Pool,
  customerId: string,
  runId: string,
  nowIso: string,
): Promise<BackfillRun | null> {
  const { rows } = await client.query<RunRow>(
    `UPDATE event_leaf_backfill_runs
        SET cancel_requested = TRUE,
            status = CASE WHEN status = 'pending' THEN 'cancelled' ELSE status END,
            finished_at = CASE WHEN status = 'pending' THEN $3::timestamptz ELSE finished_at END,
            last_progress_at = $3::timestamptz
      WHERE id = $1 AND customer_id = $2
        AND status IN ('pending', 'running')
      RETURNING ${RUN_COLUMNS}`,
    [runId, customerId, nowIso],
  );
  return rows[0] ? mapRun(rows[0]) : null;
}

/**
 * Atomically claim the oldest active (pending or running) run for the
 * worker, flipping it to `running` and stamping `started_at` on first
 * pickup. `FOR UPDATE SKIP LOCKED` keeps it safe under multiple replicas;
 * picking up a `running` run resumes one interrupted by a restart.
 */
export async function claimRun(
  client: PoolClient,
  nowIso: string,
): Promise<BackfillRun | null> {
  const { rows } = await client.query<RunRow>(
    `UPDATE event_leaf_backfill_runs r
        SET status = 'running',
            started_at = COALESCE(r.started_at, $1::timestamptz),
            last_progress_at = $1::timestamptz
      WHERE r.id = (
        SELECT id FROM event_leaf_backfill_runs
         WHERE status IN ('pending', 'running')
         ORDER BY created_at
         LIMIT 1
         FOR UPDATE SKIP LOCKED
      )
      RETURNING ${RUN_COLUMNS}`,
    [nowIso],
  );
  return rows[0] ? mapRun(rows[0]) : null;
}

/** Whether a run's cancel flag is set (cheap per-item poll). */
export async function isCancelRequested(
  client: PoolClient | Pool,
  runId: string,
): Promise<boolean> {
  const { rows } = await client.query<{ cancel_requested: boolean }>(
    `SELECT cancel_requested FROM event_leaf_backfill_runs WHERE id = $1`,
    [runId],
  );
  return rows[0]?.cancel_requested ?? false;
}

export interface PendingItem {
  aiceId: string;
  eventKey: string;
}

/** Fetch up to `limit` pending work items for a run, oldest first. */
export async function fetchPendingItems(
  client: PoolClient | Pool,
  runId: string,
  limit: number,
): Promise<PendingItem[]> {
  const { rows } = await client.query<{ aice_id: string; event_key: string }>(
    `SELECT aice_id, event_key::text AS event_key
       FROM event_leaf_backfill_items
      WHERE run_id = $1 AND status = 'pending'
      ORDER BY aice_id, event_key
      LIMIT $2`,
    [runId, limit],
  );
  return rows.map((r) => ({ aiceId: r.aice_id, eventKey: r.event_key }));
}

/** Count remaining pending items for a run. */
export async function countPending(
  client: PoolClient | Pool,
  runId: string,
): Promise<number> {
  const { rows } = await client.query<{ n: string }>(
    `SELECT COUNT(*)::text AS n
       FROM event_leaf_backfill_items
      WHERE run_id = $1 AND status = 'pending'`,
    [runId],
  );
  return Number(rows[0]?.n ?? "0");
}

const COUNT_COLUMN: Record<
  Exclude<ItemStatus, "pending">,
  keyof Pick<
    RunRow,
    | "reanalyzed_count"
    | "already_current_count"
    | "source_unavailable_count"
    | "failed_count"
    | "cap_excluded_count"
  >
> = {
  reanalyzed: "reanalyzed_count",
  already_current: "already_current_count",
  source_unavailable: "source_unavailable_count",
  failed: "failed_count",
  cap_excluded: "cap_excluded_count",
};

/**
 * Record a terminal status on an item and bump the matching run aggregate
 * count, in one transaction. `already_current` / `source_unavailable`
 * discovered DURING the drain (a leaf created or a source swept since
 * create-time materialization) are disjoint from the create-time aggregate
 * seed, so the bump never double-counts.
 */
export async function recordItemResult(
  client: PoolClient,
  runId: string,
  item: PendingItem,
  status: Exclude<ItemStatus, "pending">,
  nowIso: string,
  error?: string,
): Promise<void> {
  const countCol = COUNT_COLUMN[status];
  await client.query("BEGIN");
  try {
    await client.query(
      `UPDATE event_leaf_backfill_items
          SET status = $4, error = $5, updated_at = $6::timestamptz
        WHERE run_id = $1 AND aice_id = $2 AND event_key = $3::numeric`,
      [runId, item.aiceId, item.eventKey, status, error ?? null, nowIso],
    );
    await client.query(
      `UPDATE event_leaf_backfill_runs
          SET ${countCol} = ${countCol} + 1,
              last_progress_at = $2::timestamptz
        WHERE id = $1`,
      [runId, nowIso],
    );
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  }
}

/** Finalize a run to a terminal status. */
export async function finalizeRun(
  client: PoolClient | Pool,
  runId: string,
  status: Extract<RunStatus, "completed" | "cancelled" | "failed">,
  nowIso: string,
  errorMessage?: string,
): Promise<void> {
  await client.query(
    `UPDATE event_leaf_backfill_runs
        SET status = $2, finished_at = $3::timestamptz,
            last_progress_at = $3::timestamptz,
            error_message = COALESCE($4, error_message)
      WHERE id = $1`,
    [runId, status, nowIso, errorMessage ?? null],
  );
}
