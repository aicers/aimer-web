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
//
// Time seam (#326): every time-dependent SQL predicate inside this
// worker uses `$n::timestamptz` bind parameters whose value is sourced
// from `getCurrentTimestamp()` in JS, NOT inline SQL `NOW()`. The tick
// captures `nowIso` once at entry and threads it through every sub-call
// so all rows touched in one tick share one "now" — and tests can
// advance the mocked clock between ticks for deterministic state-
// machine assertions. SQL `NOW()` calls inside ingest hooks / `state.ts`
// are out of scope — those run inside the customer-DB write transaction
// and are stamped at ingest, not consulted as a comparator.

import "server-only";

import type { Pool, PoolClient } from "pg";
import {
  DEFAULT_REPORT_IDLE_QUIET_MINUTES,
  DEFAULT_REPORT_SETTLE_HOURS_DAILY,
  DEFAULT_REPORT_SETTLE_HOURS_DAILY_WITH_WATERMARK,
  DEFAULT_REPORT_SETTLE_HOURS_MONTHLY,
  DEFAULT_REPORT_SETTLE_HOURS_WEEKLY,
  DEFAULT_STORY_IDLE_MINUTES,
  DEFAULT_STORY_MAX_WAIT_HOURS,
  LIVE_BUCKET_DATE,
} from "../analysis/state";
import {
  recoverStuckStoryJobs,
  seedRealStoryJobs,
  tickStoryJobsOnce,
} from "../analysis/story-worker";
import { getAuthPool } from "../db/client";
import { getCurrentTimestamp } from "./time";

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

// RFC 0002 Phase 0.5 (#295) — read-at-tick-time settle env vars so
// tests and dev environments can override the defaults without
// reloading the process. The two-knob model: `ANALYSIS_SETTLE_HOURS_DAILY`
// (default 3h) is the baseline; `ANALYSIS_SETTLE_HOURS_DAILY_WITH_WATERMARK`
// (default 1h) is used when a strict cursor watermark covers the
// bucket end (decision 4). Soft watermarks and missing watermarks both
// fall back to the baseline.
function resolveDailySettleHours(): number {
  return resolveInt(
    process.env.ANALYSIS_SETTLE_HOURS_DAILY,
    DEFAULT_REPORT_SETTLE_HOURS_DAILY,
  );
}

function resolveDailySettleHoursWithWatermark(): number {
  return resolveInt(
    process.env.ANALYSIS_SETTLE_HOURS_DAILY_WITH_WATERMARK,
    DEFAULT_REPORT_SETTLE_HOURS_DAILY_WITH_WATERMARK,
  );
}

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

