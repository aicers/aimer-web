// RFC 0002 Phase 0 (#294) — analysis job worker skeleton.
//
// Modeled on `redaction-job-worker.ts` but intentionally minimal.
// Phase 0 is a no-LLM skeleton — the worker only:
//
//   1. Walks `story_analysis_state` rows in `pending` and flips them to
//      `ready` once the RFC 0002 §"Story readiness" rule holds.
//   2. For every `ready` or `dirty` state row, ensures a
//      `story_analysis_job` row exists for the default
//      `(lang, model_name, model)` variant. The job row is inserted as
//      `status='queued', dry_run=TRUE, generation=1` (or generation++
//      for an existing dirty re-queue), then immediately flipped to
//      `done` with `last_generated_at=NOW()` — no LLM call.
//   3. Same for `periodic_report_state` LIVE rows (DAILY/WEEKLY/MONTHLY
//      seeding lands in Phase 2 / 3 alongside the real workers).
//   4. Boot-time recovery flips any orphaned `processing` jobs back to
//      `queued`.
//
// Persisting real `*_analysis_job` rows lets the 48h verification gate
// observe dirty transitions (issue #294 decision 3). `dry_run=TRUE`
// rows are not counted against `ANALYSIS_MAX_GENERATION` (Phase 1
// concern; the cap is enforced by the real worker once it lands).
//
// Phase 1 (#296) deletes any leftover `dry_run=TRUE` rows in its own
// migration before enabling LLM calls.

import "server-only";

import type { Pool, PoolClient } from "pg";
import { isStoryReady, LIVE_BUCKET_DATE } from "../analysis/state";
import { getAuthPool } from "../db/client";

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const DEFAULT_POLL_INTERVAL_MS = 30_000;
const DEFAULT_BATCH_SIZE = 100;

const POLL_INTERVAL_MS = resolveInt(
  process.env.ANALYSIS_JOB_POLL_INTERVAL_MS,
  DEFAULT_POLL_INTERVAL_MS,
);
const BATCH_SIZE = resolveInt(
  process.env.ANALYSIS_JOB_BATCH_SIZE,
  DEFAULT_BATCH_SIZE,
);

// Default variant — matches the RFC 0002 §"Force regenerate" defaults
// (`ANALYSIS_DEFAULT_LANG` / `_MODEL_NAME` / `_MODEL`). Phase 1 wires
// the real defaults from environment; Phase 0 keeps a deterministic
// stand-in so test fixtures are predictable.
const DEFAULT_LANG = process.env.ANALYSIS_DEFAULT_LANG ?? "ENGLISH";
const DEFAULT_MODEL_NAME = process.env.ANALYSIS_DEFAULT_MODEL_NAME ?? "openai";
const DEFAULT_MODEL = process.env.ANALYSIS_DEFAULT_MODEL ?? "gpt-4o";

function resolveInt(raw: string | undefined, fallback: number): number {
  if (!raw) return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}

// ---------------------------------------------------------------------------
// State worker — story
// ---------------------------------------------------------------------------

interface StoryStateRow {
  customer_id: string;
  story_id: string;
  status: "pending" | "ready" | "dirty";
  first_member_at: Date | null;
  last_member_at: Date | null;
}

async function tickStoryStates(client: PoolClient, now: Date): Promise<void> {
  // 1. Flip ready-eligible pending rows.
  const { rows: pending } = await client.query<StoryStateRow>(
    `SELECT customer_id::text  AS customer_id,
            story_id::text     AS story_id,
            status,
            first_member_at,
            last_member_at
       FROM story_analysis_state
      WHERE status = 'pending'
      ORDER BY customer_id, story_id
      LIMIT $1`,
    [BATCH_SIZE],
  );
  for (const row of pending) {
    if (
      isStoryReady(now, row.first_member_at ?? null, row.last_member_at ?? null)
    ) {
      await client.query(
        `UPDATE story_analysis_state
            SET status = 'ready',
                last_ready_at = NOW(),
                updated_at = NOW()
          WHERE customer_id = $1 AND story_id = $2::bigint
            AND status = 'pending'`,
        [row.customer_id, row.story_id],
      );
    }
  }

  // 2. For every ready/dirty state row, ensure a queued job exists for
  //    the default variant; immediately mark it done with dry_run=TRUE.
  const { rows: actionable } = await client.query<StoryStateRow>(
    `SELECT customer_id::text AS customer_id,
            story_id::text    AS story_id,
            status,
            first_member_at,
            last_member_at
       FROM story_analysis_state
      WHERE status IN ('ready', 'dirty')
      ORDER BY customer_id, story_id
      LIMIT $1`,
    [BATCH_SIZE],
  );
  for (const row of actionable) {
    await dispatchStoryDryRunJob(client, row);
  }
}

