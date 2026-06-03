// RFC 0002 Phase 2 (#297) — periodic report analysis worker.
//
// Picks up `periodic_report_job` rows with `status='queued',
// dry_run=FALSE, period IN ('LIVE','DAILY','WEEKLY','MONTHLY')`, builds
// the structured
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
// All four periods are in scope (#298): the dispatcher's pickup filter,
// the stuck-job watchdog, and `seedRealReportJobs` cover LIVE + DAILY +
// WEEKLY + MONTHLY. WEEKLY/MONTHLY readiness promotion (the 6h / 12h
// settle) was already wired by Phase 0/2 (`analysis-job-worker.ts`);
// Phase 3 lets those promoted `ready` rows flow into real LLM jobs. The
// input builder feeds the same `PeriodicReportInputs` shape over the
// longer 7-day / calendar-month windows — week/month comparative
// framing is prompt-side only (#298 F2 resolution).

import "server-only";

import { ClientError } from "graphql-request";
import type { Pool, PoolClient } from "pg";
import { localeToLanguage } from "@/i18n/language";
import { auditLog } from "@/lib/audit";
import { customerLockId } from "@/lib/db/customer-db";
import { getCustomerRuntimePool } from "@/lib/db/customer-runtime-pool";
import {
  PeriodicReportDocument,
  type PeriodicReportInputs,
} from "@/lib/graphql/__generated__/generate-periodic-security-report";
import { TranslateReportDocument } from "@/lib/graphql/__generated__/translate-report";
import { graphqlRequest } from "@/lib/graphql/client";
import { getCurrentTimestamp } from "@/lib/instrumentation/time";
import { loadCustomerRanges } from "@/lib/redaction/load-ranges";
import {
  buildCanonicalPinnedReportInput,
  buildPeriodicReportInput,
  buildPinnedTokenRefs,
  type EventRef,
  type PeriodicPeriod,
  type ReportVariant,
  type StoryRef,
} from "./report-input-builder";
import {
  type ReportTokenRef,
  scanReportAnalysisForLeaks,
} from "./report-token";

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

// The LLM server `name` / `model` used on the translate path (#412 item 6).
// They default to the worker's generation defaults but are independently
// configurable, and are recorded as the `periodic_report_job` translation
// audit columns — the translated `periodic_report_result` row keeps the
// English canonical's `model_name`/`model` so the variant key stays
// self-consistent.
const TRANSLATION_MODEL_NAME =
  process.env.ANALYSIS_TRANSLATION_MODEL_NAME ?? WORKER_MODEL_NAME;
const TRANSLATION_MODEL =
  process.env.ANALYSIS_TRANSLATION_MODEL ?? WORKER_MODEL;

// Backoff applied when a non-English job defers because its English
// canonical is not yet available. This is a NON-TERMINAL wait, not a
// failure: the defer leaves `attempts` untouched (never counts toward
// `MAX_ATTEMPTS` / `failed`) and only sets `next_due_at` so the picker
// does not hot-spin (#412 item 4).
const DEFAULT_CANONICAL_DEFER_MS = 30_000;
export const CANONICAL_DEFER_MS = resolveInt(
  process.env.ANALYSIS_CANONICAL_DEFER_MS,
  DEFAULT_CANONICAL_DEFER_MS,
);

// `DEFAULT_LOCALE` is the global app UI locale (`en` / `ko`), mirrored from
// `src/i18n/routing.ts` (same `?? "ko"` fallback). It is read directly here
// rather than imported so the worker stays free of next-intl.
const DEFAULT_LOCALE = process.env.DEFAULT_LOCALE ?? "ko";

// Eager language set seeded natively for every report bucket (#389 Part A,
// correction #4): English baseline ∪ the app default-locale language ∪ the
// legacy `ANALYSIS_DEFAULT_LANG` knob (`WORKER_LANG`). This is a UNION, never
// a replacement — a deployment that set `ANALYSIS_DEFAULT_LANG=KOREAN`
// keeps Korean, and English is always present as the guaranteed baseline.
// Deduplicated, so it collapses to a single entry when all three coincide
// (e.g. `DEFAULT_LOCALE=en` with `WORKER_LANG=ENGLISH`). Every entry is
// generated natively via the existing `generatePeriodicSecurityReport`
// mutation — no aimer change and, since each language is independent, no
// cross-variant ordering dependency on the English canonical.
export const EAGER_LANGS = Array.from(
  new Set<string>([
    DEFAULT_LANG,
    localeToLanguage(DEFAULT_LOCALE),
    WORKER_LANG,
  ]),
);

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

// aimer's `PeriodicSecurityReportResult`: a single JSON-encoded `sections`
// string (executive summary, story highlights, notable events, baseline
// observations, period outlook) plus the prompt / model snapshot markers.
// The legacy 5-narrative-field shape was a vendored fiction no aimer build
// exposed (#360).
interface ReportAimerResponse {
  sections: string;
  promptVersion: string;
  modelActualVersion: string;
}

// Shape the worker persists to `periodic_report_result.sections_jsonb`,
// parsed from aimer's JSON `sections` string. The keys are the prompt's
// structured-output sections; the page loader reads them back by name and
// tolerates absent keys, so the worker stores the parsed object verbatim.
type ReportSectionsJson = Record<string, unknown>;

interface AuditEmissionBase {
  actorId: string;
  authContext: "general";
  targetType: string;
  customerId: string;
  aiceId: string | undefined;
}

// ---------------------------------------------------------------------------
// aimer `sections` JSON parsing
// ---------------------------------------------------------------------------

/**
 * Parse aimer's JSON-encoded `sections` payload into a section object.
 * Throws on a non-JSON body or a non-object top level (array / scalar) — the
 * caller treats either as a fatal `report_sections_parse_failed`.
 */
