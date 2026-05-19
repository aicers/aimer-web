import "server-only";

import type { Pool, PoolClient } from "pg";
import { auditLog } from "../audit";
import { getAuthPool } from "../db/client";
import { getCustomerRuntimePool } from "../db/customer-runtime-pool";
import { buildRedactionMapCascadeDelete } from "../redaction/cascade";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface DeletedByTable {
  detection_events: number;
  baseline_event: number;
  story: number;
  story_member: number;
  policy_run: number;
  policy_event: number;
  event_analysis_result: number;
  event_redaction_map: number;
}

export interface CustomerConnection {
  /**
   * Pg-compatible client for the customer DB. Must hold exactly one
   * backend connection for the lifetime of the tick so the
   * transaction-scoped advisory lock is bound to that connection.
   */
  query: PoolClient["query"];
  end: () => Promise<void>;
}

export interface SweepDeps {
  authPool: Pool;
  /**
   * Open a single customer-db connection. The caller is responsible
   * for calling `end()` to release it.
   */
  connectCustomer: (customerId: string) => Promise<CustomerConnection>;
  /**
   * Override `NOW()` for tests. Defaults to `new Date()`.
   */
  now?: () => Date;
}

export interface SweepCustomerOutcome {
  status: "completed" | "skipped_lock" | "failed";
  counts: DeletedByTable;
  cutoffIngestion: Date;
  cutoffAnalysis: Date | null;
  durationMs: number;
  errorMessage?: string;
}

interface PolicyJoinRow {
  customer_id: string;
  external_key: string;
  ingestion_days: number | null;
  analysis_days: number | null;
}

const SYSTEM_ACTOR = "system";
const DAY_MS = 24 * 60 * 60 * 1000;

function emptyCounts(): DeletedByTable {
  return {
    detection_events: 0,
    baseline_event: 0,
    story: 0,
    story_member: 0,
    policy_run: 0,
    policy_event: 0,
    event_analysis_result: 0,
    event_redaction_map: 0,
  };
}

// ---------------------------------------------------------------------------
// Per-customer sweep
// ---------------------------------------------------------------------------

/**
 * Run the customer-db transaction for one customer, with the policy
 * already loaded from `auth_db`. Audit emission timing follows the
 * spec in issue #255 §"Audit emission timing":
 *
 *   - `tick_started` is emitted after the advisory lock is acquired,
 *     before the first sweep query. If the lock is not acquired (a
 *     concurrent replica holds it) no `tick_started` row is written.
 *   - `tick_completed` is emitted after `COMMIT`, only when at least
 *     one row was deleted.
 *   - `tick_failed` is emitted after `ROLLBACK`, with the partial
 *     row counts accumulated up to the failure point. The audit
 *     write goes to the audit pool so it persists across the
 *     customer-db rollback.
 */
