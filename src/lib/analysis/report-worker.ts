// RFC 0002 Phase 2 (#297) — periodic report analysis worker.
//
// Picks up `periodic_report_job` rows with `status='queued',
// dry_run=FALSE, period IN ('LIVE','DAILY')`, builds the structured
// input bundle from the customer DB (`report-input-builder.ts`), calls
// aimer's `generatePeriodicSecurityReport` mutation, validates the
// narrative for residual redaction tokens / PII, and writes the result
// to `periodic_report_result` followed by the auth-DB job finalize.
//
// Mirrors `story-worker.ts`:
//   - per-job advisory lock on `(customer_id, period, bucket_date, tz)`,
//   - captured-generation rule so a concurrent force-regenerate cannot
//     trample an in-flight finalize,
//   - pickup-time result-row probe for crash-idempotent commit ordering
//     (customer-DB INSERT first, then auth-DB finalize),
//   - same backoff predicate, retry envs, and fatal-vs-retryable split.
//
// WEEKLY / MONTHLY are explicitly out of scope (round-14 item 4): the
// dispatcher's pickup filter and `seedRealReportJobs` both restrict to
// LIVE + DAILY. WEEKLY/MONTHLY state rows keep being seeded + dirtied by
// the Phase 0 reconcile/ingest path; #298 lifts the period filter.

import "server-only";

import { ClientError } from "graphql-request";
import type { Pool, PoolClient } from "pg";
import { auditLog } from "@/lib/audit";
import { customerLockId } from "@/lib/db/customer-db";
import { getCustomerRuntimePool } from "@/lib/db/customer-runtime-pool";
import {
  PeriodicReportDocument,
  type PeriodicReportInput,
} from "@/lib/graphql/__generated__/generate-periodic-security-report";
import { graphqlRequest } from "@/lib/graphql/client";
import { getCurrentTimestamp } from "@/lib/instrumentation/time";
import { loadCustomerRanges } from "@/lib/redaction/load-ranges";
import {
  buildPeriodicReportInput,
  type PeriodicPeriod,
  type ReportVariant,
} from "./report-input-builder";
import { scanReportAnalysisForLeaks } from "./report-token";

// ---------------------------------------------------------------------------
// Configuration (env-driven, read at module init) — shared with Phase 1.
// ---------------------------------------------------------------------------

const DEFAULT_RETRY_BACKOFF_BASE_MS = 30_000;
const DEFAULT_RETRY_BACKOFF_MAX_MS = 15 * 60_000;
const DEFAULT_MAX_ATTEMPTS = 5;
const DEFAULT_PROCESSING_TIMEOUT_MINUTES = 30;
const DEFAULT_MAX_GENERATION = 50;
const DEFAULT_WORKER_ACCOUNT_ID = "system:analysis-worker";
const DEFAULT_PERIODIC_WORKER_AICE_ID = "system:periodic-report";
const DEFAULT_LIVE_REFRESH_MINUTES = 60;
const DEFAULT_TOP_STORIES_K = 5;
const DEFAULT_TOP_EVENTS_K = 10;
const DEFAULT_LANG = "ENGLISH";
const DEFAULT_MODEL_NAME = "openai";
const DEFAULT_MODEL = "gpt-4o";

function resolveInt(raw: string | undefined, fallback: number): number {
  if (!raw) return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}

export const RETRY_BACKOFF_BASE_MS = resolveInt(
  process.env.ANALYSIS_RETRY_BACKOFF_BASE_MS,
  DEFAULT_RETRY_BACKOFF_BASE_MS,
);
export const RETRY_BACKOFF_MAX_MS = resolveInt(
  process.env.ANALYSIS_RETRY_BACKOFF_MAX_MS,
  DEFAULT_RETRY_BACKOFF_MAX_MS,
);
export const MAX_ATTEMPTS = resolveInt(
  process.env.ANALYSIS_MAX_ATTEMPTS,
  DEFAULT_MAX_ATTEMPTS,
);
export const PROCESSING_TIMEOUT_MINUTES = resolveInt(
  process.env.ANALYSIS_PROCESSING_TIMEOUT_MINUTES,
  DEFAULT_PROCESSING_TIMEOUT_MINUTES,
);
export const MAX_GENERATION = resolveInt(
  process.env.ANALYSIS_MAX_GENERATION,
  DEFAULT_MAX_GENERATION,
);
export const LIVE_REFRESH_MINUTES = resolveInt(
  process.env.ANALYSIS_LIVE_REFRESH_MINUTES,
  DEFAULT_LIVE_REFRESH_MINUTES,
);
const TOP_STORIES_K = resolveInt(
  process.env.ANALYSIS_REPORT_TOP_STORIES_K,
  DEFAULT_TOP_STORIES_K,
);
const TOP_EVENTS_K = resolveInt(
  process.env.ANALYSIS_REPORT_TOP_EVENTS_K,
  DEFAULT_TOP_EVENTS_K,
);
export const WORKER_ACCOUNT_ID =
  process.env.ANALYSIS_WORKER_ACCOUNT_ID ?? DEFAULT_WORKER_ACCOUNT_ID;
