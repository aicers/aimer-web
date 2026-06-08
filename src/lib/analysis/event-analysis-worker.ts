// Individual baseline-event auto-analysis worker (#493).
//
// RFC 0002 amendment (#489) §"Individual baseline-event auto-analysis".
// The event-grain analog of the story-analysis pipeline (`story-worker.ts`
// + `analysis-job-worker.ts`): it turns loose baseline events (not members
// of any story) into `event_analysis_result` rows under a per-customer
// daily cost cap.
//
// Because a baseline event is atomic (no members arriving over time), this
// uses a lighter ENQUEUE-ON-INGEST + BUDGET-GATED-SEED model rather than the
// story `pending → ready → dirty` settle machine:
//
//   * `seedBaselineEventJobs` (called from `applyBaselineIngestHook`) seeds
//     one HELD `event_analysis_job` row (`selection_tier = NULL`,
//     `status = 'queued'`) per loose, non-deduped accepted event. Story
//     members are deduped out (enriched + analyzed at story scope); an event
//     with a live (non-superseded) `event_analysis_result` leaf for the
//     target variant is deduped out (rebaseline idempotency, mirrors #470).
//
//   * `tickEventJobsOnce` (wired into `runAnalysisJobTickOnce`) picks queued
//     jobs (`FOR UPDATE SKIP LOCKED`, per-`(customer, event)` advisory lock,
//     exponential backoff), CLASSIFIES held rows into a tier, applies the
//     tier-B seed-time budget reservation, then runs the analysis via
//     `analyzeBaselineEventLeaf`.
//
// Tier classification (the coverage-gating decision #492 punted here):
//   * verdict `known_ioc_hit = true` (monotonic)            → TIER A (uncapped)
//   * verdict `false` AND `coverage_status = 'complete'`    → TIER B (capped)
//   * absent verdict / non-`complete` negative coverage     → HELD: drive a
//     bounded `runEventEnrichment`, re-read; upgrade to tier A if the verdict
//     flips `true`; fall back to tier B (with a metric) only on bound
//     exhaustion — NEVER silently `budget_skipped` as a clean miss.

import "server-only";

import type { Pool, PoolClient } from "pg";
import { customerLockId } from "@/lib/db/customer-db";
import { getCustomerRuntimePool } from "@/lib/db/customer-runtime-pool";
import { getCurrentTimestamp } from "@/lib/instrumentation/time";
import {
  type AnalyzeBaselineEventOutcome,
  analyzeBaselineEventLeaf,
} from "./analyze-baseline-event";
import { resolveBaselineDailyCap } from "./baseline-daily-cap";
import { type ModelPair, resolveDefaultModel } from "./default-model";
import {
  type EventEnrichmentOptions,
  type EventEnrichmentVerdict,
  isStoryMember,
  loadEventEnrichmentVerdict,
  runEventEnrichment,
} from "./event-enrichment-worker";
import type { SupportedLang } from "./run-analyze-flow";
import {
  MAX_ATTEMPTS,
  PROCESSING_TIMEOUT_MINUTES,
  RETRY_BACKOFF_BASE_MS,
  RETRY_BACKOFF_MAX_MS,
  WORKER_ACCOUNT_ID,
} from "./story-worker";

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const DEFAULT_LANG = "ENGLISH";
const DEFAULT_MAX_ENRICHMENT_ATTEMPTS = 5;
const DEFAULT_MAX_ENRICHMENT_AGE_MINUTES = 60;

function resolveInt(raw: string | undefined, fallback: number): number {
  if (!raw) return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}

const WORKER_LANG = process.env.ANALYSIS_DEFAULT_LANG ?? DEFAULT_LANG;

// Tier-A kill switch (emergency disable for incident response). Default ON
// since #492 (the verdict surface) is merged. Set to a falsey string to stop
// tier-A seeding without disabling tier B (which is capped via the cap).
export const TIER_A_ENABLED =
  (
    process.env.BASELINE_AUTO_ANALYSIS_TIER_A_ENABLED ?? "true"
  ).toLowerCase() !== "false";