export async function sweepCustomer(
  customerId: string,
  policy: { ingestion_days: number; analysis_days: number | null },
  deps: SweepDeps,
  now: Date = new Date(),
): Promise<SweepCustomerOutcome> {
  const cutoffIngestion = new Date(
    now.getTime() - policy.ingestion_days * DAY_MS,
  );
  const cutoffAnalysis =
    policy.analysis_days == null
      ? null
      : new Date(now.getTime() - policy.analysis_days * DAY_MS);
  const counts = emptyCounts();
  const startedAt = Date.now();

  async function emitFailed(
    errorMessage: string,
  ): Promise<SweepCustomerOutcome> {
    await auditLog({
      actorId: SYSTEM_ACTOR,
      action: "retention_sweep.tick_failed",
      targetType: "customer",
      targetId: customerId,
      customerId,
      details: {
        customerId,
        error_message: errorMessage,
        partial_deleted_by_table: counts,
      },
    });
    return {
      status: "failed",
      counts,
      cutoffIngestion,
      cutoffAnalysis,
      durationMs: Date.now() - startedAt,
      errorMessage,
    };
  }

  // Connection failure happens before any transaction exists, so it
  // cannot be rolled back. Persist a `tick_failed` audit row anyway so
  // operators see the failure (e.g. customer DB is down) instead of
  // only stderr.
  let conn: CustomerConnection;
  try {
    conn = await deps.connectCustomer(customerId);
  } catch (err) {
    return emitFailed(err instanceof Error ? err.message : String(err));
  }

  // Track whether BEGIN succeeded so the catch block knows whether a
  // rollback is needed. A `BEGIN` failure leaves the session in its
  // default autocommit state; issuing ROLLBACK there would itself
  // raise `WARNING: there is no transaction in progress`.
  let beganTransaction = false;
  try {
    try {
      await conn.query("BEGIN");
      beganTransaction = true;

      // Transaction-scoped advisory lock keyed on the customer UUID.
      // Hash via `hashtextextended(..., 0)` so we get a single bigint
      // (the two-int form silently raises `integer out of range` for
      // about half of hashtextextended outputs — see
      // src/app/api/phase2/_shared/window-replace.ts:223).
      const lock = await conn.query<{ locked: boolean }>(
        `SELECT pg_try_advisory_xact_lock(
           hashtextextended(format('retention_sweep|%s', $1::text), 0)
         ) AS locked`,
        [customerId],
      );
      if (!lock.rows[0]?.locked) {
        await conn.query("ROLLBACK");
        return {
          status: "skipped_lock",
          counts,
          cutoffIngestion,
          cutoffAnalysis,
          durationMs: Date.now() - startedAt,
        };
      }

      await auditLog({
        actorId: SYSTEM_ACTOR,
        action: "retention_sweep.tick_started",
        targetType: "customer",
        targetId: customerId,
        customerId,
        details: {
          customerId,
          ingestion_days: policy.ingestion_days,
          analysis_days: policy.analysis_days,
          cutoff_ingestion: cutoffIngestion.toISOString(),
          cutoff_analysis: cutoffAnalysis?.toISOString() ?? null,
        },
      });

      // ------ detection_events (own created_at) ------
      const de = await conn.query(
        "DELETE FROM detection_events WHERE created_at < $1",
        [cutoffIngestion],
      );
      counts.detection_events = de.rowCount ?? 0;

      // ------ baseline_event (own received_at) ------
      const be = await conn.query(
        "DELETE FROM baseline_event WHERE received_at < $1",
        [cutoffIngestion],
      );
      counts.baseline_event = be.rowCount ?? 0;

      // ------ story + story_member (CASCADE) ------
      // Lock parents in PK order so concurrent ingestion that
      // INSERTs a child of a soon-to-be-deleted story blocks on the
      // FK parent row-lock until our transaction commits/rolls back.
      // That makes the child COUNT exact.
      await conn.query(
        `SELECT story_id, story_version
           FROM story
          WHERE received_at < $1
          ORDER BY story_id, story_version
          FOR UPDATE`,
        [cutoffIngestion],
      );
      const memberCount = await conn.query<{ c: number }>(
        `SELECT COUNT(*)::int AS c
           FROM story_member sm
           JOIN story s ON s.story_id = sm.story_id
                       AND s.story_version = sm.story_version
          WHERE s.received_at < $1`,
        [cutoffIngestion],
      );
      counts.story_member = memberCount.rows[0]?.c ?? 0;
      const st = await conn.query("DELETE FROM story WHERE received_at < $1", [
        cutoffIngestion,
      ]);
      counts.story = st.rowCount ?? 0;

      // ------ policy_run + policy_event (CASCADE) ------
      await conn.query(
        `SELECT run_id
           FROM policy_run
          WHERE received_at < $1
          ORDER BY run_id
          FOR UPDATE`,
        [cutoffIngestion],
      );
      const peCount = await conn.query<{ c: number }>(
        `SELECT COUNT(*)::int AS c
           FROM policy_event pe
           JOIN policy_run pr ON pr.run_id = pe.run_id
          WHERE pr.received_at < $1`,
        [cutoffIngestion],
      );
      counts.policy_event = peCount.rows[0]?.c ?? 0;
      const pr = await conn.query(
        "DELETE FROM policy_run WHERE received_at < $1",
        [cutoffIngestion],
      );
      counts.policy_run = pr.rowCount ?? 0;

      // ------ event_analysis_result (NULL analysis_days = unlimited) ------
      if (cutoffAnalysis) {
        const ar = await conn.query(
          "DELETE FROM event_analysis_result WHERE requested_at < $1",
          [cutoffAnalysis],
        );
        counts.event_analysis_result = ar.rowCount ?? 0;
      }

      // ------ event_redaction_map cascade ------
      // The cascade existence predicate (the four NOT EXISTS clauses
      // across redacted-referent tables plus event_analysis_result)
      // and the deterministic FOR UPDATE order are owned by the
      // redaction module so the staleness scan in #253 cannot drift
      // out of sync with this pass — both call the same builder.
      const mapResult = await conn.query(buildRedactionMapCascadeDelete());
      counts.event_redaction_map = mapResult.rowCount ?? 0;

      await conn.query("COMMIT");
    } catch (err) {
      if (beganTransaction) {
        await conn.query("ROLLBACK").catch(() => {});
      }
      return emitFailed(err instanceof Error ? err.message : String(err));
    }

    const durationMs = Date.now() - startedAt;
    const totalDeleted = Object.values(counts).reduce((a, b) => a + b, 0);
    if (totalDeleted > 0) {
      await auditLog({
        actorId: SYSTEM_ACTOR,
        action: "retention_sweep.tick_completed",
        targetType: "customer",
        targetId: customerId,
        customerId,
        details: {
          customerId,
          deleted_by_table: counts,
          duration_ms: durationMs,
        },
      });
    }
    return {
      status: "completed",
      counts,
      cutoffIngestion,
      cutoffAnalysis,
      durationMs,
    };
  } finally {
    await conn.end().catch(() => {});
  }
}

// ---------------------------------------------------------------------------
// Per-tick driver
// ---------------------------------------------------------------------------