export const PERIODIC_WORKER_AICE_ID =
  process.env.ANALYSIS_PERIODIC_WORKER_AICE_ID ??
  DEFAULT_PERIODIC_WORKER_AICE_ID;
const WORKER_LANG = process.env.ANALYSIS_DEFAULT_LANG ?? DEFAULT_LANG;
const WORKER_MODEL_NAME =
  process.env.ANALYSIS_DEFAULT_MODEL_NAME ?? DEFAULT_MODEL_NAME;
const WORKER_MODEL = process.env.ANALYSIS_DEFAULT_MODEL ?? DEFAULT_MODEL;

const BACKOFF_MAX_EXPONENT = Math.max(
  0,
  Math.floor(Math.log2(RETRY_BACKOFF_MAX_MS / RETRY_BACKOFF_BASE_MS)),
);

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface JobPickup {
  customer_id: string;
  period: PeriodicPeriod;
  bucket_date: string;
  tz: string;
  lang: string;
  model_name: string;
  model: string;
  generation: number;
  attempts: number;
  force_requested_at: Date | null;
  force_requested_by: string | null;
  cursor_watermark: Date | null;
  cursor_watermark_quality: string | null;
}

interface ReportAimerResponse {
  executiveSummary: string;
  storyHighlights: string;
  baselineDrift: string;
  notableEvents: string;
  recommendations: string;
  promptVersion: string;
  modelActualVersion: string;
}

interface AuditEmissionBase {
  actorId: string;
  authContext: "general";
  targetType: string;
  customerId: string;
  aiceId: string | undefined;
}

// ---------------------------------------------------------------------------
// Pickup query
// ---------------------------------------------------------------------------

async function pickQueuedReportJobs(
  client: PoolClient,
  limit: number,
): Promise<JobPickup[]> {
  const { rows } = await client.query<JobPickup>(
    `SELECT j.customer_id::text AS customer_id,
            j.period,
            j.bucket_date::text  AS bucket_date,
            j.tz,
            j.lang, j.model_name, j.model,
            j.generation, j.attempts,
            j.force_requested_at,
            j.force_requested_by::text AS force_requested_by,
            s.cursor_watermark,
            s.cursor_watermark_quality
       FROM periodic_report_job j
       JOIN periodic_report_state s
         ON s.customer_id = j.customer_id AND s.period = j.period
        AND s.bucket_date = j.bucket_date AND s.tz = j.tz
      WHERE j.status = 'queued'
        AND j.dry_run = FALSE
        AND j.period IN ('LIVE', 'DAILY')
        -- Skip jobs whose parent state archived after queueing (e.g. a
        -- timezone change archives the old-tz state without deleting its
        -- jobs). A terminal archived state must never reach the LLM /
        -- result write (#297 review round 2, item 2). The claim step
        -- re-checks this to close the pickup→claim archive window.
        AND s.status <> 'archived'
        AND (
          j.attempts = 0
          OR j.updated_at
             + ($2::bigint * (2 ^ LEAST(j.attempts - 1, $3::int))) * interval '1 millisecond'
             <= NOW()
        )
      ORDER BY j.customer_id, j.period, j.bucket_date, j.tz
      LIMIT $1
      FOR UPDATE OF j SKIP LOCKED`,
    [limit, RETRY_BACKOFF_BASE_MS, BACKOFF_MAX_EXPONENT],
  );
  return rows;
}

// ---------------------------------------------------------------------------
// Per-job processing
// ---------------------------------------------------------------------------

interface ProcessOptions {
  authPool: Pool;
  callGenerateReport?: typeof callGenerateReport;
  resolveCustomerPool?: (customerId: string) => Pool;
  loadRanges?: typeof loadCustomerRanges;
}