const MAX_ENRICHMENT_ATTEMPTS = resolveInt(
  process.env.BASELINE_AUTO_ANALYSIS_MAX_ENRICHMENT_ATTEMPTS,
  DEFAULT_MAX_ENRICHMENT_ATTEMPTS,
);
const MAX_ENRICHMENT_AGE_MINUTES = resolveInt(
  process.env.BASELINE_AUTO_ANALYSIS_MAX_ENRICHMENT_AGE_MINUTES,
  DEFAULT_MAX_ENRICHMENT_AGE_MINUTES,
);

// Mirror the story worker's exponential-backoff cap exponent (its
// `BACKOFF_MAX_EXPONENT` is private; recompute from the exported base/max).
const BACKOFF_MAX_EXPONENT = Math.max(
  0,
  Math.floor(Math.log2(RETRY_BACKOFF_MAX_MS / RETRY_BACKOFF_BASE_MS)),
);

// Advisory-lock namespace for the per-`(customer, budget_day)` tier-B
// reservation. Distinct from the event-enrichment namespace (0x492e) so the
// two paths never contend on shared keys.
const BASELINE_BUDGET_LOCK_NS = 0x493b;

function emitMetric(event: string, fields: Record<string, unknown>): void {
  console.info(
    JSON.stringify({
      level: "info",
      event: `analysis.baseline_auto.${event}`,
      ...fields,
    }),
  );
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type SelectionTier = "tier_a" | "tier_b";

interface EventJobPickup {
  customer_id: string;
  aice_id: string;
  event_key: string;
  lang: string;
  model_name: string;
  model: string;
  baseline_version: string;
  selection_tier: SelectionTier | null;
  budget_day: string;
  generation: number;
  attempts: number;
  created_at: Date;
}

// ---------------------------------------------------------------------------
// Seeding (ingest-hook driven)
// ---------------------------------------------------------------------------

/** One loose accepted baseline event the ingest hook offers for seeding. */
export interface BaselineSeedCandidate {
  baselineVersion: string;
  sourceAiceId: string;
  eventKey: string;
}

export interface SeedBaselineEventJobsDeps {
  authClient: PoolClient;
  customerPool: Pool;
  /** Per-customer default-model resolver (#473). Defaults to the real one. */
  resolveModel?: (customerId: string, db: PoolClient) => Promise<ModelPair>;
  /** Loose-membership predicate (#492). Defaults to the real one. */
  storyMemberCheck?: typeof isStoryMember;
  /** Injectable clock for deterministic `budget_day`. */
  now?: () => Date;
}

/**
 * Seed HELD `event_analysis_job` rows for the loose, non-deduped subset of
 * `candidates`. A held row carries `selection_tier = NULL` — tier
 * classification + the budget reservation are the worker's job, gated on a
 * conclusive enrichment verdict (the coverage-gating policy). Idempotent:
 * an existing job row keeps its status and only records the latest
 * `baseline_version`; a live target-variant leaf suppresses re-seeding.
 */
export async function seedBaselineEventJobs(
  deps: SeedBaselineEventJobsDeps,
  input: {
    customerId: string;
    tz: string;
    candidates: BaselineSeedCandidate[];
  },
): Promise<void> {
  if (input.candidates.length === 0) return;
  const { authClient, customerPool } = deps;
  const resolveModelFn = deps.resolveModel ?? resolveDefaultModel;
  const storyMemberCheck = deps.storyMemberCheck ?? isStoryMember;
  const nowIso = (deps.now ?? getCurrentTimestamp)().toISOString();

  // The default variant is per-customer (#473) and constant for the batch.
  const model = await resolveModelFn(input.customerId, authClient);
  const lang = WORKER_LANG;

  for (const cand of input.candidates) {
    // Story members are analyzed at story scope — never auto-analyzed here.
    if (
      await storyMemberCheck(customerPool, cand.sourceAiceId, cand.eventKey)
    ) {
      continue;
    }

    // Rebaseline idempotency (mirrors #470): when a live (non-superseded)
    // leaf already exists for the target variant, do not re-analyze. The job
    // still records the latest `baseline_version` so reproducibility tracks
    // the newest ingested row.
    const leaf = await customerPool.query<{ one: number }>(
      `SELECT 1 AS one
         FROM event_analysis_result
        WHERE aice_id = $1 AND event_key = $2::numeric
          AND lang = $3 AND model_name = $4 AND model = $5
          AND superseded_at IS NULL
        LIMIT 1`,
      [cand.sourceAiceId, cand.eventKey, lang, model.modelName, model.model],
    );
    if (leaf.rows.length > 0) {
      await authClient.query(
        `UPDATE event_analysis_job
            SET baseline_version = $7, updated_at = $8::timestamptz
          WHERE customer_id = $1 AND aice_id = $2 AND event_key = $3::numeric
            AND lang = $4 AND model_name = $5 AND model = $6`,
        [
          input.customerId,
          cand.sourceAiceId,
          cand.eventKey,
          lang,
          model.modelName,
          model.model,
          cand.baselineVersion,
          nowIso,
        ],
      );
      continue;
    }

    // Seed a HELD row. `budget_day` is the customer-tz calendar day the row
    // is seeded into — computed in SQL from `nowIso` AT TIME ZONE the
    // customer tz so the auth-DB row carries the boundary the cap evaluates.
    // ON CONFLICT only records the latest `baseline_version` (never resets a
    // terminal/in-flight status — that would re-spend or over-enqueue).
    await authClient.query(
      `INSERT INTO event_analysis_job
         (customer_id, aice_id, event_key, lang, model_name, model,
          status, selection_tier, budget_day, baseline_version,
          generation, dry_run, created_at, updated_at)
       VALUES ($1, $2, $3::numeric, $4, $5, $6,
               'queued', NULL,
               (($9::timestamptz AT TIME ZONE $7)::date), $8,
               1, FALSE, $9::timestamptz, $9::timestamptz)
       ON CONFLICT (customer_id, aice_id, event_key, lang, model_name, model)
       DO UPDATE SET baseline_version = EXCLUDED.baseline_version,
                     updated_at = EXCLUDED.updated_at`,
      [
        input.customerId,
        cand.sourceAiceId,
        cand.eventKey,
        lang,
        model.modelName,
        model.model,
        input.tz,
        cand.baselineVersion,
        nowIso,
      ],
    );
  }
}

// ---------------------------------------------------------------------------
// Pickup
// ---------------------------------------------------------------------------

async function pickQueuedEventJobs(
  client: PoolClient,
  limit: number,
): Promise<EventJobPickup[]> {
  const { rows } = await client.query<EventJobPickup>(
    `SELECT customer_id::text AS customer_id,
            aice_id,
            event_key::text   AS event_key,
            lang, model_name, model,
            baseline_version,
            selection_tier,
            budget_day::text  AS budget_day,
            generation, attempts, created_at
       FROM event_analysis_job
      WHERE status = 'queued'
        AND dry_run = FALSE
        AND (
          attempts = 0
          OR updated_at
             + ($2::bigint * (2 ^ LEAST(attempts - 1, $3::int))) * interval '1 millisecond'
             <= NOW()
        )
      ORDER BY customer_id, aice_id, event_key
      LIMIT $1
      FOR UPDATE SKIP LOCKED`,
    [limit, RETRY_BACKOFF_BASE_MS, BACKOFF_MAX_EXPONENT],
  );
  return rows;
}

// ---------------------------------------------------------------------------
// Per-job processing
// ---------------------------------------------------------------------------

export interface ProcessEventJobOptions {
  authPool: Pool;
  resolveCustomerPool?: (customerId: string) => Pool;
  resolveModel?: typeof resolveDefaultModel;
  resolveCap?: typeof resolveBaselineDailyCap;
  loadVerdict?: typeof loadEventEnrichmentVerdict;
  driveEnrichment?: typeof runEventEnrichment;
  analyzeLeaf?: typeof analyzeBaselineEventLeaf;
  /** Options threaded into `runEventEnrichment` (feed store, redaction map). */
  enrichmentOptions?: Partial<EventEnrichmentOptions>;
  now?: () => Date;
  tierAEnabled?: boolean;
  maxEnrichmentAttempts?: number;
  maxEnrichmentAgeMinutes?: number;
}

interface ClassifyDecision {
  // What the held row was classified into, and whether to proceed to analyze.
  tier: SelectionTier;
  admitted: boolean;
}

/**
 * Classify a HELD job into a tier, driving a bounded `runEventEnrichment`
 * when the verdict is absent / non-conclusive, and applying the tier-B
 * seed-time budget reservation. Returns the decision, or `null` when the row
 * was re-queued (held — enrichment not yet conclusive) and processing should
 * stop for this tick.
 */
async function classifyHeldJob(
  job: EventJobPickup,
  opts: ProcessEventJobOptions,
  customerPool: Pool,
): Promise<ClassifyDecision | null> {
  const loadVerdict = opts.loadVerdict ?? loadEventEnrichmentVerdict;
  const driveEnrichment = opts.driveEnrichment ?? runEventEnrichment;
  const resolveCap = opts.resolveCap ?? resolveBaselineDailyCap;
  const tierAEnabled = opts.tierAEnabled ?? TIER_A_ENABLED;
  const maxAttempts = opts.maxEnrichmentAttempts ?? MAX_ENRICHMENT_ATTEMPTS;
  const maxAgeMin = opts.maxEnrichmentAgeMinutes ?? MAX_ENRICHMENT_AGE_MINUTES;
  const now = opts.now ?? (() => new Date());

  let verdict = await loadVerdict(customerPool, job.aice_id, job.event_key);

  // Conclusive verdict already present — classify directly.
  let decision = classifyVerdict(verdict);
  if (decision === "held") {
    // Absent / non-conclusive: drive one bounded enrichment re-check, then
    // re-read from the SAME marker the verdict loader uses.
    await driveEnrichment(job.customer_id, job.aice_id, job.event_key, {
      authPool: opts.authPool,
      resolveCustomerPool: opts.resolveCustomerPool,
      now,
      ...opts.enrichmentOptions,
    });
    verdict = await loadVerdict(customerPool, job.aice_id, job.event_key);
    decision = classifyVerdict(verdict);
  }

  if (decision === "tier_a") {
    if (!tierAEnabled) {
      // Kill switch: stop tier-A seeding for incident response. Hold (with
      // backoff) so the event is admitted once tier A is re-enabled — a
      // known-IOC event must NEVER fall to the budget-gated path.
      emitMetric("tier_a_disabled_held", {
        customer_id: job.customer_id,
        aice_id: job.aice_id,
        event_key: job.event_key,
      });
      await requeueHeld(opts.authPool, job, "tier_a_disabled");
      return null;
    }
    await markSelectionTier(opts.authPool, job, "tier_a");
    emitMetric("tier_a_analyzed", {
      customer_id: job.customer_id,
      aice_id: job.aice_id,
      event_key: job.event_key,
    });
    return { tier: "tier_a", admitted: true };
  }

  if (decision === "held") {
    // Still non-conclusive after the re-check. Bound on attempts / age; on
    // exhaustion fall back to tier B WITH a metric (never a silent skip).
    const nextAttempts = job.attempts + 1;
    const ageMs = now().getTime() - job.created_at.getTime();
    const exhausted =
      nextAttempts >= maxAttempts || ageMs >= maxAgeMin * 60_000;
    if (!exhausted) {
      await requeueHeld(opts.authPool, job, "awaiting_enrichment");
      return null;
    }
    emitMetric("coverage_holdfallback", {
      customer_id: job.customer_id,
      aice_id: job.aice_id,
      event_key: job.event_key,
      attempts: nextAttempts,
      coverage_status: verdict?.coverageStatus ?? null,
    });
    // fall through to tier-B reservation below.
  }

  // Tier B (conclusive complete-coverage miss, or hold-bound fallback).
  const cap = await resolveCap(job.customer_id, opts.authPool);
  const admitted = await reserveTierB(opts.authPool, job, cap);
  if (!admitted) {
    emitMetric("budget_skipped", {
      customer_id: job.customer_id,
      aice_id: job.aice_id,
      event_key: job.event_key,
      budget_day: job.budget_day,
      cap,
    });
    return { tier: "tier_b", admitted: false };
  }
  emitMetric("tier_b_admitted", {
    customer_id: job.customer_id,
    aice_id: job.aice_id,
    event_key: job.event_key,
    budget_day: job.budget_day,
    cap,
  });
  return { tier: "tier_b", admitted: true };
}

type VerdictClass = "tier_a" | "tier_b" | "held";

/** Map a verdict to a tier per the coverage-gating policy. */
function classifyVerdict(verdict: EventEnrichmentVerdict | null): VerdictClass {
  // Monotonic upgrade: an established IOC hit routes to tier A regardless of
  // the latest coverage (consistent with #492's monotonic-OR persist).
  if (verdict?.knownIocHit === true) return "tier_a";
  // Conclusive negative: complete coverage + a completed run.
  if (
    verdict &&
    verdict.status === "complete" &&
    verdict.coverageStatus === "complete"
  ) {
    return "tier_b";
  }
  // Absent verdict, hard failure, or a negative under non-`complete`
  // coverage (partial/unknown/stale) — not conclusive. Hold.
  return "held";
}

/**
 * Tier-B seed-time reservation. Serialized per `(customer_id, budget_day)`
 * by a transaction-scoped advisory lock so concurrent ticks cannot both pass
 * the `< cap` check. Counts in-flight `queued`/`processing` (and `done`/
 * `failed`) rows — only `budget_skipped` is excluded — so a backlog cannot
 * over-enqueue past the cap. Stamps the row's `selection_tier='tier_b'`, and
 * `status='budget_skipped'` (terminal) when over the cap. A cap of `0`
 * disables tier B (always over).
 */
async function reserveTierB(
  authPool: Pool,
  job: EventJobPickup,
  cap: number,
): Promise<boolean> {
  const client = await authPool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock($1, $2)", [
      BASELINE_BUDGET_LOCK_NS,
      budgetDayLockId2(job.customer_id, job.budget_day),
    ]);
    const { rows } = await client.query<{ n: number }>(
      `SELECT COUNT(*)::int AS n
         FROM event_analysis_job
        WHERE customer_id = $1
          AND budget_day = $2::date
          AND selection_tier = 'tier_b'
          AND status <> 'budget_skipped'`,
      [job.customer_id, job.budget_day],
    );
    const admitted = cap > 0 && (rows[0]?.n ?? 0) < cap;
    await client.query(
      `UPDATE event_analysis_job
          SET selection_tier = 'tier_b',
              status = CASE WHEN $7 THEN 'processing' ELSE 'budget_skipped' END,
              attempts = CASE WHEN $7 THEN 0 ELSE attempts END,
              last_error = NULL,
              updated_at = NOW()
        WHERE customer_id = $1 AND aice_id = $2 AND event_key = $3::numeric
          AND lang = $4 AND model_name = $5 AND model = $6`,
      [
        job.customer_id,
        job.aice_id,
        job.event_key,
        job.lang,
        job.model_name,
        job.model,
        admitted,
      ],
    );
    await client.query("COMMIT");
    return admitted;
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