async function tickStoryStates(
  client: PoolClient,
  nowIso: string,
): Promise<void> {
  // Phase 1 (#296) — real LLM seeding. Pending → ready promotion stays
  // here (the rule is RFC 0002 §"Story readiness", independent of the
  // dry-run vs real distinction). The "ensure a job row exists for the
  // default variant" pass moves to `seedRealStoryJobs` so it can write
  // `dry_run=FALSE` rows that the LLM-calling tick picks up.
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
            AND last_member_at  <= $4::timestamptz - ($2 || ' minutes')::interval)
          OR (first_member_at IS NOT NULL
            AND first_member_at <= $4::timestamptz - ($3 || ' hours')::interval)
        )
      ORDER BY customer_id, story_id
      LIMIT $1
      FOR UPDATE SKIP LOCKED`,
    [
      BATCH_SIZE,
      DEFAULT_STORY_IDLE_MINUTES,
      DEFAULT_STORY_MAX_WAIT_HOURS,
      nowIso,
    ],
  );
  for (const row of pending) {
    await client.query(
      `UPDATE story_analysis_state
          SET status = 'ready',
              last_ready_at = $3::timestamptz,
              updated_at = $3::timestamptz
        WHERE customer_id = $1 AND story_id = $2::bigint
          AND status = 'pending'`,
      [row.customer_id, row.story_id, nowIso],
    );
  }

  // 2. Seed real (non-dry-run) `queued` jobs for every actionable
  //    state row. See `seedRealStoryJobs` for the same NOT-EXISTS /
  //    SKIP-LOCKED rules previously inlined here.
  await seedRealStoryJobs(client, BATCH_SIZE);
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

async function tickPeriodicStates(
  client: PoolClient,
  nowIso: string,
): Promise<void> {
  // Pending LIVE rows are ready on creation (RFC 0002 §"Periodic
  // report readiness"). The ingest hook normally inserts them as
  // `ready` directly; this catches any that slipped through (e.g. a
  // reconcile seed).
  await client.query(
    `UPDATE periodic_report_state
        SET status = 'ready',
            last_ready_at = $2::timestamptz,
            updated_at = $2::timestamptz
      WHERE status = 'pending'
        AND period  = 'LIVE'
        AND bucket_date = $1::date`,
    [LIVE_BUCKET_DATE, nowIso],
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
  // Issue #295 round-2 review item 2: cursor-only advances
  // (`recordCursorWatermark` and reconcile's `patchCursorWatermark`)
  // intentionally do NOT touch `updated_at`. The cursor write fans out
  // customer-wide to every periodic row, so stamping `updated_at` from
  // it would push historical pending rows out of the quiet window every
  // time a fresh envelope arrived, even though no source data for those
  // buckets changed. The quiet gate therefore reflects source-ingest
  // activity only — exactly what it was originally meant to.
  //
  // The readiness rule is pushed into SQL so we don't have to fetch
  // every pending row into JS just to filter most of them out. Bucket
  // end is `bucket_date + 1 period` interpreted at the customer tz
  // (the bucket was derived in that tz). NOW() is UTC; converting the
  // wall-clock end via `AT TIME ZONE tz` yields the same UTC instant
  // we want to compare against.
  //
  // RFC 0002 Phase 0.5 (#295) — DAILY uses
  // `ANALYSIS_SETTLE_HOURS_DAILY_WITH_WATERMARK` (default 1h) when
  // `cursor_watermark` is non-null, `cursor_watermark_quality='strict'`,
  // and the watermark is at or past the bucket end. Otherwise DAILY
  // falls back to `ANALYSIS_SETTLE_HOURS_DAILY` (default 3h). Soft
  // watermarks and missing watermarks both fall back to the baseline
  // (decision 4). RETURNING surfaces the shortened-branch rows so the
  // hook below can emit the operator-visible "settle shortened" log
  // line (decision 10).
  const dailySettleHours = resolveDailySettleHours();
  const dailySettleHoursWithWatermark = resolveDailySettleHoursWithWatermark();
  const { rows: promoted } = await client.query<{
    customer_id: string;
    period: string;
    bucket_date: string;
    tz: string;
    cursor_watermark: Date | null;
    cursor_watermark_quality: string | null;
    bucket_end_at: Date;
  }>(
    `UPDATE periodic_report_state
        SET status        = 'ready',
            last_ready_at = $6::timestamptz,
            updated_at    = $6::timestamptz
      WHERE status = 'pending'
        AND period IN ('DAILY', 'WEEKLY', 'MONTHLY')
        AND updated_at <= $6::timestamptz - ($5 || ' minutes')::interval
        AND (
          (period = 'DAILY'
           AND (
             (cursor_watermark IS NOT NULL
               AND cursor_watermark_quality = 'strict'
               AND cursor_watermark
                 >= ((bucket_date + INTERVAL '1 day')::timestamp AT TIME ZONE tz)
               AND ((bucket_date + INTERVAL '1 day')::timestamp AT TIME ZONE tz)
                   + ($2 || ' hours')::interval <= $6::timestamptz)
             OR ((bucket_date + INTERVAL '1 day')::timestamp AT TIME ZONE tz)
                + ($1 || ' hours')::interval <= $6::timestamptz
           ))
          OR (period = 'WEEKLY'
              AND ((bucket_date + INTERVAL '7 days')::timestamp AT TIME ZONE tz)
                  + ($3 || ' hours')::interval <= $6::timestamptz)
          OR (period = 'MONTHLY'
              AND ((bucket_date + INTERVAL '1 month')::timestamp AT TIME ZONE tz)
                  + ($4 || ' hours')::interval <= $6::timestamptz)
        )
      RETURNING
        customer_id::text  AS customer_id,
        period,
        bucket_date::text  AS bucket_date,
        tz,
        cursor_watermark,
        cursor_watermark_quality,
        ((bucket_date + INTERVAL '1 day')::timestamp AT TIME ZONE tz)
          AS bucket_end_at`,
    [
      dailySettleHours,
      dailySettleHoursWithWatermark,
      DEFAULT_REPORT_SETTLE_HOURS_WEEKLY,
      DEFAULT_REPORT_SETTLE_HOURS_MONTHLY,
      DEFAULT_REPORT_IDLE_QUIET_MINUTES,
      nowIso,
    ],
  );
  // Emit an `info`-level structured log line for every DAILY promotion
  // that fired against the shortened-watermark branch — per issue #295
  // decision 10 the verification gate requires "watermark-driven settle
  // reduction observable in logs". WEEKLY / MONTHLY promotions are
  // silent in Phase 0.5: they do not yet consume the watermark (scope
  // deferred to #298 per decision 6).
  if (dailySettleHoursWithWatermark < dailySettleHours) {
    // The shortened branch was the deciding factor when the baseline
    // settle hasn't elapsed yet: `bucket_end + baseline_settle > NOW()`.
    // Without this filter the log would also fire for DAILY rows that
    // would have promoted under the baseline anyway, which is exactly
    // the noise decision 10 says to avoid.
    const now = Date.parse(nowIso);
    const baselineSettleMs = dailySettleHours * 3_600_000;
    for (const row of promoted) {
      if (row.period !== "DAILY") continue;
      if (!row.cursor_watermark) continue;
      if (row.cursor_watermark_quality !== "strict") continue;
      if (row.bucket_end_at.getTime() + baselineSettleMs <= now) continue;
      console.info(
        JSON.stringify({
          level: "info",
          event: "analysis.daily_settle_shortened",
          customer_id: row.customer_id,
          period: row.period,
          bucket_date: row.bucket_date,
          tz: row.tz,
          cursor_watermark: row.cursor_watermark.toISOString(),
          bucket_end_at: row.bucket_end_at.toISOString(),
        }),
      );
    }
  }

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
    await dispatchPeriodicDryRunJob(client, row, nowIso);
  }
}

async function dispatchPeriodicDryRunJob(
  client: PoolClient,
  row: PeriodicStateRow,
  nowIso: string,
): Promise<void> {
  if (row.status === "dirty") {
    await client.query(
      `UPDATE periodic_report_job
          SET generation = generation + 1,
              status = 'done',
              dry_run = TRUE,
              processing_started_at = $8::timestamptz,
              last_generated_at = $8::timestamptz,
              last_error = NULL,
              updated_at = $8::timestamptz
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
        nowIso,
      ],
    );
    await client.query(
      `UPDATE periodic_report_state
          SET status = 'ready',
              last_ready_at = $5::timestamptz,
              updated_at = $5::timestamptz
        WHERE customer_id = $1
          AND period = $2
          AND bucket_date = $3::date
          AND tz = $4
          AND status = 'dirty'`,
      [row.customer_id, row.period, row.bucket_date, row.tz, nowIso],
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
             $8::timestamptz, $8::timestamptz)
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
      nowIso,
    ],
  );
}