export async function processReportJob(
  job: JobPickup,
  opts: ProcessOptions,
): Promise<void> {
  const callLlm = opts.callGenerateReport ?? callGenerateReport;
  // Resolve the customer pool up front (mirrors story-worker): in an
  // environment with no customer DB this throws before the claim, so the
  // job is left `queued` for the next tick rather than stranded.
  const customerPool = (opts.resolveCustomerPool ?? getCustomerRuntimePool)(
    job.customer_id,
  );

  const claim = await opts.authPool.query<{ processing_started_at: string }>(
    `UPDATE periodic_report_job
        SET status = 'processing',
            processing_started_at = NOW(),
            updated_at = NOW()
      WHERE customer_id = $1 AND period = $2
        AND bucket_date = $3::date AND tz = $4
        AND lang = $5 AND model_name = $6 AND model = $7
        AND generation = $8
        AND status = 'queued'
        AND attempts = $9
        AND EXISTS (
          SELECT 1 FROM periodic_report_state s
           WHERE s.customer_id = periodic_report_job.customer_id
             AND s.period      = periodic_report_job.period
             AND s.bucket_date = periodic_report_job.bucket_date
             AND s.tz          = periodic_report_job.tz
             AND s.status <> 'archived'
        )
      RETURNING processing_started_at::text AS processing_started_at`,
    [
      job.customer_id,
      job.period,
      job.bucket_date,
      job.tz,
      job.lang,
      job.model_name,
      job.model,
      job.generation,
      job.attempts,
    ],
  );
  if (claim.rowCount === 0) {
    console.warn(
      JSON.stringify({
        level: "warn",
        event: "analysis.report_pickup_race_lost",
        customer_id: job.customer_id,
        period: job.period,
        bucket_date: job.bucket_date,
        tz: job.tz,
        generation: job.generation,
      }),
    );
    return;
  }

  // Claim marker — the exact `processing_started_at` this claim stamped,
  // carried (as text to preserve sub-millisecond precision the JS Date
  // parser would truncate) into every subsequent state transition. A
  // watchdog requeue (`recoverStuckReportJobs`) clears this column and a
  // re-claim stamps a fresh value, so a timed-out first attempt that
  // returns late finds its marker no longer current and its
  // finalize/fail/requeue match zero rows — it cannot trample the later
  // attempt's `done`/`processing` state (#297 review round 5, item 1).
  const claimMarker = claim.rows[0].processing_started_at;

  // Result-row probe — a row at the captured PK means step 1 already
  // landed before a crash; skip the LLM call and finalize only.
  const existing = await customerPool.query<{ priority_tier: string }>(
    `SELECT priority_tier FROM periodic_report_result
      WHERE customer_id = $1 AND period = $2
        AND bucket_date = $3::date AND tz = $4
        AND lang = $5 AND model_name = $6 AND model = $7
        AND generation = $8`,
    [
      job.customer_id,
      job.period,
      job.bucket_date,
      job.tz,
      job.lang,
      job.model_name,
      job.model,
      job.generation,
    ],
  );
  if (existing.rows.length > 0) {
    await finalizeJob(opts.authPool, job, claimMarker);
    return;
  }

  const variant: ReportVariant = {
    tz: job.tz,
    lang: job.lang,
    modelName: job.model_name,
    model: job.model,
  };
  const nowIso = getCurrentTimestamp().toISOString();

  const built = await buildPeriodicReportInput({
    authPool: opts.authPool,
    customerPool,
    customerId: job.customer_id,
    period: job.period,
    bucketDate: job.bucket_date,
    variant,
    nowIso,
    topStoriesK: TOP_STORIES_K,
    topEventsK: TOP_EVENTS_K,
  });

  const auditBase: AuditEmissionBase = {
    actorId: WORKER_ACCOUNT_ID,
    authContext: "general",
    targetType: "periodic_report_result",
    customerId: job.customer_id,
    aiceId: PERIODIC_WORKER_AICE_ID,
  };

  // Redaction-policy precondition across the consumed leaves. A
  // baseline-only report (zero leaves) stamps the reserved sentinel.
  if (built.redaction.kind === "missing") {
    await failJob(
      opts.authPool,
      job,
      "missing_redaction_policy_version",
      claimMarker,
    );
    return;
  }
  if (built.redaction.kind === "mismatched") {
    await failJob(
      opts.authPool,
      job,
      "mismatched_redaction_policy_version",
      claimMarker,
    );
    return;
  }
  const redactionPolicyVersion =
    built.redaction.kind === "ok" ? built.redaction.version : "baseline-only";

  // Re-check the parent state immediately before the (expensive,
  // irreversible) LLM call. The tz-change trigger archives old-tz state
  // rows independently of this worker (migrations/auth/0030), so a state
  // archived in the claim→here window must not reach the LLM. The pickup
  // filter and the claim re-check close the pickup→claim window; this
  // closes claim→call (#297 review round 4, item 3).
  if (await parentStateArchived(opts.authPool, job)) {
    await releaseArchivedJob(opts.authPool, job, claimMarker);
    return;
  }

  const force = job.force_requested_at !== null;
  void auditLog({
    ...auditBase,
    action: "ai_analysis.request_issued",
    targetId: reportTargetId(job),
    details: {
      customer_id: job.customer_id,
      period: job.period,
      bucket_date: job.bucket_date,
      tz: job.tz,
      lang: job.lang,
      model_name: job.model_name,
      model: job.model,
      generation: job.generation,
      force,
      actor_aice_id: PERIODIC_WORKER_AICE_ID,
    },
  });

  let aimerResponse: ReportAimerResponse;
  try {
    aimerResponse = await callLlm({
      customerId: job.customer_id,
      period: job.period,
      date: built.reportDate,
      timezone: job.tz,
      modelName: job.model_name,
      model: job.model,
      lang: job.lang,
      inputs: built.aimerInputs,
    });
  } catch (err) {
    const classification = classifyAimerError(err);
    void auditLog({
      ...auditBase,
      action: "ai_analysis.aimer_call_failed",
      targetId: reportTargetId(job),
      details: {
        generation: job.generation,
        code: classification.code,
        retryable: classification.retryable,
        error: err instanceof Error ? err.message : String(err),
      },
    });
    if (!classification.retryable) {
      await failJob(opts.authPool, job, classification.code, claimMarker, {
        attempts: job.attempts + 1,
      });
      return;
    }
    await requeueWithBackoff(
      opts.authPool,
      job,
      classification.code,
      claimMarker,
    );
    return;
  }

  // Hallucination scan across every rendered section.
  const ranges = await (opts.loadRanges ?? loadCustomerRanges)(
    opts.authPool,
    job.customer_id,
  );
  const reportText = [
    aimerResponse.executiveSummary,
    aimerResponse.storyHighlights,
    aimerResponse.baselineDrift,
    aimerResponse.notableEvents,
    aimerResponse.recommendations,
  ].join("\n\n");
  const leakScan = scanReportAnalysisForLeaks(
    reportText,
    built.tokenRefs,
    ranges,
  );
  if (leakScan.hasLeak) {
    void auditLog({
      ...auditBase,
      action: "ai_analysis.hallucination_detected",
      targetId: reportTargetId(job),
      details: {
        generation: job.generation,
        leaks: leakScan.leaks.slice(0, 20),
      },
    });
    await failJob(opts.authPool, job, "hallucination_detected", claimMarker, {
      attempts: job.attempts + 1,
    });
    return;
  }

  const sections = {
    executive_summary: aimerResponse.executiveSummary,
    story_highlights: aimerResponse.storyHighlights,
    baseline_drift: aimerResponse.baselineDrift,
    notable_events: aimerResponse.notableEvents,
    recommendations: aimerResponse.recommendations,
  };
  const inputWatermark =
    job.cursor_watermark_quality === "strict" ? job.cursor_watermark : null;

  // Final archived re-check immediately before the customer-DB result
  // write. The state and the result row live in separate databases and so
  // cannot share a transaction; this narrows the window in which an
  // old-tz archive could land a result row for a terminal state to the
  // sub-millisecond gap between this auth-DB read and the customer-DB
  // INSERT commit. If archived, suppress the write and release the job
  // rather than persisting a result for a terminal state (#297 review
  // round 4, item 3).
  if (await parentStateArchived(opts.authPool, job)) {
    await releaseArchivedJob(opts.authPool, job, claimMarker);
    return;
  }

  // Step 1 — customer-DB INSERT + supersede prior.
  try {
    await writeResultRow(customerPool, {
      job,
      built,
      aimerResponse,
      sections,
      redactionPolicyVersion,
      inputWatermark,
      requestedBy: force ? job.force_requested_by : null,
    });
  } catch (err) {
    void auditLog({
      ...auditBase,
      action: "ai_analysis.aimer_call_failed",
      targetId: reportTargetId(job),
      details: {
        generation: job.generation,
        stage: "result_insert",
        error: err instanceof Error ? err.message : String(err),
      },
    });
    throw err;
  }

  // Step 2 — auth-DB finalize keyed by the captured generation and claim.
  await finalizeJob(opts.authPool, job, claimMarker);

  void auditLog({
    ...auditBase,
    action: "ai_analysis.result_stored",
    targetId: reportTargetId(job),
    details: {
      prompt_version: aimerResponse.promptVersion,
      model_actual_version: aimerResponse.modelActualVersion,
      priority_tier: built.priorityTier,
      top_story_count: built.storyRefs.length,
      top_event_count: built.eventRefs.length,
      baseline_drift_severity: built.drift.severity,
      baseline_drift_likelihood: built.drift.likelihood,
    },
  });
}

