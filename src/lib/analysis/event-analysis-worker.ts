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
import { appLocaleToReportLanguage, isSupportedLocale } from "@/i18n/locale";
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
import { recordBaselineActivity } from "./state";
import {
  MAX_ATTEMPTS,
  PROCESSING_TIMEOUT_MINUTES,
  RETRY_BACKOFF_BASE_MS,
  RETRY_BACKOFF_MAX_MS,
  WORKER_ACCOUNT_ID,
} from "./story-worker";
import { deriveEventTranslation } from "./translate-event-analysis";

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const DEFAULT_LANG: SupportedLang = "ENGLISH";
const DEFAULT_MAX_ENRICHMENT_ATTEMPTS = 5;
const DEFAULT_MAX_ENRICHMENT_AGE_MINUTES = 60;

function resolveInt(raw: string | undefined, fallback: number): number {
  if (!raw) return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}

// `DEFAULT_LOCALE` is the global app UI locale (`en` / `ko`), mirrored from
// `src/i18n/routing.ts` (same `?? "ko"` fallback) and read directly here so
// the worker need not pull in next-intl's routing object.
const DEFAULT_LOCALE = process.env.DEFAULT_LOCALE ?? "ko";

// Bilingual eager set (#581): English canonical ∪ the app default-locale
// language, deduplicated. English (`DEFAULT_LANG`) is ALWAYS the natively
// generated canonical; any other entry is ALWAYS a TRANSLATION of that
// canonical (never natively generated). Collapses to English-only when the
// app language is English. The locale↔language mapper is typed (`AppLocale`),
// so a garbled `DEFAULT_LOCALE` validates to the English baseline here rather
// than folding silently inside the mapper.
export const EAGER_LANGS: SupportedLang[] = Array.from(
  new Set<SupportedLang>([
    DEFAULT_LANG,
    isSupportedLocale(DEFAULT_LOCALE)
      ? appLocaleToReportLanguage(DEFAULT_LOCALE)
      : DEFAULT_LANG,
  ]),
);

// Backoff applied when a translation job defers because its English canonical
// is not yet available. A NON-TERMINAL wait, not a failure: the defer leaves
// `attempts` untouched (never counts toward `MAX_ATTEMPTS` / `failed`) and
// only sets `next_due_at` so the picker does not hot-spin. Mirrors the report
// worker's `CANONICAL_DEFER_MS`.
const DEFAULT_CANONICAL_DEFER_MS = 30_000;
const CANONICAL_DEFER_MS = resolveInt(
  process.env.ANALYSIS_CANONICAL_DEFER_MS,
  DEFAULT_CANONICAL_DEFER_MS,
);

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
  event_time: Date;
  received_at: Date;
  generation: number;
  attempts: number;
  created_at: Date;
  next_due_at: Date | null;
}

// ---------------------------------------------------------------------------
// Seeding (ingest-hook driven)
// ---------------------------------------------------------------------------

/** One loose accepted baseline event the ingest hook offers for seeding. */
export interface BaselineSeedCandidate {
  baselineVersion: string;
  sourceAiceId: string;
  eventKey: string;
  /**
   * Source `baseline_event.event_time` / `received_at`. Stored on the job so
   * the queued-job pickup can ORDER BY them — tier-B admission then follows
   * the requested neutral chronological order (no sender-field re-ranking)
   * instead of an arbitrary key order, which would otherwise decide which
   * events fit under a low daily cap.
   */
  eventTime: Date;
  receivedAt: Date;
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