/**
 * Read the customers × retention-policy join from `auth_db` and run
 * one sweep per active customer.
 *
 * A customer with `database_status != 'active'` is skipped silently —
 * no audit emission, no customer-db connection attempt. An active
 * customer with no matching `customer_retention_policy` row (LEFT
 * JOIN produces NULL columns) is treated as a foundation-bug
 * exception per #255: a `tick_failed` row with
 * `error_message = 'missing_retention_policy'` is emitted and the
 * worker continues to the next customer without opening that
 * customer's DB.
 */
export async function runRetentionTick(deps: SweepDeps): Promise<void> {
  const now = deps.now ? deps.now() : new Date();
  const rows = await deps.authPool.query<PolicyJoinRow>(
    `SELECT c.id AS customer_id,
            c.external_key,
            crp.ingestion_days,
            crp.analysis_days
       FROM customers c
       LEFT JOIN customer_retention_policy crp ON crp.customer_id = c.id
      WHERE c.database_status = 'active'
      ORDER BY c.id`,
  );

  for (const row of rows.rows) {
    if (row.ingestion_days == null) {
      await auditLog({
        actorId: SYSTEM_ACTOR,
        action: "retention_sweep.tick_failed",
        targetType: "customer",
        targetId: row.customer_id,
        customerId: row.customer_id,
        details: {
          customerId: row.customer_id,
          error_message: "missing_retention_policy",
          partial_deleted_by_table: {},
        },
      });
      continue;
    }
    try {
      await sweepCustomer(
        row.customer_id,
        {
          ingestion_days: row.ingestion_days,
          analysis_days: row.analysis_days,
        },
        deps,
        now,
      );
    } catch (err) {
      // sweepCustomer converts every in-transaction failure (including
      // connect, BEGIN, and lock-query failures) into a `failed`
      // outcome with a persisted `tick_failed` audit row. Reaching
      // here means the audit write itself threw; log but keep
      // iterating so one customer's failure cannot stall the rest.
      console.error(
        `[retention] sweep aborted for customer ${row.customer_id}:`,
        err,
      );
    }
  }
}

// ---------------------------------------------------------------------------
// Default production deps
// ---------------------------------------------------------------------------

async function defaultConnectCustomer(
  customerId: string,
): Promise<CustomerConnection> {
  // The issue requires the customer-db transaction to run via a
  // dedicated `PoolClient` from the per-customer runtime pool. Phase 2
  // ingest routes already resolve their writes through
  // `getCustomerRuntimePool`; the sweeper joins the same path so it
  // inherits the pool's role binding (`aimer_customer`), connection
  // recycling, and process-local connection limit.
  const pool = getCustomerRuntimePool(customerId);
  const client = await pool.connect();
  return {
    query: client.query.bind(client) as PoolClient["query"],
    end: async () => {
      client.release();
    },
  };
}

function defaultDeps(): SweepDeps {
  return {
    authPool: getAuthPool(),
    connectCustomer: defaultConnectCustomer,
  };
}

// ---------------------------------------------------------------------------
// Worker installer (idempotent across hot-reload, per process)
// ---------------------------------------------------------------------------

const SWEEPER_SLOT = Symbol.for("aimer.retention.sweeper");

interface SweeperSlot {
  timer: NodeJS.Timeout | null;
  intervalMs: number | null;
}

type GlobalWithSweeperSlot = typeof globalThis & {
  [SWEEPER_SLOT]?: SweeperSlot;
};

function getSlot(): SweeperSlot {
  const g = globalThis as GlobalWithSweeperSlot;
  let slot = g[SWEEPER_SLOT];
  if (!slot) {
    slot = { timer: null, intervalMs: null };
    g[SWEEPER_SLOT] = slot;
  }
  return slot;
}

const DEFAULT_INTERVAL_MS = 60 * 60 * 1000;

function resolveIntervalMs(): number {
  const raw = process.env.RETENTION_SWEEP_INTERVAL_MS;
  if (raw == null || raw === "") return DEFAULT_INTERVAL_MS;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) {
    console.warn(
      `[retention] invalid RETENTION_SWEEP_INTERVAL_MS=${raw}, falling back to ${DEFAULT_INTERVAL_MS}`,
    );
    return DEFAULT_INTERVAL_MS;
  }
  return n;
}

export function installRetentionSweeper(deps?: SweepDeps): void {
  const slot = getSlot();
  if (slot.timer) return;
  const intervalMs = resolveIntervalMs();
  const resolved = deps;
  const tick = () => {
    const sweepDeps = resolved ?? defaultDeps();
    runRetentionTick(sweepDeps).catch((err) => {
      console.error("[retention] tick failed:", err);
    });
  };
  slot.timer = setInterval(tick, intervalMs);
  slot.intervalMs = intervalMs;
  if (typeof slot.timer.unref === "function") slot.timer.unref();
}

export function uninstallRetentionSweeper(): void {
  const slot = getSlot();
  if (slot.timer) {
    clearInterval(slot.timer);
    slot.timer = null;
    slot.intervalMs = null;
  }
}