/** Stamp a (uncapped) tier and reset attempts for the analysis phase. */
async function markSelectionTier(
  authPool: Pool,
  job: EventJobPickup,
  tier: SelectionTier,
): Promise<void> {
  await authPool.query(
    `UPDATE event_analysis_job
        SET selection_tier = $7,
            attempts = 0,
            last_error = NULL,
            updated_at = NOW()
      WHERE customer_id = $1 AND aice_id = $2 AND event_key = $3::numeric
        AND lang = $4 AND model_name = $5 AND model = $6`,
    [
      job.customer_id,
      job.aice_id,
      job.event_key,
      job.lang,
      job.model_name,
      job.model,
      tier,
    ],
  );
}

/** Re-queue a still-held row (selection_tier stays NULL), incrementing the
 * enrichment re-check counter and applying backoff. */
async function requeueHeld(
  authPool: Pool,
  job: EventJobPickup,
  reason: string,
): Promise<void> {
  await authPool.query(
    `UPDATE event_analysis_job
        SET status = 'queued',
            attempts = $7,
            last_error = $8,
            processing_started_at = NULL,
            updated_at = NOW()
      WHERE customer_id = $1 AND aice_id = $2 AND event_key = $3::numeric
        AND lang = $4 AND model_name = $5 AND model = $6`,
    [
      job.customer_id,
      job.aice_id,
      job.event_key,
      job.lang,
      job.model_name,
      job.model,
      job.attempts + 1,
      reason,
    ],
  );
}