async function dispatchStoryDryRunJob(
  client: PoolClient,
  row: StoryStateRow,
): Promise<void> {
  // Ready: ensure a job exists. Dirty: bump generation on the existing
  // job. Splitting the two cases avoids an ON-CONFLICT WHERE clause
  // that under-fires when EXCLUDED.generation is always 1.
  if (row.status === "dirty") {
    await client.query(
      `UPDATE story_analysis_job
          SET generation = generation + 1,
              status = 'done',
              dry_run = TRUE,
              processing_started_at = NOW(),
              last_generated_at = NOW(),
              last_error = NULL,
              updated_at = NOW()
        WHERE customer_id = $1 AND story_id = $2::bigint
          AND lang = $3 AND model_name = $4 AND model = $5`,
      [
        row.customer_id,
        row.story_id,
        DEFAULT_LANG,
        DEFAULT_MODEL_NAME,
        DEFAULT_MODEL,
      ],
    );
    await client.query(
      `UPDATE story_analysis_state
          SET status = 'ready', last_ready_at = NOW(), updated_at = NOW()
        WHERE customer_id = $1 AND story_id = $2::bigint AND status = 'dirty'`,
      [row.customer_id, row.story_id],
    );
    return;
  }
  await client.query(
    `INSERT INTO story_analysis_job
       (customer_id, story_id, lang, model_name, model,
        status, generation, dry_run,
        processing_started_at, last_generated_at)
     VALUES ($1, $2::bigint, $3, $4, $5,
             'done', 1, TRUE,
             NOW(), NOW())
     ON CONFLICT (customer_id, story_id, lang, model_name, model)
     DO NOTHING`,
    [
      row.customer_id,
      row.story_id,
      DEFAULT_LANG,
      DEFAULT_MODEL_NAME,
      DEFAULT_MODEL,
    ],
  );
}

// ---------------------------------------------------------------------------
// State worker — periodic report (LIVE only in Phase 0)
// ---------------------------------------------------------------------------

interface PeriodicStateRow {
  customer_id: string;
  period: "LIVE" | "DAILY" | "WEEKLY" | "MONTHLY";
  bucket_date: string;
  tz: string;
  status: "pending" | "ready" | "dirty";
}

async function tickPeriodicStates(client: PoolClient): Promise<void> {
  // Pending LIVE rows are ready on creation (RFC 0002 §"Periodic
  // report readiness"). Pending DAILY/WEEKLY/MONTHLY rows have a more
  // complex readiness rule that this Phase 0 worker does not implement
  // — those are Phase 2 / Phase 3 concerns. We still flip pending →
  // ready for any LIVE rows that slipped through (the ingest hook
  // creates them as `ready` directly).
  await client.query(
    `UPDATE periodic_report_state
        SET status = 'ready', last_ready_at = NOW(), updated_at = NOW()
      WHERE status = 'pending'
        AND period  = 'LIVE'
        AND bucket_date = $1::date`,
    [LIVE_BUCKET_DATE],
  );

  const { rows: actionable } = await client.query<PeriodicStateRow>(
    `SELECT customer_id::text AS customer_id,
            period, bucket_date::text AS bucket_date, tz, status
       FROM periodic_report_state
      WHERE status IN ('ready', 'dirty')
      ORDER BY customer_id, period, bucket_date, tz
      LIMIT $1`,
    [BATCH_SIZE],
  );
  for (const row of actionable) {
    await dispatchPeriodicDryRunJob(client, row);
  }
}