// ---------------------------------------------------------------------------
// Boot-time recovery + queued-drain
// ---------------------------------------------------------------------------

/**
 * Phase 1 (#296): legacy Phase 0 drain. The Phase 1 migration deletes
 * leftover `dry_run=TRUE` rows; this drain remains as a belt-and-
 * braces sweep for stale rows from rolling deploys or fixtures.
 *
 * Phase 0 inserts job rows directly as `status='done', dry_run=TRUE`,
 * so under normal operation no queued dry-run rows ever exist. Two
 * paths can still produce them:
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
async function drainQueuedDryRunJobs(
  client: PoolClient,
  nowIso: string,
): Promise<void> {
  await client.query(
    `UPDATE story_analysis_job
        SET status = 'done',
            processing_started_at = COALESCE(processing_started_at, $1::timestamptz),
            last_generated_at = $1::timestamptz,
            last_error = NULL,
            updated_at = $1::timestamptz
      WHERE status = 'queued'
        AND dry_run = TRUE`,
    [nowIso],
  );
  await client.query(
    `UPDATE periodic_report_job
        SET status = 'done',
            processing_started_at = COALESCE(processing_started_at, $1::timestamptz),
            last_generated_at = $1::timestamptz,
            last_error = NULL,
            updated_at = $1::timestamptz
      WHERE status = 'queued'
        AND dry_run = TRUE`,
    [nowIso],
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
  // Recovery runs on its own pool outside the tick transaction, so it
  // captures its own `nowIso` independent of any concurrent tick.
  const nowIso = getCurrentTimestamp().toISOString();
  await authPool.query(
    `UPDATE story_analysis_job
        SET status = 'queued',
            processing_started_at = NULL,
            updated_at = $1::timestamptz
      WHERE status = 'processing'`,
    [nowIso],
  );
  await authPool.query(
    `UPDATE periodic_report_job
        SET status = 'queued',
            processing_started_at = NULL,
            updated_at = $1::timestamptz
      WHERE status = 'processing'`,
    [nowIso],
  );
}

// ---------------------------------------------------------------------------
// Tick + installer
// ---------------------------------------------------------------------------

export async function runAnalysisJobTickOnce(authPool?: Pool): Promise<void> {
  const pool = authPool ?? getAuthPool();
  // Capture once per tick so every row touched by this tick shares one
  // "now" — eliminates intra-tick drift (e.g. a row promoted to ready
  // at the start of the tick and a job row inserted at the end share
  // exactly one timestamp).
  const nowIso = getCurrentTimestamp().toISOString();
  // Seeding pass (state → job rows) runs inside a single auth-DB tx.
  // The LLM-dispatch pass runs OUTSIDE that tx — each job's
  // `processing` marker is its own short tx, so a slow aimer call does
  // not hold any seeding rows locked.
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await drainQueuedDryRunJobs(client, nowIso);
    await tickStoryStates(client, nowIso);
    await tickPeriodicStates(client, nowIso);
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
  // Story LLM dispatch — picks `queued` real jobs, runs `analyzeStory`,
  // and writes `story_analysis_result`. Per-job advisory locks keep
  // multiple replicas from double-running the same (customer, story).
  await tickStoryJobsOnce(pool, BATCH_SIZE);
  // Watchdog: flip any `processing` jobs stuck past the timeout back
  // to `queued`. The pickup-time result-row probe avoids double LLM
  // cost when the previous attempt crashed after step 1.
  await recoverStuckStoryJobs(pool);
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