function reportTargetId(job: JobPickup): string {
  return `${job.customer_id}/${job.period}/${job.bucket_date}/${job.tz}`;
}

// ---------------------------------------------------------------------------
// aimer call wrapper
// ---------------------------------------------------------------------------

async function callGenerateReport(args: {
  customerId: string;
  period: PeriodicPeriod;
  date: string;
  timezone: string;
  modelName: string;
  model: string;
  lang: string;
  inputs: PeriodicReportInput;
}): Promise<ReportAimerResponse> {
  const result = await graphqlRequest(
    PeriodicReportDocument,
    {
      customerId: args.customerId,
      period: args.period,
      date: args.date,
      timezone: args.timezone,
      name: args.modelName,
      model: args.model,
      lang: args.lang as "KOREAN" | "ENGLISH",
      inputs: args.inputs,
    },
    { accountId: WORKER_ACCOUNT_ID, aiceId: PERIODIC_WORKER_AICE_ID },
  );
  return result.generatePeriodicSecurityReport;
}

function classifyAimerError(err: unknown): {
  code: string;
  retryable: boolean;
} {
  if (err instanceof ClientError) {
    const status = err.response?.status;
    if (status !== undefined && status >= 500) {
      return { code: "aimer_5xx", retryable: true };
    }
    if (status !== undefined && status >= 400 && status < 500) {
      return { code: "aimer_4xx", retryable: false };
    }
    return { code: "aimer_transport_error", retryable: true };
  }
  return { code: "aimer_unavailable", retryable: true };
}