async function dispatchPeriodicDryRunJob(
  client: PoolClient,
  row: PeriodicStateRow,
): Promise<void> {
  if (row.status === "dirty") {
    await client.query(
      `UPDATE periodic_report_job
          SET generation = generation + 1,
              status = 'done',
              dry_run = TRUE,
              processing_started_at = NOW(),
              last_generated_at = NOW(),
              last_error = NULL,
              updated_at = NOW()
        WHERE customer_id = $1
          AND period = $2 AND bucket_date = $3::date AND tz = $4
          AND lang = $5 AND model_name = $6 AND model = $7`,
      [
        row.customer_id,
        row.period,
        row.bucket_date,
        row.tz,
        DEFAULT_LANG,
        DEFAULT_MODEL_NAME,
        DEFAULT_MODEL,
      ],
    );
    await client.query(
      `UPDATE periodic_report_state
          SET status = 'ready', last_ready_at = NOW(), updated_at = NOW()
        WHERE customer_id = $1
          AND period = $2
          AND bucket_date = $3::date
          AND tz = $4
          AND status = 'dirty'`,
      [row.customer_id, row.period, row.bucket_date, row.tz],
    );
    return;
  }
  await client.query(
    `INSERT INTO periodic_report_job
       (customer_id, period, bucket_date, tz,
        lang, model_name, model,
        status, generation, dry_run,
        processing_started_at, last_generated_at)
     VALUES ($1, $2, $3::date, $4,
             $5, $6, $7,
             'done', 1, TRUE,
             NOW(), NOW())
     ON CONFLICT (customer_id, period, bucket_date, tz, lang, model_name, model)
     DO NOTHING`,
    [
      row.customer_id,
      row.period,
      row.bucket_date,
      row.tz,
      DEFAULT_LANG,
      DEFAULT_MODEL_NAME,
      DEFAULT_MODEL,
    ],
  );
}

// ---------------------------------------------------------------------------
// Boot-time recovery
// ---------------------------------------------------------------------------

/**
 * Flip any `processing` job rows back to `queued`. The Phase 0 worker
 * does not actually run in `processing` (it transitions queued → done
 * inline), but recovery is harmless and matches the redaction-worker
 * pattern so the Phase 1 worker has a working recovery path from day
 * one.
 */
async function runRecovery(authPool: Pool): Promise<void> {
  await authPool.query(
    `UPDATE story_analysis_job
        SET status = 'queued', processing_started_at = NULL, updated_at = NOW()
      WHERE status = 'processing'`,
  );
  await authPool.query(
    `UPDATE periodic_report_job
        SET status = 'queued', processing_started_at = NULL, updated_at = NOW()
      WHERE status = 'processing'`,
  );
}

// ---------------------------------------------------------------------------
// Tick + installer
// ---------------------------------------------------------------------------

export async function runAnalysisJobTickOnce(authPool?: Pool): Promise<void> {
  const pool = authPool ?? getAuthPool();
  const now = new Date();
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await tickStoryStates(client, now);
    await tickPeriodicStates(client);
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

const WORKER_SLOT = Symbol.for("aimer.analysis.jobWorker");

interface WorkerSlot {
  timer: NodeJS.Timeout | null;
  inFlight: boolean;
  installing: Promise<void> | null;
}

type GlobalWithWorkerSlot = typeof globalThis & {
  [WORKER_SLOT]?: WorkerSlot;
};

function getSlot(): WorkerSlot {
  const g = globalThis as GlobalWithWorkerSlot;
  let slot = g[WORKER_SLOT];
  if (!slot) {
    slot = { timer: null, inFlight: false, installing: null };
    g[WORKER_SLOT] = slot;
  }
  return slot;
}

export async function installAnalysisJobWorker(authPool?: Pool): Promise<void> {
  const slot = getSlot();
  if (slot.timer) return;
  if (slot.installing) {
    await slot.installing;
    return;
  }
  const pool = authPool ?? getAuthPool();
  const installRun = (async () => {
    await runRecovery(pool).catch((err) => {
      console.error("[analysis-job] recovery failed:", err);
    });
    const tick = () => {
      if (slot.inFlight) return;
      slot.inFlight = true;
      runAnalysisJobTickOnce(pool)
        .catch((err) => {
          console.error("[analysis-job] tick failed:", err);
        })
        .finally(() => {
          slot.inFlight = false;
        });
    };
    slot.timer = setInterval(tick, POLL_INTERVAL_MS);
    if (typeof slot.timer.unref === "function") slot.timer.unref();
  })();
  slot.installing = installRun;
  try {
    await installRun;
  } finally {
    slot.installing = null;
  }
}

export function uninstallAnalysisJobWorker(): void {
  const slot = getSlot();
  if (slot.timer) {
    clearInterval(slot.timer);
    slot.timer = null;
  }
}

export const __testables = {
  runRecovery,
  tickStoryStates,
  tickPeriodicStates,
};