  for (const cand of input.candidates) {
    // Story members are analyzed at story scope — never auto-analyzed here.
    // (Variant-independent, so checked once per event regardless of language.)
    if (
      await storyMemberCheck(customerPool, cand.sourceAiceId, cand.eventKey)
    ) {
      continue;
    }

    // Seed one job per eager language (#581): the English canonical (a HELD
    // native job) and, when the app language differs, the user-language
    // TRANSLATION job. Both seed `selection_tier = NULL`; the worker tells
    // them apart purely by `lang` (the translation job bypasses tier
    // classification and budget, and derives from the canonical instead).
    for (const lang of EAGER_LANGS) {
      // Rebaseline idempotency (mirrors #470): when a live (non-superseded)
      // leaf already exists for this language variant, do not re-analyze. The
      // job still records the latest `baseline_version` so reproducibility
      // tracks the newest ingested row.
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
          // Do NOT rewrite `baseline_version` of a CLAIMED (in-flight) row:
          // the worker analyzes the version captured at its own pickup, so
          // updating the source version of a `processing` attempt would leave
          // the job recording a newer version than the payload the stored
          // result came from — undercutting the reproducibility the column
          // exists for.
          `UPDATE event_analysis_job
              SET baseline_version = $7, updated_at = $8::timestamptz
            WHERE customer_id = $1 AND aice_id = $2 AND event_key = $3::numeric
              AND lang = $4 AND model_name = $5 AND model = $6
              AND status <> 'processing'`,
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
      // `next_due_at` starts NULL (immediately eligible); a translation job
      // sets it forward itself when it finds no English canonical yet.
      await authClient.query(
        `INSERT INTO event_analysis_job
           (customer_id, aice_id, event_key, lang, model_name, model,
            status, selection_tier, budget_day, baseline_version,
            event_time, received_at,
            generation, dry_run, created_at, updated_at)
         VALUES ($1, $2, $3::numeric, $4, $5, $6,
                 'queued', NULL,
                 (($9::timestamptz AT TIME ZONE $7)::date), $8,
                 $10::timestamptz, $11::timestamptz,
                 1, FALSE, $9::timestamptz, $9::timestamptz)
         ON CONFLICT (customer_id, aice_id, event_key, lang, model_name, model)
         DO UPDATE SET baseline_version = EXCLUDED.baseline_version,
                       updated_at = EXCLUDED.updated_at
         -- Never rewrite the source version of a CLAIMED (in-flight) attempt;
         -- the worker analyzes the version it captured at pickup, so a
         -- concurrent rebaseline must not drift the recorded version away from
         -- the payload the stored result was produced from. event_time /
         -- received_at stay at their seeded chronological values.
         WHERE event_analysis_job.status <> 'processing'`,
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
          cand.eventTime.toISOString(),
          cand.receivedAt.toISOString(),
        ],
      );
    }
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
            event_time, received_at,
            generation, attempts, created_at, next_due_at
       FROM event_analysis_job
      WHERE status = 'queued'
        AND dry_run = FALSE
        -- Translation jobs defer on next_due_at while their English
        -- canonical is missing (#581); native jobs leave it NULL.
        AND (next_due_at IS NULL OR next_due_at <= NOW())
        AND (
          attempts = 0
          OR updated_at
             + ($2::bigint * (2 ^ LEAST(attempts - 1, $3::int))) * interval '1 millisecond'
             <= NOW()
        )
      -- Neutral chronological order so tier-B admission under a low daily cap
      -- follows the source event_time / received_at (no sender-field
      -- re-ranking), with the key as a deterministic tiebreaker.
      ORDER BY event_time, received_at, aice_id, event_key
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
  /** User-language translation derivation (#581). Defaults to the real one. */
  deriveTranslation?: typeof deriveEventTranslation;
  /** Loose-membership predicate (#492), re-checked at claim time. */
  storyMemberCheck?: typeof isStoryMember;
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

/**
 * Re-dirty the periodic report buckets overlapping a freshly-analyzed loose
 * event so the report event path picks up the async leaf. Reuses the exact
 * `recordBaselineActivity` primitive the baseline ingest hook already drives
 * (existing-row dirty + monotonic forward-patch) — no report-side logic
 * change; the report input builder already reads `auto_baseline` leaves
 * origin-agnostically. Best-effort and idempotent: repeated calls before the
 * next report tick collapse to a single regeneration (a dirty row stays
 * dirty), so this cannot churn reports.
 */
async function redirtyReportsForLeaf(
  authPool: Pool,
  job: EventJobPickup,
): Promise<void> {
  const client = await authPool.connect();
  try {
    const { rows } = await client.query<{ timezone: string }>(
      "SELECT timezone FROM customers WHERE id = $1",
      [job.customer_id],
    );
    const tz = rows[0]?.timezone;
    if (!tz) return;
    await recordBaselineActivity(client, job.customer_id, tz, [
      { eventTime: job.event_time, receivedAt: job.received_at },
    ]);
  } finally {
    client.release();
  }
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

/**
 * A non-superseded target-variant leaf already exists (a manual result, a
 * default-variant regenerate, or a prior auto run). The settled live-leaf
 * dedupe rule (#493, mirroring #470): never re-analyze when such a leaf
 * exists. Re-checked at claim time, not just at seed time.
 */
async function liveLeafExists(
  customerPool: Pool,
  job: EventJobPickup,
): Promise<boolean> {
  const { rows } = await customerPool.query<{ one: number }>(
    `SELECT 1 AS one
       FROM event_analysis_result
      WHERE aice_id = $1 AND event_key = $2::numeric
        AND lang = $3 AND model_name = $4 AND model = $5
        AND superseded_at IS NULL
      LIMIT 1`,
    [job.aice_id, job.event_key, job.lang, job.model_name, job.model],
  );
  return rows.length > 0;
}

/**
 * Cancel a stale auto job that became ineligible after seeding (a story
 * member or a live leaf appeared in the async gap before pickup). Terminal
 * `done`: the job's goal — that this loose event is covered — now holds via
 * another path (story scope / the existing leaf), so there is no further work.
 * `selection_tier` stays whatever it was (NULL for a row cancelled before
 * classification, so no tier-B slot is consumed); the reason is recorded in
 * `last_error`. The queued-job pickup never re-selects a `done` row.
 */
async function cancelStaleJob(
  authPool: Pool,
  job: EventJobPickup,
  reason: string,
): Promise<void> {
  await authPool.query(
    `UPDATE event_analysis_job
        SET status = 'done',
            last_error = $7,
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
      reason,
    ],
  );
}

/**
 * Defer a translation job because its English canonical does not yet exist.
 * Non-terminal: status returns to `queued` and `next_due_at` is pushed
 * forward so the picker skips it until then, WITHOUT touching `attempts`
 * (which feeds the failure backoff / `failed` path). `selection_tier` stays
 * NULL — a translation job never classifies.
 */
async function deferTranslationJob(
  authPool: Pool,
  job: EventJobPickup,
  reason: string,
): Promise<void> {
  await authPool.query(
    `UPDATE event_analysis_job
        SET status = 'queued',
            next_due_at = NOW() + ($7::bigint * interval '1 millisecond'),
            last_error = $8,
            processing_started_at = NULL,
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
      CANONICAL_DEFER_MS,
      reason,
    ],
  );
}

/** Terminally fail a translation job (deterministic leak/shape failure —
 * retrying cannot help). */
async function failTranslationJob(
  authPool: Pool,
  job: EventJobPickup,
  reason: string,
): Promise<void> {
  await authPool.query(
    `UPDATE event_analysis_job
        SET status = 'failed', last_error = $7, updated_at = NOW()
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
      reason,
    ],
  );
}

/**
 * Process a claimed TRANSLATION job: derive the user-language row from the
 * English canonical (#581). Defers (no `attempts` burn) while the canonical
 * is missing; finalizes on a fresh translation or an idempotent no-op; fails
 * loudly on a leak/shape failure; retries with backoff on a transient
 * aimer/storage error.
 */
async function processTranslationJob(
  job: EventJobPickup,
  opts: ProcessEventJobOptions,
  customerPool: Pool,
): Promise<void> {
  const derive = opts.deriveTranslation ?? deriveEventTranslation;
  let outcome: Awaited<ReturnType<typeof deriveEventTranslation>>;
  try {
    outcome = await derive({
      customerPool,
      aiceId: job.aice_id,
      eventKey: job.event_key,
      modelName: job.model_name,
      model: job.model,
      targetLang: job.lang as SupportedLang,
      accountId: WORKER_ACCOUNT_ID,
      graphqlAiceId: job.aice_id,
      requestedBy: null,
      auditBase: {
        actorId: WORKER_ACCOUNT_ID,
        authContext: "general",
        targetType: "event_analysis_result",
        ipAddress: undefined,
        sid: "",
        customerId: job.customer_id,
        aiceId: job.aice_id,
      },
    });
  } catch (err) {
    await requeueOrFailAnalysis(
      opts.authPool,
      job,
      err instanceof Error ? err.message : String(err),
    );
    return;
  }

  if (outcome.kind === "canonical_missing") {
    await deferTranslationJob(opts.authPool, job, "awaiting_canonical");
    emitMetric("translation_deferred", {
      customer_id: job.customer_id,
      aice_id: job.aice_id,
      event_key: job.event_key,
      lang: job.lang,
    });
    return;
  }
  if (outcome.kind === "translated" || outcome.kind === "noop") {
    await finalizeJob(opts.authPool, job);
    // Re-dirty the periodic report buckets so a non-English report variant
    // picks up the freshly translated leaf (idempotent + best-effort, same as
    // the native path).
    await redirtyReportsForLeaf(opts.authPool, job).catch((err) => {
      console.error("[event-analysis-worker] report re-dirty failed:", err);
    });
    return;
  }
  if (outcome.kind === "leak") {
    await failTranslationJob(
      opts.authPool,
      job,
      `translation_leak:${outcome.field}`,
    );
    emitMetric("translation_leak", {
      customer_id: job.customer_id,
      aice_id: job.aice_id,
      event_key: job.event_key,
      lang: job.lang,
      field: outcome.field,
    });
    return;
  }
  // Transient aimer / storage error — retryable with backoff.
  await requeueOrFailAnalysis(opts.authPool, job, outcome.message);
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

  // A non-English job is a TRANSLATION of the English canonical (#581), not a
  // native analysis. It bypasses tier classification, the budget reservation,
  // and the claim-time live-leaf / story-membership gate (a translation is a
  // pure re-expression of a canonical that already passed those gates); it
  // defers on `next_due_at` until the canonical exists, then derives.
  if (job.lang !== DEFAULT_LANG) {
    await processTranslationJob(job, opts, customerPool);
    return;
  }

  // Re-check eligibility at claim time. Seeding screened story membership and
  // the live-leaf dedupe, but the worker is asynchronous: in the gap between
  // seed and pickup a story batch may have adopted this event as a member, or
  // a manual / default-variant `event_analysis_result` may have appeared.
  // Either makes this auto job stale — #493 says story members are never
  // auto-analyzed here, and the live-leaf dedupe is settled. Re-checking now,
  // BEFORE spending the tier-B budget / the LLM call and BEFORE
  // `analyzeAndStoreEventResult` would supersede the live leaf (and thereby
  // change the manual path's visible result), cancels the stale job instead
  // of producing an `auto_baseline` leaf that violates either rule.
  const storyMemberCheck = opts.storyMemberCheck ?? isStoryMember;
  if (await storyMemberCheck(customerPool, job.aice_id, job.event_key)) {
    await cancelStaleJob(opts.authPool, job, "story_member_appeared");
    emitMetric("stale_cancelled", {
      customer_id: job.customer_id,
      aice_id: job.aice_id,
      event_key: job.event_key,
      reason: "story_member_appeared",
    });
    return;
  }
  if (await liveLeafExists(customerPool, job)) {
    await cancelStaleJob(opts.authPool, job, "live_leaf_appeared");
    emitMetric("stale_cancelled", {
      customer_id: job.customer_id,
      aice_id: job.aice_id,
      event_key: job.event_key,
      reason: "live_leaf_appeared",
    });
    return;
  }

  // Classify held rows (drive enrichment + reserve budget). A null return
  // means the row was re-queued (still held) — stop for this tick.
  if (job.selection_tier === null) {
    const decision = await classifyHeldJob(job, opts, customerPool);
    if (decision === null) return;
    if (!decision.admitted) return; // budget_skipped (terminal)
    // Classification reset the DB attempt counter (`markSelectionTier` /
    // `reserveTierB` both write `attempts = 0`) so the analysis phase starts
    // with a fresh retry budget. Mirror that on the in-memory pickup, else
    // `requeueOrFailAnalysis` would bill the enrichment re-check attempts
    // against `MAX_ATTEMPTS` and a single transient LLM/storage error after a
    // held event was admitted could be marked terminally `failed` early.
    job.attempts = 0;
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
    // Re-dirty the periodic report buckets this event falls into so a leaf
    // that lands AFTER a report was already generated forces a regeneration
    // that includes it. The baseline ingest hook dirties these buckets at
    // ingest time, but the auto-analysis leaf is produced asynchronously
    // (held → bounded enrichment → analyze) over several ticks — typically
    // after that first report already ran and went `done`. Without this the
    // newly admitted loose event would stay invisible in the report event
    // path until some unrelated activity re-dirtied the bucket. Best-effort:
    // a failure here must never fail the (already-stored) analysis.
    await redirtyReportsForLeaf(opts.authPool, job).catch((err) => {
      console.error("[event-analysis-worker] report re-dirty failed:", err);
    });
    return;
  }
  if (outcome.kind === "stale") {
    // The pre-store eligibility re-check (inside the storage transaction,
    // under the event-variant lock, immediately before supersede+insert)
    // found the job became ineligible during the LLM window — a story member
    // adopted the event or a live leaf appeared after the claim-time check.
    // The store rolled back (no supersede, no `auto_baseline` leaf), so cancel
    // terminally, same as the claim-time stale path. A tier-B row reserved
    // before the LLM call keeps its reserved slot (status `done`, still counted
    // in the reservation) — a negligible, rare under-spend that errs safe;
    // un-reserving here is not worth the extra write for this edge case.
    await cancelStaleJob(opts.authPool, job, outcome.reason);
    emitMetric("stale_cancelled", {
      customer_id: job.customer_id,
      aice_id: job.aice_id,
      event_key: job.event_key,
      reason: outcome.reason,
    });
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