// ---------------------------------------------------------------------------
// Customer-DB write
// ---------------------------------------------------------------------------

async function writeResultRow(
  customerPool: Pool,
  args: {
    job: JobPickup;
    built: Awaited<ReturnType<typeof buildPeriodicReportInput>>;
    aimerResponse: ReportAimerResponse;
    sections: Record<string, string>;
    redactionPolicyVersion: string;
    inputWatermark: Date | null;
    requestedBy: string | null;
  },
): Promise<void> {
  const client = await customerPool.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      `INSERT INTO periodic_report_result
         (customer_id, period, bucket_date, tz, lang, model_name, model,
          model_actual_version, prompt_version, generation,
          aggregate_severity_score, aggregate_likelihood_score,
          aggregate_ttp_tags, priority_tier, sections_jsonb,
          input_event_refs, input_story_refs, input_hash, input_watermark,
          redaction_policy_version, requested_by)
       VALUES ($1, $2, $3::date, $4, $5, $6, $7,
               $8, $9, $10,
               $11, $12,
               $13::jsonb, $14, $15::jsonb,
               $16::jsonb, $17::jsonb, $18, $19,
               $20, $21::uuid)`,
      [
        args.job.customer_id,
        args.job.period,
        args.job.bucket_date,
        args.job.tz,
        args.job.lang,
        args.job.model_name,
        args.job.model,
        args.aimerResponse.modelActualVersion,
        args.aimerResponse.promptVersion,
        args.job.generation,
        args.built.aggregateSeverityScore,
        args.built.aggregateLikelihoodScore,
        JSON.stringify(args.built.aggregateTtpTags),
        args.built.priorityTier,
        JSON.stringify(args.sections),
        JSON.stringify(args.built.eventRefs),
        JSON.stringify(args.built.storyRefs),
        args.built.inputHash,
        args.inputWatermark,
        args.redactionPolicyVersion,
        args.requestedBy,
      ],
    );
    await client.query(
      `UPDATE periodic_report_result
          SET superseded_at = NOW()
        WHERE customer_id = $1 AND period = $2
          AND bucket_date = $3::date AND tz = $4
          AND lang = $5 AND model_name = $6 AND model = $7
          AND generation < $8
          AND superseded_at IS NULL`,
      [
        args.job.customer_id,
        args.job.period,
        args.job.bucket_date,
        args.job.tz,
        args.job.lang,
        args.job.model_name,
        args.job.model,
        args.job.generation,
      ],
    );
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

// ---------------------------------------------------------------------------
// Auth-DB finalize / fail / requeue
// ---------------------------------------------------------------------------

// True when the parent `periodic_report_state` row is archived or gone —
// either way the job must not produce an LLM call or result row. The
// tz-change trigger (migrations/auth/0030) archives old-tz states
// asynchronously, so this is re-evaluated at the call and write barriers.
async function parentStateArchived(
  authPool: Pool,
  job: JobPickup,
): Promise<boolean> {
  const { rows } = await authPool.query<{ archived: boolean }>(
    `SELECT (status = 'archived') AS archived
       FROM periodic_report_state
      WHERE customer_id = $1 AND period = $2
        AND bucket_date = $3::date AND tz = $4`,
    [job.customer_id, job.period, job.bucket_date, job.tz],
  );
  return rows.length === 0 || rows[0].archived === true;
}

// Return a claimed (`processing`) job to `queued` without recording
// progress, used when the parent state archived mid-flight. The pickup
// filter excludes archived parents, so the job is not re-picked; the
// belt-and-braces archived-parent sweep (migrations/auth/0035) reaps it.
async function releaseArchivedJob(
  authPool: Pool,
  job: JobPickup,
  claimMarker: string,
): Promise<void> {
  await authPool.query(
    `UPDATE periodic_report_job
        SET status = 'queued',
            processing_started_at = NULL,
            updated_at = NOW()
      WHERE customer_id = $1 AND period = $2
        AND bucket_date = $3::date AND tz = $4
        AND lang = $5 AND model_name = $6 AND model = $7
        AND generation = $8
        AND status = 'processing'
        AND processing_started_at::text = $9`,
    [
      job.customer_id,
      job.period,
      job.bucket_date,
      job.tz,
      job.lang,
      job.model_name,
      job.model,
      job.generation,
      claimMarker,
    ],
  );
}