async function finalizeJob(authPool: Pool, job: EventJobPickup): Promise<void> {
  await authPool.query(
    `UPDATE event_analysis_job
        SET status = 'done',
            last_generated_at = NOW(),
            last_error = NULL,
            updated_at = NOW()
      WHERE customer_id = $1 AND aice_id = $2 AND event_key = $3::numeric
        AND lang = $4 AND model_name = $5 AND model = $6
        AND status = 'processing'`,
    [
      job.customer_id,
      job.aice_id,
      job.event_key,
      job.lang,
      job.model_name,
      job.model,
    ],
  );
}

/** Re-queue with exponential backoff, or write terminal `failed` once the
 * analysis attempt budget is exhausted. */
async function requeueOrFailAnalysis(
  authPool: Pool,
  job: EventJobPickup,
  reason: string,
): Promise<void> {
  const nextAttempts = job.attempts + 1;
  if (nextAttempts >= MAX_ATTEMPTS) {
    await authPool.query(
      `UPDATE event_analysis_job
          SET status = 'failed',
              attempts = $7,
              last_error = $8,
              updated_at = NOW()
        WHERE customer_id = $1 AND aice_id = $2 AND event_key = $3::numeric
          AND lang = $4 AND model_name = $5 AND model = $6`,
      [
        job.customer_id,
        job.aice_id,
        job.event_key,
        job.lang,
        job.model_name,
        job.model,
        nextAttempts,
        reason,
      ],
    );
    return;
  }
  await authPool.query(
    `UPDATE event_analysis_job
        SET status = 'queued',
            attempts = $7,
            last_error = $8,
            processing_started_at = NULL,
            updated_at = NOW()
      WHERE customer_id = $1 AND aice_id = $2 AND event_key = $3::numeric
        AND lang = $4 AND model_name = $5 AND model = $6`,
    [
      job.customer_id,
      job.aice_id,
      job.event_key,
      job.lang,
      job.model_name,
      job.model,
      nextAttempts,
      reason,
    ],
  );
}