function parseReportSections(raw: string): ReportSectionsJson {
  const parsed: unknown = JSON.parse(raw);
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("sections payload is not a JSON object");
  }
  return parsed as ReportSectionsJson;
}

/**
 * Collect every string leaf in the parsed sections payload (depth-first) so
 * the hallucination scan covers all rendered narrative regardless of the
 * prompt's section key names or nesting.
 */
function collectSectionStrings(value: unknown): string[] {
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) return value.flatMap(collectSectionStrings);
  if (value !== null && typeof value === "object") {
    return Object.values(value).flatMap(collectSectionStrings);
  }
  return [];
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
        AND j.period IN ('LIVE', 'DAILY', 'WEEKLY', 'MONTHLY')
        -- Skip jobs whose parent state archived after queueing (e.g. a
        -- timezone change archives the old-tz state without deleting its
        -- jobs). A terminal archived state must never reach the LLM /
        -- result write (#297 review round 2, item 2). The claim step
        -- re-checks this to close the pickup→claim archive window.
        AND s.status <> 'archived'
        -- Honor a per-variant next_due_at for queued rows (#412 item 4):
        -- the non-terminal canonical-defer path sets a future next_due_at
        -- WITHOUT touching attempts, so without this gate the row would be
        -- re-picked on the very next tick (hot spin). Immediate-queue paths
        -- (dirty bump, regenerate, on-demand requeue, stuck recovery) reset
        -- next_due_at = NULL so they are not stalled by a leftover future
        -- value left over from the LIVE cadence.
        AND (j.next_due_at IS NULL OR j.next_due_at <= NOW())
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
  callTranslateReport?: typeof callTranslateReport;
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
        -- Re-check next_due_at at claim time, mirroring the picker filter
        -- (report-worker.ts pickQueuedReportJobs). Pickup and claim are
        -- split, so a concurrent tick can hold a stale JobPickup for this
        -- row from before another worker deferred it. The non-terminal
        -- canonical-defer leaves status='queued' and attempts unchanged
        -- while setting a future next_due_at, so without this gate the
        -- stale worker would still satisfy status/generation/attempts and
        -- claim the just-deferred row — bypassing the defer backoff
        -- (immediate re-defer, or generate/translate the instant the
        -- canonical appears mid-window). This closes the pickup→claim
        -- window the same way the archived-parent EXISTS check below does
        -- (#412 review round 2).
        AND (next_due_at IS NULL OR next_due_at <= NOW())
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

  const auditBase: AuditEmissionBase = {
    actorId: WORKER_ACCOUNT_ID,
    authContext: "general",
    targetType: "periodic_report_result",
    customerId: job.customer_id,
    aiceId: PERIODIC_WORKER_AICE_ID,
  };

  // --- Native-vs-translate routing (#389 PR #3 / #412) ---------------
  // The English variant IS the canonical: report-scope `R{j}` tokens are
  // numbered from its leaf ordering, so it is always generated natively
  // from the top-K selection. Every non-English variant must be
  // consistent with that ordering — either generated natively from the
  // EXACT same cited leaves (when they all exist in the target lang) or
  // translated from the canonical's stored `sections`.
  if (job.lang === DEFAULT_LANG) {
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
    await runNativeGeneration({
      job,
      opts,
      customerPool,
      claimMarker,
      built,
      auditBase,
      callLlm,
    });
    return;
  }

  // Non-English: the English canonical must already exist (its result row
  // is the source of both the pinned ref set and the translate input). If
  // it is absent / not yet done, defer WITHOUT consuming the retry/failure
  // budget — "canonical not ready" is a normal wait, not a failure (#412
  // item 4). The defer sets `next_due_at` (honored by the picker) so the
  // job does not hot-spin, and leaves `attempts` untouched.
  const canonical = await loadEnglishCanonical(customerPool, job);
  if (canonical === null) {
    await deferJobForCanonical(opts.authPool, job, claimMarker);
    // Operational signal only (parity with `report_pickup_race_lost`): a
    // defer is a normal wait, not an analysis event, so it does not emit an
    // `ai_analysis.*` audit entry.
    console.warn(
      JSON.stringify({
        level: "warn",
        event: "analysis.report_canonical_defer",
        customer_id: job.customer_id,
        period: job.period,
        bucket_date: job.bucket_date,
        tz: job.tz,
        lang: job.lang,
        model_name: job.model_name,
        model: job.model,
        generation: job.generation,
        reason: "english_canonical_not_ready",
      }),
    );
    return;
  }

  // Completeness gate: build the input pinned to the canonical's exact
  // refs in the target lang. If every cited leaf exists there, generate
  // natively (same `R{j}` numbering as English); otherwise translate.
  const pinned = await buildCanonicalPinnedReportInput({
    customerPool,
    period: job.period,
    bucketDate: job.bucket_date,
    variant,
    nowIso,
    storyRefs: canonical.storyRefs,
    eventRefs: canonical.eventRefs,
  });
  if (pinned.complete) {
    await runNativeGeneration({
      job,
      opts,
      customerPool,
      claimMarker,
      built: pinned.built,
      auditBase,
      callLlm,
    });
    return;
  }
  await runTranslation({
    job,
    opts,
    customerPool,
    claimMarker,
    canonical,
    auditBase,
  });
}

// ---------------------------------------------------------------------------
// Native generation (English canonical + completeness-satisfied non-English)
// ---------------------------------------------------------------------------

/**
 * Run the redaction precondition → LLM generate → leak scan → result
 * write → finalize sequence for a natively-generated variant. Shared by
 * the English canonical path and the canonical-ref-pinned non-English path
 * (the only difference between them is how `built` was assembled). A
 * natively-generated row sets `restoration_lang = NULL` — its cited leaves
 * exist in its own language, so the loader replays them at the row's lang.
 */
async function runNativeGeneration(args: {
  job: JobPickup;
  opts: ProcessOptions;
  customerPool: Pool;
  claimMarker: string;
  built: Awaited<ReturnType<typeof buildPeriodicReportInput>>;
  auditBase: AuditEmissionBase;
  callLlm: typeof callGenerateReport;
}): Promise<void> {
  const { job, opts, customerPool, claimMarker, built, auditBase, callLlm } =
    args;

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

  // Parse aimer's JSON `sections` payload. A malformed body is a fatal
  // (non-retryable) defect in the provider response — aimer guarantees a
  // JSON object or raises its own error envelope — so fail loudly rather
  // than persist an uninterpretable blob.
  let parsedSections: ReportSectionsJson;
  try {
    parsedSections = parseReportSections(aimerResponse.sections);
  } catch (err) {
    void auditLog({
      ...auditBase,
      action: "ai_analysis.aimer_call_failed",
      targetId: reportTargetId(job),
      details: {
        generation: job.generation,
        code: "report_sections_parse_failed",
        error: err instanceof Error ? err.message : String(err),
      },
    });
    await failJob(
      opts.authPool,
      job,
      "report_sections_parse_failed",
      claimMarker,
      { attempts: job.attempts + 1 },
    );
    return;
  }

  // Hallucination scan across every rendered section. The section keys are
  // prompt-defined, so scan every string value in the parsed payload rather
  // than a fixed field list.
  const ranges = await (opts.loadRanges ?? loadCustomerRanges)(
    opts.authPool,
    job.customer_id,
  );
  const reportText = collectSectionStrings(parsedSections).join("\n\n");
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
    await writeResultRow(customerPool, job, {
      modelActualVersion: aimerResponse.modelActualVersion,
      promptVersion: aimerResponse.promptVersion,
      aggregateSeverityScore: built.aggregateSeverityScore,
      aggregateLikelihoodScore: built.aggregateLikelihoodScore,
      aggregateTtpTags: built.aggregateTtpTags,
      priorityTier: built.priorityTier,
      sections: parsedSections,
      eventRefs: built.eventRefs,
      storyRefs: built.storyRefs,
      inputHash: built.inputHash,
      inputWatermark,
      redactionPolicyVersion,
      requestedBy: force ? job.force_requested_by : null,
      // Native: the cited leaves exist in this row's own language, so the
      // loader replays them at `lang` (no restoration language pin).
      restorationLang: null,
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
      native: true,
    },
  });
}

// ---------------------------------------------------------------------------
// Translate path (non-English, canonical cited-leaf set incomplete)
// ---------------------------------------------------------------------------

/**
 * Translate the English canonical's stored `sections` into the job's
 * target language via aimer's `translatePeriodicSecurityReport`, leak-scan
 * the result against the canonical's report-scope tokens, and persist a
 * row that copies the canonical's refs / metadata verbatim with
 * `restoration_lang = ENGLISH` (so the loader replays the English leaves).
 * The model / prompt actually used to translate go to the
 * `periodic_report_job` audit columns, NOT the result row's variant key.
 */
async function runTranslation(args: {
  job: JobPickup;
  opts: ProcessOptions;
  customerPool: Pool;
  claimMarker: string;
  canonical: EnglishCanonical;
  auditBase: AuditEmissionBase;
}): Promise<void> {
  const { job, opts, customerPool, claimMarker, canonical, auditBase } = args;
  const callTranslate = opts.callTranslateReport ?? callTranslateReport;

  // Reconstruct the canonical's report-scope token refs from the English
  // cited leaves so the leak scan has the exact `allowedTokens` set. If the
  // English leaves are unexpectedly gone, refuse to persist (the scan
  // cannot validate) and fail loudly rather than store an unverifiable row.
  const englishVariant: ReportVariant = {
    tz: job.tz,
    lang: DEFAULT_LANG,
    modelName: canonical.modelName,
    model: canonical.model,
  };
  const tokenRefs: ReportTokenRef[] | null = await buildPinnedTokenRefs(
    customerPool,
    englishVariant,
    canonical.storyRefs,
    canonical.eventRefs,
  );
  if (tokenRefs === null) {
    await failJob(opts.authPool, job, "canonical_leaves_missing", claimMarker, {
      attempts: job.attempts + 1,
    });
    return;
  }

  // Re-check the parent state immediately before the LLM call (parity with
  // the native path's claim→call barrier).
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
      translate: true,
      translation_model_name: TRANSLATION_MODEL_NAME,
      translation_model: TRANSLATION_MODEL,
      actor_aice_id: PERIODIC_WORKER_AICE_ID,
    },
  });

  let aimerResponse: ReportAimerResponse;
  try {
    aimerResponse = await callTranslate({
      customerId: job.customer_id,
      sections: canonical.sectionsString,
      targetLang: job.lang,
      modelName: TRANSLATION_MODEL_NAME,
      model: TRANSLATION_MODEL,
    });
  } catch (err) {
    const classification = classifyAimerError(err);
    void auditLog({
      ...auditBase,
      action: "ai_analysis.aimer_call_failed",
      targetId: reportTargetId(job),
      details: {
        generation: job.generation,
        stage: "translate",
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

  let parsedSections: ReportSectionsJson;
  try {
    parsedSections = parseReportSections(aimerResponse.sections);
  } catch (err) {
    void auditLog({
      ...auditBase,
      action: "ai_analysis.aimer_call_failed",
      targetId: reportTargetId(job),
      details: {
        generation: job.generation,
        stage: "translate",
        code: "report_sections_parse_failed",
        error: err instanceof Error ? err.message : String(err),
      },
    });
    await failJob(
      opts.authPool,
      job,
      "report_sections_parse_failed",
      claimMarker,
      { attempts: job.attempts + 1 },
    );
    return;
  }

  // Leak scan on the translated output: aimer's translate mutation
  // preserves every redaction token verbatim, so the same `allowedTokens`
  // derived from the English leaves must cover the translated text. Any
  // residual / leaked token fails the job BEFORE the row is written (#412
  // item 7).
  const ranges = await (opts.loadRanges ?? loadCustomerRanges)(
    opts.authPool,
    job.customer_id,
  );
  const reportText = collectSectionStrings(parsedSections).join("\n\n");
  const leakScan = scanReportAnalysisForLeaks(reportText, tokenRefs, ranges);
  if (leakScan.hasLeak) {
    void auditLog({
      ...auditBase,
      action: "ai_analysis.hallucination_detected",
      targetId: reportTargetId(job),
      details: {
        generation: job.generation,
        stage: "translate",
        leaks: leakScan.leaks.slice(0, 20),
      },
    });
    await failJob(opts.authPool, job, "hallucination_detected", claimMarker, {
      attempts: job.attempts + 1,
    });
    return;
  }

  // Final archived re-check before the customer-DB write (parity with the
  // native path).
  if (await parentStateArchived(opts.authPool, job)) {
    await releaseArchivedJob(opts.authPool, job, claimMarker);
    return;
  }

  // Step 1 — customer-DB INSERT. The translated row copies the canonical's
  // refs and audit metadata verbatim (`model_name`/`model`/`prompt_version`/
  // `model_actual_version`) so the variant key stays self-consistent, and
  // pins `restoration_lang = ENGLISH` so the loader replays the English
  // cited leaves (#412 items 5 + 6).
  try {
    await writeResultRow(customerPool, job, {
      modelActualVersion: canonical.modelActualVersion,
      promptVersion: canonical.promptVersion,
      aggregateSeverityScore: canonical.aggregateSeverityScore,
      aggregateLikelihoodScore: canonical.aggregateLikelihoodScore,
      aggregateTtpTags: canonical.aggregateTtpTags,
      priorityTier: canonical.priorityTier,
      sections: parsedSections,
      eventRefs: canonical.eventRefs,
      storyRefs: canonical.storyRefs,
      inputHash: canonical.inputHash,
      inputWatermark: canonical.inputWatermark,
      redactionPolicyVersion: canonical.redactionPolicyVersion,
      requestedBy: force ? job.force_requested_by : null,
      restorationLang: DEFAULT_LANG,
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

  // Step 2 — auth-DB finalize, recording the translation audit metadata.
  await finalizeJob(opts.authPool, job, claimMarker, {
    translationModelName: TRANSLATION_MODEL_NAME,
    translationModel: TRANSLATION_MODEL,
    translationPromptVersion: aimerResponse.promptVersion,
  });

  void auditLog({
    ...auditBase,
    action: "ai_analysis.result_stored",
    targetId: reportTargetId(job),
    details: {
      prompt_version: canonical.promptVersion,
      model_actual_version: canonical.modelActualVersion,
      priority_tier: canonical.priorityTier,
      top_story_count: canonical.storyRefs.length,
      top_event_count: canonical.eventRefs.length,
      translate: true,
      restoration_lang: DEFAULT_LANG,
      translation_model_name: TRANSLATION_MODEL_NAME,
      translation_model: TRANSLATION_MODEL,
      translation_prompt_version: aimerResponse.promptVersion,
    },
  });
}

// ---------------------------------------------------------------------------
// English canonical lookup (translate / native-pin source)
// ---------------------------------------------------------------------------

/**
 * The English canonical `periodic_report_result` row a non-English variant
 * derives from: the non-superseded English row at the SAME
 * `(model_name, model, generation)` as the job. The `generation` match is
 * load-bearing — a prior generation's English row stays `superseded_at IS
 * NULL` until the current generation is written, so without it a non-English
 * job bumped to generation N (dirty / force regenerate) could read the stale
 * generation N-1 refs/sections instead of deferring, breaking the
 * canonical-first contract. `null` when no such row exists yet — the caller
 * defers (the canonical for THIS generation is not ready).
 */
interface EnglishCanonical {
  /** JSON string of the stored sections, for the translate mutation input. */
  sectionsString: string;
  storyRefs: StoryRef[];
  eventRefs: EventRef[];
  modelName: string;
  model: string;
  modelActualVersion: string;
  promptVersion: string;
  aggregateSeverityScore: number;
  aggregateLikelihoodScore: number;
  aggregateTtpTags: string[];
  priorityTier: string;
  inputHash: string;
  inputWatermark: Date | null;
  redactionPolicyVersion: string;
}

async function loadEnglishCanonical(
  customerPool: Pool,
  job: JobPickup,
): Promise<EnglishCanonical | null> {
  const { rows } = await customerPool.query<{
    sections_jsonb: ReportSectionsJson;
    input_story_refs: StoryRef[] | null;
    input_event_refs: EventRef[] | null;
    model_name: string;
    model: string;
    model_actual_version: string;
    prompt_version: string;
    aggregate_severity_score: number;
    aggregate_likelihood_score: number;
    aggregate_ttp_tags: string[] | null;
    priority_tier: string;
    input_hash: string;
    input_watermark: Date | null;
    redaction_policy_version: string;
  }>(
    `SELECT sections_jsonb,
            input_story_refs, input_event_refs,
            model_name, model, model_actual_version, prompt_version,
            aggregate_severity_score, aggregate_likelihood_score,
            aggregate_ttp_tags, priority_tier,
            input_hash, input_watermark, redaction_policy_version
       FROM periodic_report_result
      WHERE customer_id = $1 AND period = $2
        AND bucket_date = $3::date AND tz = $4
        AND lang = $5 AND model_name = $6 AND model = $7
        AND generation = $8
        AND superseded_at IS NULL
      LIMIT 1`,
    [
      job.customer_id,
      job.period,
      job.bucket_date,
      job.tz,
      DEFAULT_LANG,
      job.model_name,
      job.model,
      job.generation,
    ],
  );
  if (rows.length === 0) return null;
  const r = rows[0];
  return {
    sectionsString: JSON.stringify(r.sections_jsonb ?? {}),
    storyRefs: Array.isArray(r.input_story_refs) ? r.input_story_refs : [],
    eventRefs: Array.isArray(r.input_event_refs) ? r.input_event_refs : [],
    modelName: r.model_name,
    model: r.model,
    modelActualVersion: r.model_actual_version,
    promptVersion: r.prompt_version,
    aggregateSeverityScore: r.aggregate_severity_score,
    aggregateLikelihoodScore: r.aggregate_likelihood_score,
    aggregateTtpTags: Array.isArray(r.aggregate_ttp_tags)
      ? r.aggregate_ttp_tags
      : [],
    priorityTier: r.priority_tier,
    inputHash: r.input_hash,
    inputWatermark: r.input_watermark,
    redactionPolicyVersion: r.redaction_policy_version,
  };
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
  inputs: PeriodicReportInputs;
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

// Translate-path call wrapper — aimer's stateless, token-preserving
// `translatePeriodicSecurityReport` mutation (#412 / aimer #459). Returns
// the same `PeriodicSecurityReportResult` shape as the generate path.
async function callTranslateReport(args: {
  customerId: string;
  sections: string;
  targetLang: string;
  modelName: string;
  model: string;
}): Promise<ReportAimerResponse> {
  const result = await graphqlRequest(
    TranslateReportDocument,
    {
      customerId: args.customerId,
      sections: args.sections,
      targetLang: args.targetLang as "KOREAN" | "ENGLISH",
      model: args.model,
      name: args.modelName,
    },
    { accountId: WORKER_ACCOUNT_ID, aiceId: PERIODIC_WORKER_AICE_ID },
  );
  return result.translatePeriodicSecurityReport;
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

// Column values for a `periodic_report_result` row, supplied explicitly so
// the native path (sources them from `built` + the generate response) and
// the translate path (copies the canonical's metadata, with translated
// `sections` and `restoration_lang = ENGLISH`) share one writer.
interface ResultRowValues {
  modelActualVersion: string;
  promptVersion: string;
  aggregateSeverityScore: number;
  aggregateLikelihoodScore: number;
  aggregateTtpTags: string[];
  priorityTier: string;
  sections: ReportSectionsJson;
  eventRefs: EventRef[];
  storyRefs: StoryRef[];
  inputHash: string;
  inputWatermark: Date | null;
  redactionPolicyVersion: string;
  requestedBy: string | null;
  /** NULL = replay leaves at the row's own `lang`; an enum pins the replay. */
  restorationLang: string | null;
}

async function writeResultRow(
  customerPool: Pool,
  job: JobPickup,
  values: ResultRowValues,
): Promise<void> {
  const client = await customerPool.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      `INSERT INTO periodic_report_result
         (customer_id, period, bucket_date, tz, lang, restoration_lang,
          model_name, model,
          model_actual_version, prompt_version, generation,
          aggregate_severity_score, aggregate_likelihood_score,
          aggregate_ttp_tags, priority_tier, sections_jsonb,
          input_event_refs, input_story_refs, input_hash, input_watermark,
          redaction_policy_version, requested_by)
       VALUES ($1, $2, $3::date, $4, $5, $6,
               $7, $8,
               $9, $10, $11,
               $12, $13,
               $14::jsonb, $15, $16::jsonb,
               $17::jsonb, $18::jsonb, $19, $20,
               $21, $22::uuid)`,
      [
        job.customer_id,
        job.period,
        job.bucket_date,
        job.tz,
        job.lang,
        values.restorationLang,
        job.model_name,
        job.model,
        values.modelActualVersion,
        values.promptVersion,
        job.generation,
        values.aggregateSeverityScore,
        values.aggregateLikelihoodScore,
        JSON.stringify(values.aggregateTtpTags),
        values.priorityTier,
        JSON.stringify(values.sections),
        JSON.stringify(values.eventRefs),
        JSON.stringify(values.storyRefs),
        values.inputHash,
        values.inputWatermark,
        values.redactionPolicyVersion,
        values.requestedBy,
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
            next_due_at = NULL,
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

// Defer a non-English job whose English canonical is not yet available.
// NON-TERMINAL: leaves `status = 'queued'` and `attempts` UNCHANGED (never
// counts toward `MAX_ATTEMPTS` / `failed`), and sets `next_due_at` so the
// picker — which now honors `next_due_at` for queued rows — does not
// re-pick it on the next tick (no hot spin). Keyed by the claim marker so a
// stale timed-out attempt cannot defer a later re-claimed one (#412 item 4).
async function deferJobForCanonical(
  authPool: Pool,
  job: JobPickup,
  claimMarker: string,
): Promise<void> {
  await authPool.query(
    `UPDATE periodic_report_job
        SET status = 'queued',
            processing_started_at = NULL,
            next_due_at = NOW() + ($8::bigint * interval '1 millisecond'),
            last_error = 'english_canonical_not_ready',
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
      CANONICAL_DEFER_MS,
      job.generation,
      claimMarker,
    ],
  );
}

interface TranslationAudit {
  translationModelName: string;
  translationModel: string;
  translationPromptVersion: string;
}

async function finalizeJob(
  authPool: Pool,
  job: JobPickup,
  claimMarker: string,
  translation?: TranslationAudit,
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
            -- Audit columns: set on the translate path, cleared (NULL) on
            -- the native path so a variant that flips translate→native
            -- across generations does not carry a stale audit trail.
            translation_model_name = $11,
            translation_model = $12,
            translation_prompt_version = $13,
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
      translation?.translationModelName ?? null,
      translation?.translationModel ?? null,
      translation?.translationPromptVersion ?? null,
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
    // Reset next_due_at on the non-terminal requeue so retry timing is
    // governed solely by the attempts-based backoff in the picker, not by
    // a leftover future next_due_at (e.g. a LIVE cadence value). Terminal
    // (failed) rows are not re-picked, so their next_due_at is irrelevant.
    `UPDATE periodic_report_job
        SET status = ${terminal ? "'failed'" : "'queued'"},
            attempts = $8,
            last_error = $9,
            processing_started_at = ${terminal ? "processing_started_at" : "NULL"},
            next_due_at = ${terminal ? "next_due_at" : "NULL"},
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
    // Reset next_due_at too: a stuck row is being returned for IMMEDIATE
    // reprocessing, so a leftover future cadence value must not stall it now
    // that the picker honors next_due_at for queued rows (#412 item 4).
    `UPDATE periodic_report_job
        SET status = 'queued',
            processing_started_at = NULL,
            next_due_at = NULL,
            updated_at = NOW()
      WHERE status = 'processing'
        AND dry_run = FALSE
        AND period IN ('LIVE', 'DAILY', 'WEEKLY', 'MONTHLY')
        AND (processing_started_at IS NULL
             OR processing_started_at <= NOW() - ($1 || ' minutes')::interval)`,
    [PROCESSING_TIMEOUT_MINUTES],
  );
}

/**
 * Seed a real (non-dry-run) job row for every `ready`/`dirty` state row
 * (all four periods) that is missing a job for any language in the eager
 * set (`EAGER_LANGS` — English baseline ∪ default-locale language ∪
 * `WORKER_LANG`, #389 Part A). Mirrors `seedRealStoryJobs`.
 *
 * The eager set is seeded "along the language dimension only": every entry
 * shares the default model variant (`WORKER_MODEL_NAME` / `WORKER_MODEL`)
 * and is generated natively via the existing `lang`-accepting mutation, so
 * the schedule/state-machine contract is untouched — only job rows are
 * added. A `ready` bucket that already has English but not the
 * default-locale language is therefore still actionable: the missing
 * eager-language job is seeded.
 *
 * A `dirty` row bumps the generation of *every* existing variant job
 * underneath it — not just the eager set — because RFC 0002's dirty rule
 * re-queues all variant jobs under the state, and force-created
 * non-default variants (alternate model, on-demand language) are equally
 * invalidated when their bucket's source data changes (#297 review round 8,
 * item 1). Each bump is capped at `ANALYSIS_MAX_GENERATION`, then any
 * still-missing eager-language job is seeded at generation 1 and the state
 * returns to `ready`. Archived rows are never enqueued (#294 decision 1);
 * all four periods (LIVE/DAILY/WEEKLY/MONTHLY) are seeded as of #298.
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
    // A `ready` state is actionable when ANY eager-set language lacks a job
    // (anti-join over `unnest($2)`), so a bucket that has English but not the
    // default-locale language is still picked up and the missing language
    // seeded.
    `SELECT s.customer_id::text AS customer_id,
            s.period,
            s.bucket_date::text AS bucket_date,
            s.tz,
            s.status
       FROM periodic_report_state s
      WHERE s.period IN ('LIVE', 'DAILY', 'WEEKLY', 'MONTHLY')
        AND (s.status = 'dirty'
             OR (s.status = 'ready'
                 AND EXISTS (
                   SELECT 1 FROM unnest($2::text[]) AS el(lang)
                    WHERE NOT EXISTS (
                      SELECT 1 FROM periodic_report_job j
                       WHERE j.customer_id = s.customer_id
                         AND j.period = s.period
                         AND j.bucket_date = s.bucket_date
                         AND j.tz = s.tz
                         AND j.lang = el.lang
                         AND j.model_name = $3 AND j.model = $4
                    )
                 )))
      ORDER BY s.customer_id, s.period, s.bucket_date, s.tz
      LIMIT $1
      FOR UPDATE SKIP LOCKED`,
    [batchSize, EAGER_LANGS, WORKER_MODEL_NAME, WORKER_MODEL],
  );

  for (const row of actionable) {
    if (row.status === "dirty") {
      const stateKey = [row.customer_id, row.period, row.bucket_date, row.tz];
      // Surface every existing variant already at the cap (parity with the
      // LIVE cadence path's pre-bump warn). An at-cap variant cannot
      // auto-bump on a dirty signal; only an operator force may push past
      // the cap.
      const { rows: capped } = await authClient.query<{
        lang: string;
        model_name: string;
        model: string;
      }>(
        `SELECT lang, model_name, model FROM periodic_report_job
          WHERE customer_id = $1 AND period = $2
            AND bucket_date = $3::date AND tz = $4
            AND generation >= $5`,
        [...stateKey, MAX_GENERATION],
      );
      for (const variant of capped) {
        console.warn(
          JSON.stringify({
            level: "warn",
            event: "analysis.report_max_generation_reached",
            customer_id: row.customer_id,
            period: row.period,
            bucket_date: row.bucket_date,
            tz: row.tz,
            lang: variant.lang,
            model_name: variant.model_name,
            model: variant.model,
            max_generation: MAX_GENERATION,
          }),
        );
      }
      // Bump every existing variant job under the dirty state, not just the
      // default one. A force-created non-default variant (e.g. Korean or an
      // alternate model, now reachable via regenerate/summary/detail page)
      // is also invalidated when its bucket's source data changes; bumping
      // only the default left those variants' `periodic_report_result` rows
      // serving a stale generation indefinitely (#297 review round 8,
      // item 1). Clearing the force metadata keeps a source-driven bump
      // classified automatic (round 7, item 1); each row's cap is honored
      // via `generation < MAX_GENERATION`, so a capped variant is skipped
      // here (and was warned above).
      await authClient.query(
        // Reset next_due_at: a dirty (source-driven) bump must process
        // promptly, but now that the picker honors next_due_at for queued
        // rows, a LIVE done variant carrying a future cadence next_due_at
        // would otherwise be stalled past the bump (#412 item 4).
        `UPDATE periodic_report_job
            SET generation = generation + 1,
                status = 'queued',
                attempts = 0,
                last_error = NULL,
                processing_started_at = NULL,
                next_due_at = NULL,
                dry_run = FALSE,
                force_requested_at = NULL,
                force_requested_by = NULL,
                updated_at = $5::timestamptz
          WHERE customer_id = $1 AND period = $2
            AND bucket_date = $3::date AND tz = $4
            AND generation < $6`,
        [...stateKey, nowIso, MAX_GENERATION],
      );
      // Seed any still-missing eager-language variant (parity with the
      // `ready` seeding branch — the system invariant is that every
      // LIVE/DAILY state carries the full eager set). ON CONFLICT DO NOTHING
      // leaves a variant that was just bumped above — or one already at the
      // cap — untouched.
      await seedEagerLangJobs(authClient, row, nowIso);
      await authClient.query(
        `UPDATE periodic_report_state
            SET status = 'ready',
                last_ready_at = $5::timestamptz,
                updated_at = $5::timestamptz
          WHERE customer_id = $1 AND period = $2
            AND bucket_date = $3::date AND tz = $4
            AND status = 'dirty'`,
        [...stateKey, nowIso],
      );
      continue;
    }
    await seedEagerLangJobs(authClient, row, nowIso);
  }
}

/**
 * Seed a generation-1 `queued` job for every eager-set language that does
 * not already have one under this state. ON CONFLICT DO NOTHING makes it
 * idempotent, so an existing variant (default or on-demand) is left
 * untouched and only the genuinely-missing languages get a row. Every
 * eager language shares the default model variant and is generated
 * natively (#389 Part A).
 */
async function seedEagerLangJobs(
  authClient: PoolClient,
  row: { customer_id: string; period: string; bucket_date: string; tz: string },
  nowIso: string,
): Promise<void> {
  for (const lang of EAGER_LANGS) {
    await authClient.query(
      `INSERT INTO periodic_report_job
         (customer_id, period, bucket_date, tz, lang, model_name, model,
          status, generation, dry_run, created_at, updated_at)
       VALUES ($1, $2, $3::date, $4, $5, $6, $7,
               'queued', 1, FALSE, $8::timestamptz, $8::timestamptz)
       ON CONFLICT (customer_id, period, bucket_date, tz, lang, model_name, model)
       DO NOTHING`,
      [
        row.customer_id,
        row.period,
        row.bucket_date,
        row.tz,
        lang,
        WORKER_MODEL_NAME,
        WORKER_MODEL,
        nowIso,
      ],
    );
  }
}

// ---------------------------------------------------------------------------
// On-demand enqueue (coalescing, no force) — #389 Part A
// ---------------------------------------------------------------------------

/** The variant key for an on-demand report-language request. */
export interface OnDemandVariant {
  customerId: string;
  period: string;
  bucketDate: string;
  tz: string;
  lang: string;
  modelName: string;
  model: string;
}

/**
 * Outcome of `enqueueOnDemandReportJob`.
 *   - `seeded`     — no prior row; a fresh generation-1 `queued` job was created.
 *   - `coalesced`  — an existing `queued`/`processing`/`done` job satisfies the
 *                    request; left untouched (no generation bump).
 *   - `requeued`   — an existing `failed` (or leftover dry-run) row was reset to
 *                    `queued` at the SAME generation so the worker retries.
 *   - `state_not_found`    — no parent `periodic_report_state` row exists.
 *   - `source_pending`     — the parent state is still `pending` (not yet
 *                            promoted past its settle window); no job created.
 *   - `source_unavailable` — the parent state is `archived` (terminal).
 */
export type OnDemandEnqueueResult =
  | { action: "seeded"; generation: number; status: "queued" }
  | { action: "coalesced"; generation: number; status: string }
  | { action: "requeued"; generation: number; status: "queued" }
  | { action: "state_not_found" }
  | { action: "source_pending" }
  | { action: "source_unavailable" };

/**
 * Server-side coalescing enqueue for an on-demand report-language variant
 * (#389 Part A — this issue owns the helper and its contract; #388 owns the
 * UI/API that calls it when a user views a not-yet-generated language).
 *
 * Routes through the SAME `periodic_report_job` table and worker as the
 * Regenerate path but WITHOUT its force-regenerate semantics: it never bumps
 * `generation` and never sets `force_requested_*`. An existing in-flight or
 * completed variant (`queued`/`processing`/`done`) coalesces — only a genuine
 * first request seeds a row. A previously `failed` variant (or a leftover
 * dry-run row that the pickup filter would otherwise ignore) is re-queued at
 * the same generation so the worker can produce the report the user is now
 * actively requesting.
 *
 * Only a `ready` or `dirty` parent state is enqueueable — the same states
 * `seedRealReportJobs` acts on. A still-`pending` bucket (settle window not
 * yet elapsed) returns `source_pending` WITHOUT creating a job: because the
 * pickup query only excludes `archived` states (`pickQueuedReportJobs`), a
 * `queued` job seeded under a `pending` state would be dispatched to the LLM
 * before the bucket's normal readiness promotion, bypassing the
 * schedule/state-machine contract this no-force helper must respect (the
 * Regenerate path may force generation; this one must not).
 *
 * The whole operation runs in one transaction with the parent state and the
 * variant row locked `FOR UPDATE`, so concurrent on-demand requests for the
 * same variant serialize onto a single seeded row. Mirrors the regenerate
 * route's source-availability precheck (`state_not_found` / `source_unavailable`)
 * so the caller can map those to 404 / 409 without catching an FK violation.
 */
export async function enqueueOnDemandReportJob(
  authPool: Pool,
  variant: OnDemandVariant,
  nowIso: string = getCurrentTimestamp().toISOString(),
): Promise<OnDemandEnqueueResult> {
  const variantKey = [
    variant.customerId,
    variant.period,
    variant.bucketDate,
    variant.tz,
    variant.lang,
    variant.modelName,
    variant.model,
  ];
  const client = await authPool.connect();
  try {
    await client.query("BEGIN");

    // Source-availability precheck inside the txn (and lock the parent so a
    // concurrent tz-change archive cannot slip in before the job INSERT).
    const state = await client.query<{ status: string }>(
      `SELECT status FROM periodic_report_state
        WHERE customer_id = $1 AND period = $2
          AND bucket_date = $3::date AND tz = $4
        FOR UPDATE`,
      [variant.customerId, variant.period, variant.bucketDate, variant.tz],
    );
    if (state.rowCount === 0) {
      await client.query("COMMIT");
      return { action: "state_not_found" };
    }
    if (state.rows[0].status === "archived") {
      await client.query("COMMIT");
      return { action: "source_unavailable" };
    }
    if (state.rows[0].status !== "ready" && state.rows[0].status !== "dirty") {
      // Still `pending` (settle window not elapsed). Enqueue nothing: a queued
      // job here would be picked up before the bucket is ready (the pickup
      // query only excludes `archived`), bypassing the schedule contract.
      await client.query("COMMIT");
      return { action: "source_pending" };
    }

    // Lock the existing variant row (if any) so concurrent on-demand
    // requests for the same variant serialize.
    const existing = await client.query<{
      status: string;
      generation: number;
      dry_run: boolean;
    }>(
      `SELECT status, generation, dry_run FROM periodic_report_job
        WHERE customer_id = $1 AND period = $2
          AND bucket_date = $3::date AND tz = $4
          AND lang = $5 AND model_name = $6 AND model = $7
        FOR UPDATE`,
      variantKey,
    );

    if (existing.rowCount === 0) {
      // Genuine first request → seed a generation-1 queued row. No force
      // metadata: this is explicitly NOT the Regenerate force path.
      const ins = await client.query<{ generation: number }>(
        `INSERT INTO periodic_report_job
           (customer_id, period, bucket_date, tz, lang, model_name, model,
            status, generation, dry_run, attempts, last_error,
            created_at, updated_at)
         VALUES ($1, $2, $3::date, $4, $5, $6, $7,
                 'queued', 1, FALSE, 0, NULL, $8::timestamptz, $8::timestamptz)
         RETURNING generation`,
        [...variantKey, nowIso],
      );
      await client.query("COMMIT");
      return {
        action: "seeded",
        generation: ins.rows[0].generation,
        status: "queued",
      };
    }

    const job = existing.rows[0];
    if (job.status === "failed" || job.dry_run) {
      // A previously failed variant — or a leftover dry-run row the pickup
      // filter ignores — that the user is now actively requesting: reset to
      // `queued` at the SAME generation (no bump, no force) so the existing
      // retry/backoff machinery produces the report.
      await client.query(
        // Reset next_due_at: an on-demand requeue is an immediate-process
        // request, so a leftover future cadence value must not stall it now
        // that the picker honors next_due_at for queued rows (#412 item 4).
        `UPDATE periodic_report_job
            SET status = 'queued',
                dry_run = FALSE,
                attempts = 0,
                last_error = NULL,
                processing_started_at = NULL,
                next_due_at = NULL,
                updated_at = $8::timestamptz
          WHERE customer_id = $1 AND period = $2
            AND bucket_date = $3::date AND tz = $4
            AND lang = $5 AND model_name = $6 AND model = $7`,
        [...variantKey, nowIso],
      );
      await client.query("COMMIT");
      return {
        action: "requeued",
        generation: job.generation,
        status: "queued",
      };
    }

    // queued / processing / done → coalesce: leave the row untouched. The
    // in-flight worker pass (or an already-stored result) satisfies the
    // request without a generation bump.
    await client.query("COMMIT");
    return {
      action: "coalesced",
      generation: job.generation,
      status: job.status,
    };
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

/**
 * RFC 0002 §"LIVE re-queue" — re-queue done LIVE variant jobs whose
 * per-variant `next_due_at` cadence has elapsed. Gated by
 * `state.status NOT IN ('archived', 'dirty')`: archived (old-tz) rows
 * must never re-queue (round-14 item 5), and `dirty` rows are excluded
 * because `seedRealReportJobs`' dirty branch — which runs later in the
 * same tick — already bumps every variant under a dirty state regardless
 * of cadence. Letting both paths fire would burn two automatic
 * generations for one invalidation, hit `ANALYSIS_MAX_GENERATION` a cycle
 * early, and leave a gap where the skipped generation never produced a
 * result (#297 review round 9, item 1). The gate therefore covers
 * `pending|ready`. Resets the retry budget on the bumped generation.
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
        AND s.status NOT IN ('archived', 'dirty')
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
            -- Clear the cadence gate so the bumped generation is picked up
            -- immediately; the next finalize re-stamps a fresh LIVE
            -- next_due_at (#412 item 4).
            next_due_at = NULL,
            force_requested_at = NULL,
            force_requested_by = NULL,
            updated_at = $1::timestamptz
       FROM periodic_report_state s
      WHERE j.customer_id = s.customer_id AND j.period = s.period
        AND j.bucket_date = s.bucket_date AND j.tz = s.tz
        AND j.period = 'LIVE'
        AND j.status = 'done'
        AND j.dry_run = FALSE
        AND s.status NOT IN ('archived', 'dirty')
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