async function finalizeJob(
  authPool: Pool,
  job: JobPickup,
  claimMarker: string,
): Promise<void> {
  await authPool.query(
    `UPDATE periodic_report_job
        SET status = 'done',
            last_generated_at = NOW(),
            next_due_at = CASE WHEN period = 'LIVE'
                               THEN NOW() + ($8 || ' minutes')::interval
                               ELSE NULL END,
            last_error = NULL,
            dry_run = FALSE,
            updated_at = NOW()
      WHERE customer_id = $1 AND period = $2
        AND bucket_date = $3::date AND tz = $4
        AND lang = $5 AND model_name = $6 AND model = $7
        AND generation = $9
        AND status = 'processing'
        AND processing_started_at::text = $10`,
    [
      job.customer_id,
      job.period,
      job.bucket_date,
      job.tz,
      job.lang,
      job.model_name,
      job.model,
      LIVE_REFRESH_MINUTES,
      job.generation,
      claimMarker,
    ],
  );
}

async function failJob(
  authPool: Pool,
  job: JobPickup,
  reason: string,
  claimMarker: string,
  opts: { attempts?: number } = {},
): Promise<void> {
  const nextAttempts = opts.attempts ?? job.attempts;
  await authPool.query(
    `UPDATE periodic_report_job
        SET status = 'failed',
            attempts = $8,
            last_error = $9,
            updated_at = NOW()
      WHERE customer_id = $1 AND period = $2
        AND bucket_date = $3::date AND tz = $4
        AND lang = $5 AND model_name = $6 AND model = $7
        AND generation = $10
        AND status = 'processing'
        AND processing_started_at::text = $11`,
    [
      job.customer_id,
      job.period,
      job.bucket_date,
      job.tz,
      job.lang,
      job.model_name,
      job.model,
      nextAttempts,
      reason,
      job.generation,
      claimMarker,
    ],
  );
}

async function requeueWithBackoff(
  authPool: Pool,
  job: JobPickup,
  reason: string,
  claimMarker: string,
): Promise<void> {
  const nextAttempts = job.attempts + 1;
  const terminal = nextAttempts >= MAX_ATTEMPTS;
  await authPool.query(
    `UPDATE periodic_report_job
        SET status = ${terminal ? "'failed'" : "'queued'"},
            attempts = $8,
            last_error = $9,
            processing_started_at = ${terminal ? "processing_started_at" : "NULL"},
            updated_at = NOW()
      WHERE customer_id = $1 AND period = $2
        AND bucket_date = $3::date AND tz = $4
        AND lang = $5 AND model_name = $6 AND model = $7
        AND generation = $10
        AND status = 'processing'
        AND processing_started_at::text = $11`,
    [
      job.customer_id,
      job.period,
      job.bucket_date,
      job.tz,
      job.lang,
      job.model_name,
      job.model,
      nextAttempts,
      reason,
      job.generation,
      claimMarker,
    ],
  );
}

// ---------------------------------------------------------------------------
// Tick + recovery + seeding (exported for the analysis-job-worker)
// ---------------------------------------------------------------------------

export async function tickReportJobsOnce(
  authPool: Pool,
  limit: number,
  opts: ProcessOptions = { authPool },
): Promise<number> {
  const client = await authPool.connect();
  let picks: JobPickup[] = [];
  try {
    await client.query("BEGIN");
    picks = await pickQueuedReportJobs(client, limit);
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }

  for (const job of picks) {
    const lockId = customerLockId(job.customer_id);
    const lockId2 = jobReportLockId2(job);
    const lockClient = await authPool.connect();
    try {
      const lockRes = await lockClient.query<{ locked: boolean }>(
        `SELECT pg_try_advisory_lock($1, $2) AS locked`,
        [lockId, lockId2],
      );
      if (!lockRes.rows[0]?.locked) continue;
      try {
        await processReportJob(job, opts);
      } finally {
        await lockClient
          .query(`SELECT pg_advisory_unlock($1, $2)`, [lockId, lockId2])
          .catch(() => {});
      }
    } catch (err) {
      console.error("[report-worker] processReportJob failed:", err);
    } finally {
      lockClient.release();
    }
  }
  return picks.length;
}