export async function processEventJob(
  job: EventJobPickup,
  opts: ProcessEventJobOptions,
): Promise<void> {
  const customerPool = (opts.resolveCustomerPool ?? getCustomerRuntimePool)(
    job.customer_id,
  );

  // Claim the row. Guards against a parallel pickup tick: `status='queued'`
  // and `attempts=<captured>` reject a row another worker already
  // transitioned or re-queued (which would bypass the backoff predicate).
  const claim = await opts.authPool.query(
    `UPDATE event_analysis_job
        SET status = 'processing',
            processing_started_at = NOW(),
            updated_at = NOW()
      WHERE customer_id = $1 AND aice_id = $2 AND event_key = $3::numeric
        AND lang = $4 AND model_name = $5 AND model = $6
        AND status = 'queued'
        AND attempts = $7`,
    [
      job.customer_id,
      job.aice_id,
      job.event_key,
      job.lang,
      job.model_name,
      job.model,
      job.attempts,
    ],
  );
  if (claim.rowCount === 0) return; // lost the pickup race

  // Classify held rows (drive enrichment + reserve budget). A null return
  // means the row was re-queued (still held) — stop for this tick.
  if (job.selection_tier === null) {
    const decision = await classifyHeldJob(job, opts, customerPool);
    if (decision === null) return;
    if (!decision.admitted) return; // budget_skipped (terminal)
  }

  // Analyze the leaf (loads the exact stored redacted baseline_event). The
  // job's stored variant is authoritative (resolved at seed); use it so
  // re-resolution mid-flight cannot drift the result PK.
  const analyzeLeaf = opts.analyzeLeaf ?? analyzeBaselineEventLeaf;

  let outcome: AnalyzeBaselineEventOutcome;
  try {
    outcome = await analyzeLeaf({
      authPool: opts.authPool,
      customerPool,
      customerId: job.customer_id,
      sourceAiceId: job.aice_id,
      eventKey: job.event_key,
      baselineVersion: job.baseline_version,
      lang: job.lang as SupportedLang,
      modelName: job.model_name,
      model: job.model,
      workerAccountId: WORKER_ACCOUNT_ID,
    });
  } catch (err) {
    await requeueOrFailAnalysis(
      opts.authPool,
      job,
      err instanceof Error ? err.message : String(err),
    );
    return;
  }

  if (outcome.kind === "analyzed") {
    await finalizeJob(opts.authPool, job);
    return;
  }
  if (outcome.kind === "source_unavailable") {
    // The exact baseline_version was rebaselined away / swept. Terminal:
    // there is no payload to analyze.
    await opts.authPool.query(
      `UPDATE event_analysis_job
          SET status = 'failed', last_error = 'source_unavailable',
              updated_at = NOW()
        WHERE customer_id = $1 AND aice_id = $2 AND event_key = $3::numeric
          AND lang = $4 AND model_name = $5 AND model = $6`,
      [
        job.customer_id,
        job.aice_id,
        job.event_key,
        job.lang,
        job.model_name,
        job.model,
      ],
    );
    return;
  }
  // aimer / storage error — retryable with backoff.
  await requeueOrFailAnalysis(opts.authPool, job, outcome.message);
}

