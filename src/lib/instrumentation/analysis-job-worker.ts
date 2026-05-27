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
import {
  DEFAULT_REPORT_IDLE_QUIET_MINUTES,
  DEFAULT_REPORT_SETTLE_HOURS_DAILY,
  DEFAULT_REPORT_SETTLE_HOURS_MONTHLY,
  DEFAULT_REPORT_SETTLE_HOURS_WEEKLY,
  DEFAULT_STORY_IDLE_MINUTES,
  DEFAULT_STORY_MAX_WAIT_HOURS,
  LIVE_BUCKET_DATE,
} from "../analysis/state";
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

async function tickStoryStates(client: PoolClient): Promise<void> {
  // Row-claiming pickup. Both pending and ready/dirty batches use
  // `FOR UPDATE SKIP LOCKED` so multiple worker replicas cannot pick
  // the same state row in the same tick. The surrounding BEGIN/COMMIT
  // (see `runAnalysisJobTickOnce`) holds the row lock for the whole
  // tick; the second replica skips locked rows entirely. Matches the
  // RFC 0002 §"Worker structure" requirement and the redaction-job-
  // worker pattern (`src/lib/instrumentation/redaction-job-worker.ts`).

  // 1. Flip ready-eligible pending rows. The readiness rule is pushed
  //    down into SQL so non-ready pending rows do not occupy a slot in
  //    the LIMIT batch — otherwise the first N pending rows that are
  //    not yet ready would block every tick from inspecting any pending
  //    row beyond position N (round-2 starvation review).
  const { rows: pending } = await client.query<StoryStateRow>(
    `SELECT customer_id::text  AS customer_id,
            story_id::text     AS story_id,
            status,
            first_member_at,
            last_member_at
       FROM story_analysis_state
      WHERE status = 'pending'
        AND (
          (last_member_at  IS NOT NULL
            AND last_member_at  <= NOW() - ($2 || ' minutes')::interval)
          OR (first_member_at IS NOT NULL
            AND first_member_at <= NOW() - ($3 || ' hours')::interval)
        )
      ORDER BY customer_id, story_id
      LIMIT $1
      FOR UPDATE SKIP LOCKED`,
    [BATCH_SIZE, DEFAULT_STORY_IDLE_MINUTES, DEFAULT_STORY_MAX_WAIT_HOURS],
  );
  for (const row of pending) {
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

  // 2. For every actionable state row, ensure a queued job exists for
  //    the default variant; immediately mark it done with dry_run=TRUE.
  //    Two filters in addition to `FOR UPDATE SKIP LOCKED`:
  //
  //    (a) Filter ready rows to those still missing the default-variant
  //        job. Without this, a ready row that already has its dry-run
  //        job is reselected forever and blocks slots behind it from
  //        ever receiving their first job (round-2 starvation review).
  //    (b) Always include dirty rows — the dispatcher bumps generation
  //        and flips them back to ready, so they drop out next tick.
  //
  //    `FOR UPDATE SKIP LOCKED` is the multi-replica guard: without it,
  //    two replicas could each read the same dirty row and each issue
  //    `UPDATE story_analysis_job SET generation = generation + 1`,
  //    double-incrementing the generation for one source change.
  const { rows: actionable } = await client.query<StoryStateRow>(
    `SELECT s.customer_id::text AS customer_id,
            s.story_id::text    AS story_id,
            s.status,
            s.first_member_at,
            s.last_member_at
       FROM story_analysis_state s
      WHERE s.status = 'dirty'
         OR (s.status = 'ready'
             AND NOT EXISTS (
               SELECT 1 FROM story_analysis_job j
                WHERE j.customer_id = s.customer_id
                  AND j.story_id    = s.story_id
                  AND j.lang        = $2
                  AND j.model_name  = $3
                  AND j.model       = $4
             ))
      ORDER BY s.customer_id, s.story_id
      LIMIT $1
      FOR UPDATE SKIP LOCKED`,
    [BATCH_SIZE, DEFAULT_LANG, DEFAULT_MODEL_NAME, DEFAULT_MODEL],
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
  // report readiness"). The ingest hook normally inserts them as
  // `ready` directly; this catches any that slipped through (e.g. a
  // reconcile seed).
  await client.query(
    `UPDATE periodic_report_state
        SET status = 'ready', last_ready_at = NOW(), updated_at = NOW()
      WHERE status = 'pending'
        AND period  = 'LIVE'
        AND bucket_date = $1::date`,
    [LIVE_BUCKET_DATE],
  );

  // Pending DAILY/WEEKLY/MONTHLY rows become ready once their bucket
  // is fully closed AND the settle window has elapsed AND there has
  // been no ingest activity for `ANALYSIS_IDLE_QUIET_MINUTES` (RFC 0002
  // §"Periodic report readiness"). Without this, historical buckets
  // seeded by the reconcile scan after a hook failure (round-3 review
  // item 2) would remain `pending` forever and never produce a Phase 0
  // dry-run job, breaking the verification gate's "no stuck-pending
  // state rows" requirement.
  //
  // The quiet-window gate (round-7 review item 1) uses `updated_at` as
  // the ingest-activity proxy: the ingest hooks (`recordBaselineActivity`)
  // and the reconcile forward-patch path both write `updated_at = NOW()`,
  // so a still-active backfill keeps the row from being promoted before
  // the batch settles. Without this gate, a historical bucket seeded or
  // forward-patched by a just-finished reconcile/backfill could be
  // promoted and dry-run-jobbed immediately even though ingest activity
  // just occurred.
  //
  // The readiness rule is pushed into SQL so we don't have to fetch
  // every pending row into JS just to filter most of them out. Bucket
  // end is `bucket_date + 1 period` interpreted at the customer tz
  // (the bucket was derived in that tz). NOW() is UTC; converting the
  // wall-clock end via `AT TIME ZONE tz` yields the same UTC instant
  // we want to compare against.
  await client.query(
    `UPDATE periodic_report_state
        SET status        = 'ready',
            last_ready_at = NOW(),
            updated_at    = NOW()
      WHERE status = 'pending'
        AND period IN ('DAILY', 'WEEKLY', 'MONTHLY')
        AND updated_at <= NOW() - ($4 || ' minutes')::interval
        AND (
          (period = 'DAILY'
           AND ((bucket_date + INTERVAL '1 day')::timestamp AT TIME ZONE tz)
               + ($1 || ' hours')::interval <= NOW())
          OR (period = 'WEEKLY'
              AND ((bucket_date + INTERVAL '7 days')::timestamp AT TIME ZONE tz)
                  + ($2 || ' hours')::interval <= NOW())
          OR (period = 'MONTHLY'
              AND ((bucket_date + INTERVAL '1 month')::timestamp AT TIME ZONE tz)
                  + ($3 || ' hours')::interval <= NOW())
        )`,
    [
      DEFAULT_REPORT_SETTLE_HOURS_DAILY,
      DEFAULT_REPORT_SETTLE_HOURS_WEEKLY,
      DEFAULT_REPORT_SETTLE_HOURS_MONTHLY,
      DEFAULT_REPORT_IDLE_QUIET_MINUTES,
    ],
  );

  // FOR UPDATE SKIP LOCKED here mirrors the story tick — two replicas
  // racing on the same dirty periodic state row would otherwise both
  // increment `periodic_report_job.generation`.
  //
  // Filter ready rows to those missing the default-variant job for the
  // same reason as the story side: a ready row that already has its
  // dry-run job would otherwise be reselected forever and block slots
  // behind it from ever receiving a first job.
  const { rows: actionable } = await client.query<PeriodicStateRow>(
    `SELECT s.customer_id::text AS customer_id,
            s.period,
            s.bucket_date::text AS bucket_date,
            s.tz,
            s.status
       FROM periodic_report_state s
      WHERE s.status = 'dirty'
         OR (s.status = 'ready'
             AND NOT EXISTS (
               SELECT 1 FROM periodic_report_job j
                WHERE j.customer_id  = s.customer_id
                  AND j.period       = s.period
                  AND j.bucket_date  = s.bucket_date
                  AND j.tz           = s.tz
                  AND j.lang         = $2
                  AND j.model_name   = $3
                  AND j.model        = $4
             ))
      ORDER BY s.customer_id, s.period, s.bucket_date, s.tz
      LIMIT $1
      FOR UPDATE SKIP LOCKED`,
    [BATCH_SIZE, DEFAULT_LANG, DEFAULT_MODEL_NAME, DEFAULT_MODEL],
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
// Boot-time recovery + queued-drain
// ---------------------------------------------------------------------------

/**
 * Drain `queued` + `dry_run=TRUE` job rows to `done`. Phase 0 inserts
 * job rows directly as `status='done', dry_run=TRUE`, so under normal
 * operation no queued dry-run rows ever exist. Two paths can still
 * produce them:
 *
 *   (a) Boot-time recovery flips orphaned `processing` rows back to
 *       `queued` (matches the redaction-worker pattern so the Phase 1
 *       worker has a working recovery path from day one). The normal
 *       state-row pickup is keyed on `NOT EXISTS (default-variant
 *       job)`, so a recovered queued row blocks its state row from
 *       ever being re-selected — the queued row would stay queued
 *       forever (round-10 review item 1).
 *   (b) Any out-of-band write (test fixture, manual DB edit, leftover
 *       row from a prior deployment).
 *
 * The drain is dry-run-only — Phase 1 (#296) will have its own real
 * queued-job dispatcher and must not see Phase 0's drain step touch
 * its rows.
 */
async function drainQueuedDryRunJobs(client: PoolClient): Promise<void> {
  await client.query(
    `UPDATE story_analysis_job
        SET status = 'done',
            processing_started_at = COALESCE(processing_started_at, NOW()),
            last_generated_at = NOW(),
            last_error = NULL,
            updated_at = NOW()
      WHERE status = 'queued'
        AND dry_run = TRUE`,
  );
  await client.query(
    `UPDATE periodic_report_job
        SET status = 'done',
            processing_started_at = COALESCE(processing_started_at, NOW()),
            last_generated_at = NOW(),
            last_error = NULL,
            updated_at = NOW()
      WHERE status = 'queued'
        AND dry_run = TRUE`,
  );
}

/**
 * Flip any `processing` job rows back to `queued`. The Phase 0 worker
 * does not actually run in `processing` (it transitions queued → done
 * inline), but recovery is harmless and matches the redaction-worker
 * pattern so the Phase 1 worker has a working recovery path from day
 * one. The tick's `drainQueuedDryRunJobs` pass then completes any
 * `dry_run=TRUE` rows recovery just re-queued, so a stuck-processing
 * Phase 0 row drains to `done` in the very next tick rather than
 * stalling forever behind the state-row pickup's `NOT EXISTS` filter
 * (round-10 review item 1).
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
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await drainQueuedDryRunJobs(client);
    await tickStoryStates(client);
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
  drainQueuedDryRunJobs,
  runRecovery,
  tickStoryStates,
  tickPeriodicStates,
};