// Watchdog: return rows stuck in `processing` past the timeout to
// `queued` and clear their `processing_started_at`. Clearing the column
// is what neutralizes the timed-out attempt: its captured `claimMarker`
// no longer matches any row, so if it returns late its
// finalize/fail/requeue match zero rows (#297 review round 5, item 1).
export async function recoverStuckReportJobs(authPool: Pool): Promise<void> {
  await authPool.query(
    `UPDATE periodic_report_job
        SET status = 'queued',
            processing_started_at = NULL,
            updated_at = NOW()
      WHERE status = 'processing'
        AND dry_run = FALSE
        AND period IN ('LIVE', 'DAILY')
        AND (processing_started_at IS NULL
             OR processing_started_at <= NOW() - ($1 || ' minutes')::interval)`,
    [PROCESSING_TIMEOUT_MINUTES],
  );
}

/**
 * Seed a real (non-dry-run) job row for every `ready`/`dirty`
 * LIVE/DAILY state row that lacks one for the default variant. Mirrors
 * `seedRealStoryJobs`: a `dirty` row bumps an existing job's generation
 * (capped at `ANALYSIS_MAX_GENERATION`) or seeds a fresh generation-1
 * job when none exists, then returns the state to `ready`. Archived
 * rows are never enqueued (#294 decision 1); WEEKLY/MONTHLY are skipped
 * (round-14 item 4) until #298.
 */
export async function seedRealReportJobs(
  authClient: PoolClient,
  batchSize: number,
  nowIso: string = getCurrentTimestamp().toISOString(),
): Promise<void> {
  const { rows: actionable } = await authClient.query<{
    customer_id: string;
    period: string;
    bucket_date: string;
    tz: string;
    status: "ready" | "dirty";
  }>(
    `SELECT s.customer_id::text AS customer_id,
            s.period,
            s.bucket_date::text AS bucket_date,
            s.tz,
            s.status
       FROM periodic_report_state s
      WHERE s.period IN ('LIVE', 'DAILY')
        AND (s.status = 'dirty'
             OR (s.status = 'ready'
                 AND NOT EXISTS (
                   SELECT 1 FROM periodic_report_job j
                    WHERE j.customer_id = s.customer_id
                      AND j.period = s.period
                      AND j.bucket_date = s.bucket_date
                      AND j.tz = s.tz
                      AND j.lang = $2 AND j.model_name = $3 AND j.model = $4
                 )))
      ORDER BY s.customer_id, s.period, s.bucket_date, s.tz
      LIMIT $1
      FOR UPDATE SKIP LOCKED`,
    [batchSize, WORKER_LANG, WORKER_MODEL_NAME, WORKER_MODEL],
  );

  for (const row of actionable) {
    const keyParams = [
      row.customer_id,
      row.period,
      row.bucket_date,
      row.tz,
      WORKER_LANG,
      WORKER_MODEL_NAME,
      WORKER_MODEL,
    ];
    if (row.status === "dirty") {
      const { rows: existing } = await authClient.query<{
        generation: number;
      }>(
        `SELECT generation FROM periodic_report_job
          WHERE customer_id = $1 AND period = $2
            AND bucket_date = $3::date AND tz = $4
            AND lang = $5 AND model_name = $6 AND model = $7`,
        keyParams,
      );
      if (existing.length === 0) {
        await authClient.query(
          `INSERT INTO periodic_report_job
             (customer_id, period, bucket_date, tz, lang, model_name, model,
              status, generation, dry_run, created_at, updated_at)
           VALUES ($1, $2, $3::date, $4, $5, $6, $7,
                   'queued', 1, FALSE, $8::timestamptz, $8::timestamptz)
           ON CONFLICT (customer_id, period, bucket_date, tz, lang, model_name, model)
           DO NOTHING`,
          [...keyParams, nowIso],
        );
      } else if (existing[0].generation >= MAX_GENERATION) {
        console.warn(
          JSON.stringify({
            level: "warn",
            event: "analysis.report_max_generation_reached",
            customer_id: row.customer_id,
            period: row.period,
            bucket_date: row.bucket_date,
            tz: row.tz,
            max_generation: MAX_GENERATION,
          }),
        );
      } else {
        await authClient.query(
          // Clear the force metadata so a source-driven (dirty) requeue is
          // never misclassified as an operator force. The columns are
          // sticky on the single per-variant row; without this reset a
          // later automatic generation would inherit a prior operator's
          // force_requested_by and be stamped force=true (#297 review
          // round 7, item 1). Force-queued generations set these afresh in
          // the regenerate endpoint, and their retries (requeueWithBackoff)
          // leave them intact.
          `UPDATE periodic_report_job
              SET generation = generation + 1,
                  status = 'queued',
                  attempts = 0,
                  last_error = NULL,
                  processing_started_at = NULL,
                  dry_run = FALSE,
                  force_requested_at = NULL,
                  force_requested_by = NULL,
                  updated_at = $8::timestamptz
            WHERE customer_id = $1 AND period = $2
              AND bucket_date = $3::date AND tz = $4
              AND lang = $5 AND model_name = $6 AND model = $7
              AND generation < $9`,
          [...keyParams, nowIso, MAX_GENERATION],
        );
      }
      await authClient.query(
        `UPDATE periodic_report_state
            SET status = 'ready',
                last_ready_at = $5::timestamptz,
                updated_at = $5::timestamptz
          WHERE customer_id = $1 AND period = $2
            AND bucket_date = $3::date AND tz = $4
            AND status = 'dirty'`,
        [row.customer_id, row.period, row.bucket_date, row.tz, nowIso],
      );
      continue;
    }
    await authClient.query(
      `INSERT INTO periodic_report_job
         (customer_id, period, bucket_date, tz, lang, model_name, model,
          status, generation, dry_run, created_at, updated_at)
       VALUES ($1, $2, $3::date, $4, $5, $6, $7,
               'queued', 1, FALSE, $8::timestamptz, $8::timestamptz)
       ON CONFLICT (customer_id, period, bucket_date, tz, lang, model_name, model)
       DO NOTHING`,
      [...keyParams, nowIso],
    );
  }
}