// ---------------------------------------------------------------------------
// Tick + recovery
// ---------------------------------------------------------------------------

export async function tickEventJobsOnce(
  authPool: Pool,
  limit: number,
  opts: ProcessEventJobOptions = { authPool },
): Promise<number> {
  const client = await authPool.connect();
  let picks: EventJobPickup[] = [];
  try {
    await client.query("BEGIN");
    picks = await pickQueuedEventJobs(client, limit);
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }

  for (const job of picks) {
    const lockId = customerLockId(job.customer_id);
    const lockId2 = eventJobLockId2(job.aice_id, job.event_key);
    const lockClient = await authPool.connect();
    try {
      const lockRes = await lockClient.query<{ locked: boolean }>(
        `SELECT pg_try_advisory_lock($1, $2) AS locked`,
        [lockId, lockId2],
      );
      if (!lockRes.rows[0]?.locked) continue;
      try {
        await processEventJob(job, opts);
      } finally {
        await lockClient
          .query(`SELECT pg_advisory_unlock($1, $2)`, [lockId, lockId2])
          .catch(() => {});
      }
    } catch (err) {
      console.error("[event-analysis-worker] processEventJob failed:", err);
    } finally {
      lockClient.release();
    }
  }
  return picks.length;
}

/**
 * Watchdog: flip `processing` rows stuck past the timeout back to `queued`
 * so the next tick re-picks them. A recovered held row (selection_tier NULL)
 * re-classifies; a recovered reserved row (selection_tier already set)
 * re-runs the analysis without re-reserving budget.
 */