/**
 * RFC 0002 §"LIVE re-queue" — re-queue done LIVE variant jobs whose
 * per-variant `next_due_at` cadence has elapsed. Gated by
 * `state.status <> 'archived'` (round-14 item 5): the "regardless of
 * state row status" clause covers `pending|ready|dirty`, not archived
 * (old-tz) rows. Resets the retry budget on the bumped generation.
 *
 * Capped at `ANALYSIS_MAX_GENERATION` like the dirty auto-requeue path in
 * `seedRealReportJobs`: the issue locks "Force is allowed past
 * `ANALYSIS_MAX_GENERATION` (auto-requeue is not)", and the cadence
 * re-queue is an automatic path. A LIVE variant that has reached the cap
 * stays `done` until an operator force-regenerate (which may push past the
 * cap) bumps it; the cap hit is logged for parity with the dirty path.
 */
export async function requeueLiveReportJobs(
  authClient: PoolClient,
  nowIso: string = getCurrentTimestamp().toISOString(),
): Promise<void> {
  // Surface due-but-capped LIVE variants before the bump UPDATE skips them,
  // mirroring the `analysis.report_max_generation_reached` signal that the
  // dirty auto-requeue path emits.
  const { rows: capped } = await authClient.query<{
    customer_id: string;
    period: string;
    bucket_date: string;
    tz: string;
  }>(
    `SELECT j.customer_id::text AS customer_id, j.period,
            j.bucket_date::text AS bucket_date, j.tz
       FROM periodic_report_job j
       JOIN periodic_report_state s
         ON j.customer_id = s.customer_id AND j.period = s.period
        AND j.bucket_date = s.bucket_date AND j.tz = s.tz
      WHERE j.period = 'LIVE'
        AND j.status = 'done'
        AND j.dry_run = FALSE
        AND s.status <> 'archived'
        AND j.next_due_at IS NOT NULL
        AND j.next_due_at <= $1::timestamptz
        AND j.generation >= $2::int`,
    [nowIso, MAX_GENERATION],
  );
  for (const row of capped) {
    console.warn(
      JSON.stringify({
        level: "warn",
        event: "analysis.report_max_generation_reached",
        customer_id: row.customer_id,
        period: row.period,
        bucket_date: row.bucket_date,
        tz: row.tz,
        max_generation: MAX_GENERATION,
      }),
    );
  }
  await authClient.query(
    // Clear the force metadata: a cadence-driven LIVE bump is an automatic
    // generation and must not inherit a prior operator force from the
    // sticky per-variant columns (#297 review round 7, item 1). The
    // regenerate endpoint re-sets them for a genuine force; retries via
    // requeueWithBackoff preserve them.
    `UPDATE periodic_report_job j
        SET status = 'queued',
            generation = generation + 1,
            attempts = 0,
            last_error = NULL,
            processing_started_at = NULL,
            force_requested_at = NULL,
            force_requested_by = NULL,
            updated_at = $1::timestamptz
       FROM periodic_report_state s
      WHERE j.customer_id = s.customer_id AND j.period = s.period
        AND j.bucket_date = s.bucket_date AND j.tz = s.tz
        AND j.period = 'LIVE'
        AND j.status = 'done'
        AND j.dry_run = FALSE
        AND s.status <> 'archived'
        AND j.next_due_at IS NOT NULL
        AND j.next_due_at <= $1::timestamptz
        AND j.generation < $2::int`,
    [nowIso, MAX_GENERATION],
  );
}

function jobReportLockId2(job: JobPickup): number {
  const key = `${job.period}|${job.bucket_date}|${job.tz}`;
  let hash = 0;
  for (const ch of key) {
    hash = (hash * 31 + ch.charCodeAt(0)) | 0;
  }
  return Math.abs(hash) | 1;
}

export const __testables = {
  classifyAimerError,
  jobReportLockId2,
};