export async function recoverStuckEventJobs(authPool: Pool): Promise<void> {
  await authPool.query(
    `UPDATE event_analysis_job
        SET status = 'queued',
            processing_started_at = NULL,
            updated_at = NOW()
      WHERE status = 'processing'
        AND dry_run = FALSE
        AND (processing_started_at IS NULL
             OR processing_started_at <= NOW() - ($1 || ' minutes')::interval)`,
    [PROCESSING_TIMEOUT_MINUTES],
  );
}

// A stable 31-bit lock key for one logical event, mirroring the story path's
// `jobStoryLockId2`. `| 1` keeps it non-zero.
function eventJobLockId2(aiceId: string, eventKey: string): number {
  let hash = 0;
  for (const ch of `${aiceId}/${eventKey}`) {
    hash = (hash * 31 + ch.charCodeAt(0)) | 0;
  }
  return Math.abs(hash) | 1;
}

function budgetDayLockId2(customerId: string, budgetDay: string): number {
  let hash = 0;
  for (const ch of `${customerId}|${budgetDay}`) {
    hash = (hash * 31 + ch.charCodeAt(0)) | 0;
  }
  return Math.abs(hash) | 1;
}

export const __testables = {
  classifyVerdict,
  eventJobLockId2,
  budgetDayLockId2,
  BACKOFF_MAX_EXPONENT,
};
