// RFC 0002 Phase 1 (#296) — story analysis worker.
//
// Picks up `story_analysis_job` rows with `status='queued', dry_run=FALSE`,
// reads the canonical `story_version`'s members from the customer DB,
// rewrites event-scope tokens to story-scope, calls aimer's
// `analyzeStory` mutation, validates the response, and writes the result
// to `story_analysis_result` followed by the auth-DB job finalize.
//
// The worker is structured as a tick function (`tickStoryJobsOnce`)
// that is wired into the existing analysis-job-worker poll loop. Each
// queued row is processed under an advisory lock per
// `(customer_id, story_id)` so concurrent workers cannot double-run a
// job for the same story.
//
// Cross-DB write ordering — there is no XA / 2PC layer, so the two
// transactions sequence as:
//   1. Customer-DB tx: INSERT `story_analysis_result` at captured
//      `generation`; UPDATE prior generation's row (if any) to set
//      `superseded_at`.
//   2. Auth-DB tx: UPDATE `story_analysis_job` WHERE captured
//      generation, set `status='done'`, `last_generated_at=NOW()`.
//
// A crash between (1) and (2) is idempotent: a pickup-time probe sees
// the existing result row at the captured PK and skips the LLM call,
// running only step (2) to finalize.

import "server-only";

import { createHash } from "node:crypto";
import { ClientError } from "graphql-request";
import type { Pool, PoolClient } from "pg";
import { appLocaleToReportLanguage, isSupportedLocale } from "@/i18n/locale";
import { auditLog } from "@/lib/audit";
import { customerLockId } from "@/lib/db/customer-db";
import { getCustomerRuntimePool } from "@/lib/db/customer-runtime-pool";
import {
  AnalyzeStoryDocument,
  type StoryMemberInput,
  type StoryMetadataInput,
} from "@/lib/graphql/__generated__/analyze-story";
import { TranslateAnalysisNarrativeDocument } from "@/lib/graphql/__generated__/translate-analysis-narrative";
import { graphqlRequest } from "@/lib/graphql/client";
import { getCurrentTimestamp } from "@/lib/instrumentation/time";
import { loadCustomerOwnedDomains } from "@/lib/redaction/load-domains";
import { loadCustomerRanges } from "@/lib/redaction/load-ranges";
import { resolveDefaultModel } from "./default-model";
import { buildFactTokenMap, type FactInput, type FactRef } from "./fact-token";
import {
  type FactorAxis,
  type FilterFactorsResult,
  filterFactors,
} from "./factor-filter";
import { MITRE_VENDOR_VERSION, validateTtpTags } from "./mitre-ttp";
import { getModelCatalog } from "./model-catalog";
import {
  applyLikelihoodFloors,
  computePriorityTier,
  type PriorityTier,
} from "./priority-tier";
import {
  buildStoryTokenMap,
  extractRedactionTokens,
  scanStoryAnalysisForLeaks,
} from "./story-token";

// ---------------------------------------------------------------------------
// Configuration (env-driven, read at module init)
// ---------------------------------------------------------------------------

const DEFAULT_RETRY_BACKOFF_BASE_MS = 30_000;
const DEFAULT_RETRY_BACKOFF_MAX_MS = 15 * 60_000;
const DEFAULT_MAX_ATTEMPTS = 5;
const DEFAULT_PROCESSING_TIMEOUT_MINUTES = 30;
const DEFAULT_WORKER_ACCOUNT_ID = "system:analysis-worker";
const DEFAULT_LANG = "ENGLISH";
const DEFAULT_MODEL_NAME = "openai";
const DEFAULT_MODEL = "gpt-4o";
// RFC 0002 §"Force regenerate" guardrail — caps automatic dirty
// re-queues. Force regeneration is intentionally allowed past this
// cap (see `regenerate/route.ts`).
const DEFAULT_MAX_GENERATION = 50;

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
export const WORKER_ACCOUNT_ID =
  process.env.ANALYSIS_WORKER_ACCOUNT_ID ?? DEFAULT_WORKER_ACCOUNT_ID;
const WORKER_LANG = process.env.ANALYSIS_DEFAULT_LANG ?? DEFAULT_LANG;
const WORKER_MODEL_NAME =
  process.env.ANALYSIS_DEFAULT_MODEL_NAME ?? DEFAULT_MODEL_NAME;
const WORKER_MODEL = process.env.ANALYSIS_DEFAULT_MODEL ?? DEFAULT_MODEL;

// The LLM server `name` / `model` used on the translate path (#580, mirroring
// the report worker's `TRANSLATION_MODEL_NAME` / `TRANSLATION_MODEL`). They
// default to the worker's generation defaults but are independently
// configurable, and are recorded as the `story_analysis_job` translation audit
// columns — the translated `story_analysis_result` row keeps the English
// canonical's `model_name`/`model` so the variant key stays self-consistent.
const TRANSLATION_MODEL_NAME =
  process.env.ANALYSIS_TRANSLATION_MODEL_NAME ?? WORKER_MODEL_NAME;
const TRANSLATION_MODEL =
  process.env.ANALYSIS_TRANSLATION_MODEL ?? WORKER_MODEL;

// Backoff applied when the user-language translate job defers because its
// English canonical is not yet available. This is a NON-TERMINAL wait, not a
// failure: the defer leaves `attempts` untouched (never counts toward
// `MAX_ATTEMPTS` / `failed`) and only sets `next_due_at` so the picker does
// not hot-spin (#580, mirroring the report worker).
const DEFAULT_CANONICAL_DEFER_MS = 30_000;
export const CANONICAL_DEFER_MS = resolveInt(
  process.env.ANALYSIS_CANONICAL_DEFER_MS,
  DEFAULT_CANONICAL_DEFER_MS,
);

// `DEFAULT_LOCALE` is the global app UI locale (`en` / `ko`), mirrored from
// `src/i18n/routing.ts` (same `?? "ko"` fallback). Read directly here so the
// worker stays free of next-intl.
const DEFAULT_LOCALE = process.env.DEFAULT_LOCALE ?? "ko";

// Eager language set seeded for every story (#580). This is INTENTIONALLY the
// SAME three-element union as the report worker's `EAGER_LANGS`: English
// baseline ∪ the app default-locale language ∪ the legacy
// `ANALYSIS_DEFAULT_LANG` knob (`WORKER_LANG`). The issue requires reusing the
// existing eager-language concept rather than defining a divergent set, and
// keeping the two sets identical is itself a correctness property: periodic
// reports cite story leaves, so a language the report worker seeds (e.g. via
// `WORKER_LANG`) but the story worker does NOT would force a report in that
// language to fall back to translating absent story leaves — re-introducing the
// cross-surface inconsistency #580 eliminates. `WORKER_LANG` defaults to
// `ENGLISH`, so it adds nothing in a default deployment; it only seeds an extra
// language when an operator explicitly set `ANALYSIS_DEFAULT_LANG`, preserving
// that legacy parity deliberately. This is a UNION, never a replacement —
// English is always present as the guaranteed canonical. Deduplicated, so it
// collapses to a single English entry when all three coincide (e.g.
// `DEFAULT_LOCALE=en` with `WORKER_LANG=ENGLISH`) and nothing is translated.
// English (`DEFAULT_LANG`) is generated natively via `analyzeStory` and is the
// canonical; every other entry is ALWAYS derived by translating that canonical
// (never generated natively, which would diverge the LLM scores).
export const EAGER_LANGS = Array.from(
  new Set<string>([
    DEFAULT_LANG,
    // The canonical locale↔language mapper is typed (`AppLocale`), so a garbled
    // `DEFAULT_LOCALE` env value is validated to the English baseline here
    // rather than folded silently inside the mapper.
    isSupportedLocale(DEFAULT_LOCALE)
      ? appLocaleToReportLanguage(DEFAULT_LOCALE)
      : DEFAULT_LANG,
    WORKER_LANG,
  ]),
);

// `attempts = 0 OR updated_at + BASE * 2^LEAST(attempts-1, log2(MAX/BASE)) <= now()`
// Pre-computed cap exponent so the SQL doesn't need ln() math.
const BACKOFF_MAX_EXPONENT = Math.max(
  0,
  Math.floor(Math.log2(RETRY_BACKOFF_MAX_MS / RETRY_BACKOFF_BASE_MS)),
);

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface JobPickup {
  customer_id: string;
  story_id: string;
  lang: string;
  model_name: string;
  model: string;
  generation: number;
  attempts: number;
  force_requested_at: Date | null;
  force_requested_by: string | null;
}

interface StoryMemberRow {
  story_id: string;
  story_version: string;
  member_event_key: string;
  source_aice_id: string;
  role: string;
  event: unknown;
  redaction_policy_version: string;
  /**
   * Per-member event timestamp, resolved via a deduped LEFT JOIN to
   * `baseline_event` (RFC 0002 #344). NULL when no baseline_event row
   * matches the member's `(source_aice_id, event_key)`. A NULL is treated
   * as a retryable precondition miss (`member_event_time_unresolved`,
   * #352) rather than a silent drop: the job is re-queued with backoff so
   * a lagging baseline self-heals, becoming a terminal failure only after
   * `MAX_ATTEMPTS`.
   */
  event_time: Date | null;
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

/**
 * Pick at most `limit` queued story analysis jobs eligible per the
 * backoff predicate. `FOR UPDATE SKIP LOCKED` keeps multiple worker
 * replicas from racing on the same row. The tick caller is expected to
 * have already opened a transaction on the auth-DB client.
 */
async function pickQueuedStoryJobs(
  client: PoolClient,
  limit: number,
): Promise<JobPickup[]> {
  // The backoff predicate uses `BASE * 2 ^ LEAST(attempts - 1, MAX_EXP)`
  // milliseconds added to `updated_at`. `attempts = 0` short-circuits
  // the math so fresh/force-queued rows are immediately eligible.
  const { rows } = await client.query<JobPickup>(
    `SELECT customer_id::text AS customer_id,
            story_id::text    AS story_id,
            lang, model_name, model,
            generation, attempts,
            force_requested_at, force_requested_by::text AS force_requested_by
       FROM story_analysis_job
      WHERE status = 'queued'
        AND dry_run = FALSE
        -- Honor a per-variant next_due_at for queued rows (#580): the
        -- non-terminal canonical-defer path (user-language translate job
        -- waiting on its English canonical) sets a future next_due_at WITHOUT
        -- touching attempts, so without this gate the row would be re-picked
        -- on the very next tick (hot spin). Immediate-process requeues (dirty
        -- bump, force-regenerate, stuck recovery, enrichment wait) reset
        -- next_due_at = NULL so they are not stalled by a leftover value.
        AND (next_due_at IS NULL OR next_due_at <= NOW())
        AND (
          attempts = 0
          OR updated_at
             + ($2::bigint * (2 ^ LEAST(attempts - 1, $3::int))) * interval '1 millisecond'
             <= NOW()
        )
      ORDER BY customer_id, story_id
      LIMIT $1
      FOR UPDATE SKIP LOCKED`,
    [limit, RETRY_BACKOFF_BASE_MS, BACKOFF_MAX_EXPONENT],
  );
  return rows;
}

// ---------------------------------------------------------------------------
// Per-job processing
// ---------------------------------------------------------------------------

interface ProcessOptions {
  authPool: Pool;
  /** Override the LLM dispatch — used by tests. */
  callAnalyzeStory?: typeof callAnalyzeStory;
  /** Override the translate-path LLM dispatch (#580) — used by tests. */
  callTranslateAnalysisNarrative?: typeof callTranslateAnalysisNarrative;
  /** Override the customer-DB pool resolver — used by tests. */
  resolveCustomerPool?: (customerId: string) => Pool;
  /** Override the customer redaction-range loader — used by tests. */
  loadRanges?: typeof loadCustomerRanges;
  /** Override the customer owned-domain loader — used by tests. */
  loadOwnedDomains?: typeof loadCustomerOwnedDomains;
  /**
   * Override the IOC-enrichment readiness precondition (RFC 0003 P1a
   * #361) — used by tests. Returns whether enrichment has completed for
   * the canonical `(story_id, story_version)` and the `known_ioc_hit`
   * value read in the SAME snapshot as the completion marker, so the
   * floor is computed from a value that cannot be staler than the marker
   * the precondition gated on.
   */
  checkEnrichmentReady?: (
    customerPool: Pool,
    storyId: string,
    storyVersion: string,
  ) => Promise<EnrichmentReadiness>;
  /**
   * Override the enrichment-fact loader (RFC 0003 C1 #440) — used by
   * tests. Returns the redacted fact bodies for the canonical
   * `(story_id, story_version)`, ordered by `fact_id`.
   */
  loadEnrichmentFacts?: (
    customerPool: Pool,
    storyId: string,
    storyVersion: string,
  ) => Promise<FactInput[]>;
}

/**
 * Result of the RFC 0003 P1a (#361) enrichment-readiness precondition.
 * `knownIocHit` is the `story.known_ioc_hit` value read together with the
 * completion marker (same query, same snapshot), so the analysis worker
 * floors on the post-enrichment value rather than a `known_ioc_hit`
 * loaded by `loadCanonicalMembers` before the precondition ran.
 */
interface EnrichmentReadiness {
  ready: boolean;
  knownIocHit: boolean;
  /**
   * The `story_enrichment_state.status` (`complete` / `failed`) or `null`
   * when no marker exists yet. Lets the worker distinguish a still-pending
   * enrichment from a hard, operator-visible failure when it requeues.
   */
  status?: string | null;
  /** `last_error` recorded by a hard enrichment failure, surfaced in logs. */
  lastError?: string | null;
}

export async function processStoryJob(
  job: JobPickup,
  opts: ProcessOptions,
): Promise<void> {
  const callLlm = opts.callAnalyzeStory ?? callAnalyzeStory;
  const customerPool = (opts.resolveCustomerPool ?? getCustomerRuntimePool)(
    job.customer_id,
  );

  // Claim the row for this worker. The pickup transaction commits with
  // the row still `status='queued'` (FOR UPDATE SKIP LOCKED only holds
  // for the lifetime of that transaction), so we have to guard against
  // another worker that picked the same row in a parallel pickup tick:
  //   - `status = 'queued'` filters rows that another worker already
  //     transitioned to `processing`/`done`/`failed`.
  //   - `attempts = <captured>` filters rows that another worker
  //     already requeued via `requeueWithBackoff` (incrementing
  //     attempts) — running again with stale `job.attempts` would
  //     bypass the exponential backoff predicate.
  // A zero `rowCount` here means we lost the race; bail without calling
  // the LLM. The advisory lock further prevents simultaneous execution
  // for the same `(customer_id, story_id)`, but it does not by itself
  // reserve the picked row, hence the predicates below.
  const claim = await opts.authPool.query<{ processing_started_at: string }>(
    `UPDATE story_analysis_job
        SET status = 'processing',
            processing_started_at = NOW(),
            updated_at = NOW()
      WHERE customer_id = $1 AND story_id = $2::bigint
        AND lang = $3 AND model_name = $4 AND model = $5
        AND generation = $6
        AND status = 'queued'
        AND attempts = $7
        -- Re-check next_due_at at claim time, mirroring the picker filter.
        -- Pickup and claim are split, so a concurrent tick can hold a stale
        -- JobPickup for this row from before another worker deferred it. The
        -- non-terminal canonical-defer leaves status='queued' and attempts
        -- unchanged while setting a future next_due_at, so without this gate
        -- the stale worker would still satisfy status/generation/attempts and
        -- claim the just-deferred row — bypassing the defer backoff (#580).
        AND (next_due_at IS NULL OR next_due_at <= NOW())
      RETURNING processing_started_at::text AS processing_started_at`,
    [
      job.customer_id,
      job.story_id,
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
        event: "analysis.story_pickup_race_lost",
        customer_id: job.customer_id,
        story_id: job.story_id,
        generation: job.generation,
        attempts: job.attempts,
      }),
    );
    return;
  }

  // Claim marker — the exact `processing_started_at` this claim stamped,
  // carried as text into the translate path's audit-record / finalize / defer
  // so a watchdog requeue (`recoverStuckStoryJobs`) that cleared the column and
  // a re-claim that stamped a fresh value neutralize a timed-out first attempt
  // returning late (#580, mirroring the report worker's claim marker). The
  // native path keeps its simpler generation+status guard; only the translate
  // path consults this marker.
  const claimMarker = claim.rows[0]?.processing_started_at ?? null;

  // Result-row probe — if the result row at the captured PK already
  // exists, step 1 was completed by a previous attempt that crashed
  // before step 2. Skip the LLM call entirely and finalize.
  const existingResult = await customerPool.query<{
    priority_tier: string;
    severity_score: number;
    likelihood_score: number;
  }>(
    `SELECT priority_tier, severity_score, likelihood_score
       FROM story_analysis_result
      WHERE customer_id = $1 AND story_id = $2::bigint
        AND lang = $3 AND model_name = $4 AND model = $5
        AND generation = $6`,
    [
      job.customer_id,
      job.story_id,
      job.lang,
      job.model_name,
      job.model,
      job.generation,
    ],
  );
  if (existingResult.rows.length > 0) {
    // Crash-recovery finalize. For a translated user-language row the
    // translation audit columns were already persisted (by
    // `recordStoryTranslationAudit`) BEFORE this result insert; the native
    // `finalizeJob` never touches those columns, so they are preserved here.
    // For the native English row they are already NULL. Either way the mirror
    // is fed only by the English canonical (gate in `finalizeJob`).
    await finalizeJob(opts.authPool, job, {
      priorityTier: existingResult.rows[0].priority_tier as PriorityTier,
      severityScore: existingResult.rows[0].severity_score,
      likelihoodScore: existingResult.rows[0].likelihood_score,
      promptVersion: null,
      modelActualVersion: null,
    });
    return;
  }

  // --- Native-vs-translate routing (#580) ----------------------------------
  // English (`DEFAULT_LANG`) is the canonical: generated natively via
  // `analyzeStory`, carrying the authoritative scores/factors/tier/TTP. Every
  // other (user-language) row is ALWAYS produced by translating that canonical
  // — never generated natively, which would let the LLM diverge the scores and
  // reorder the priority-first story list / propagate divergent scores into any
  // periodic report that cites the story leaf.
  if (job.lang !== DEFAULT_LANG) {
    await runStoryTranslation({ job, opts, customerPool, claimMarker });
    return;
  }

  // Load canonical story version + members.
  const canonical = await loadCanonicalMembers(customerPool, job.story_id);
  if (!canonical) {
    await failJob(opts.authPool, job, "source_unavailable");
    return;
  }

  const auditBase: AuditEmissionBase = {
    actorId: WORKER_ACCOUNT_ID,
    authContext: "general",
    targetType: "story_analysis_result",
    customerId: job.customer_id,
    aiceId: canonical.sourceAiceId,
  };

  // Redaction-policy-version precondition.
  const policyCheck = checkRedactionPolicyVersion(canonical.members);
  if (policyCheck.kind === "missing") {
    await failJob(opts.authPool, job, "missing_redaction_policy_version");
    return;
  }
  if (policyCheck.kind === "mismatched") {
    await failJob(opts.authPool, job, "mismatched_redaction_policy_version");
    return;
  }

  // Per-member event-time precondition (RFC 0002 #344). `event_time` is
  // resolved via the deduped `baseline_event` LEFT JOIN in
  // `loadCanonicalMembers`; a member whose timestamp does not resolve
  // would otherwise be sent to aimer with no `eventTime`. aimer requires
  // a non-null `eventTime` per member, and silently dropping the member
  // (an INNER JOIN) would feed aimer a truncated story.
  //
  // Unlike the redaction-policy checks above, a NULL `event_time` is not
  // necessarily a terminal data-integrity defect: `baseline_event` and
  // `story_member` are ingested through separate phase2 endpoints with no
  // ordering guarantee, so a story job can run (after the readiness idle
  // window) before its referenced baseline rows have landed (#352). Route
  // this through `requeueWithBackoff` so a lagging baseline self-heals:
  // each transient miss consumes one attempt and is re-picked by the
  // backoff predicate in `pickQueuedStoryJobs`. Only after `MAX_ATTEMPTS`
  // does it become terminal `failed` — which then genuinely matches the
  // option-(c) data-integrity case (#344). This is still a pre-LLM
  // precondition (before the token map / aimer call).
  if (canonical.members.some((m) => m.event_time == null)) {
    const nextAttempts = job.attempts + 1;
    await requeueWithBackoff(
      opts.authPool,
      job,
      "member_event_time_unresolved",
    );
    // Branch the log on the cap to match what `requeueWithBackoff` wrote:
    // it re-queues only while `nextAttempts < MAX_ATTEMPTS`, and writes a
    // terminal `failed` at the cap.
    console.warn(
      JSON.stringify({
        level: "warn",
        event:
          nextAttempts < MAX_ATTEMPTS
            ? "analysis.member_event_time_unresolved_requeued"
            : "analysis.member_event_time_unresolved_exhausted",
        customer_id: job.customer_id,
        story_id: job.story_id,
        generation: job.generation,
        attempts: nextAttempts,
      }),
    );
    return;
  }

  // RFC 0003 P1a (#361) — enrichment ordering precondition. The async
  // enrichment worker derives `known_ioc_hit` for this canonical version
  // (UPDATEing `story.known_ioc_hit`) and records a
  // `story_enrichment_state` completion marker. Reading the floor before
  // that marker exists risks flooring on a stale `known_ioc_hit`. This
  // precondition sits on the exact path that reads the floor: requeue our
  // own job — WITHOUT consuming a retry attempt, since enrichment latency
  // is not a job failure — until enrichment is complete for the canonical
  // version, so analysis always reads the updated value. The best-effort
  // post-commit hook may still TRIGGER enrichment, but it is never the
  // thing that guarantees ordering.
  const enrichment = await (
    opts.checkEnrichmentReady ?? defaultCheckEnrichmentReady
  )(customerPool, job.story_id, canonical.storyVersion);
  if (!enrichment.ready) {
    // A hard enrichment failure persists a `failed` marker with
    // `last_error` (RFC 0003 P1a #361, `persistEnrichmentFailure`). Unlike
    // the latency wait below, a persisted `failed` is a job failure, not an
    // ordering wait: requeuing it with `requeueForEnrichment` would preserve
    // `attempts` forever, so a persistent failure spins indefinitely (#531).
    // Route it through `requeueWithBackoff` instead — each requeue consumes
    // one attempt and at `MAX_ATTEMPTS` the analysis job becomes terminal
    // `failed`. We cannot floor without a completed marker (a stale-floor
    // hazard, the precise thing #361 guards), so failing loudly at the cap
    // is preferable to an infinite silent requeue. Transient failures still
    // self-heal within the cap.
    if (enrichment.status === "failed") {
      const nextAttempts = job.attempts + 1;
      await requeueWithBackoff(opts.authPool, job, "enrichment_failed");
      // Branch the log on the cap to match what `requeueWithBackoff` wrote:
      // it re-queues only while `nextAttempts < MAX_ATTEMPTS`, and writes a
      // terminal `failed` at the cap.
      console.error(
        JSON.stringify({
          level: "error",
          event:
            nextAttempts < MAX_ATTEMPTS
              ? "analysis.story_enrichment_failed_requeued"
              : "analysis.story_enrichment_failed_exhausted",
          customer_id: job.customer_id,
          story_id: job.story_id,
          story_version: canonical.storyVersion,
          generation: job.generation,
          attempts: nextAttempts,
          last_error: enrichment.lastError,
        }),
      );
      return;
    }
    // Not yet complete (`status` null/pending). Enrichment latency is an
    // ordering wait, not a job failure, so requeue WITHOUT consuming a retry
    // attempt to preserve a never-stale floor.
    await requeueForEnrichment(opts.authPool, job);
    console.warn(
      JSON.stringify({
        level: "warn",
        event: "analysis.story_enrichment_incomplete_requeued",
        customer_id: job.customer_id,
        story_id: job.story_id,
        story_version: canonical.storyVersion,
        generation: job.generation,
      }),
    );
    return;
  }

  // Re-bind the floor input to the `known_ioc_hit` read alongside the
  // readiness marker. `loadCanonicalMembers` (above) read `known_ioc_hit`
  // BEFORE this gate, so a concurrent enrichment that committed
  // `known_ioc_hit = true` between that load and now would otherwise let
  // analysis floor on the stale in-memory `false`: the marker check would
  // see `ready` while the already-loaded value was still `false`. The
  // readiness query reads `story.known_ioc_hit` in the same statement (and
  // therefore the same snapshot) as the completion marker, and
  // `persistEnrichment` commits the floor UPDATE and the marker in one
  // transaction, so once `ready` is observed this value is the committed,
  // post-enrichment one. The boolean is monotonic, so this can only raise
  // a hit, never lower it.
  canonical.knownIocHit = enrichment.knownIocHit;

  // Token rewrite + LLM call.
  const { rewrittenMembers, refs, allowedTokens } = buildStoryTokenMap(
    canonical.members.map((m) => ({
      aiceId: m.source_aice_id,
      eventKey: m.member_event_key,
      event: m.event,
    })),
  );

  // RFC 0003 C1 (#440) — load this story's redacted enrichment facts
  // (guaranteed present + complete by the enrichment precondition above)
  // and rename each customer-asset fact's self-scoped token to fact-scope
  // `F{k}`. External fact indicators stay raw. `enrichmentFacts` is the
  // redacted, F-scoped text sent to aimer; `inputFactRefs` (the ordered
  // `k -> fact_id` mapping) is persisted so the renderer can demap. Fact
  // tokens join the hallucination allow-list so a legitimate `F{k}` the
  // LLM echoes from a fact is not mistaken for a leak.
  const factRows = await (
    opts.loadEnrichmentFacts ?? defaultLoadEnrichmentFacts
  )(customerPool, job.story_id, canonical.storyVersion);
  const {
    rewrittenFacts: enrichmentFacts,
    refs: inputFactRefs,
    allowedTokens: factTokens,
  } = buildFactTokenMap(factRows);
  for (const t of factTokens) allowedTokens.add(t);

  const force = job.force_requested_at !== null;

  // Build the structured aimer payload. `rewrittenMembers` preserves the
  // canonical order of `canonical.members`, so member metadata (role,
  // event_time) is read positionally. The member `ordinal` is the
  // 1-based `rm.index` baked into the `E{i}` tokens by
  // `buildStoryTokenMap`, so the declared ordinal agrees with the tokens
  // actually embedded in `event` (RFC 0002 #344). aimer's
  // `validate_story_inputs` requires contiguous `1..N` ordinals,
  // `memberCount === members.length`, an exact `roleDistribution` match,
  // and `firstSeenAt <= lastSeenAt` — all satisfied below.
  const storyMembers: StoryMemberInput[] = rewrittenMembers.map((rm, i) => ({
    ordinal: rm.index,
    role: canonical.members[i].role,
    eventTime: toIsoTimestamp(canonical.members[i].event_time as Date),
    event: JSON.stringify(rm.event),
  }));
  const roleCounts = new Map<string, number>();
  for (const m of canonical.members) {
    roleCounts.set(m.role, (roleCounts.get(m.role) ?? 0) + 1);
  }
  const storyMetadata: StoryMetadataInput = {
    storyId: job.story_id,
    firstSeenAt: toIsoTimestamp(canonical.timeWindowStart),
    lastSeenAt: toIsoTimestamp(canonical.timeWindowEnd),
    memberCount: storyMembers.length,
    roleDistribution: Array.from(roleCounts, ([role, count]) => ({
      role,
      count,
    })),
  };

  // `input_hash` is the sha256 of the canonical LLM input — "members +
  // metadata + refs" per RFC 0002 (the `input_hash` column comment and
  // §"input_event_refs"). It must hash the structured payload aimer
  // actually receives, not just `rewrittenMembers`: `members[].role`,
  // `members[].eventTime`, and the whole `storyMetadata` object are part
  // of the canonical input but absent from `rewrittenMembers`, so hashing
  // the latter alone would collide two runs that differ only in
  // role/event-time/metadata and defeat drift attribution. RFC 0003 C1
  // (#440) folds in BOTH the redacted `enrichmentFacts` text AND the
  // `inputFactRefs` mapping: two runs with identical members/refs but
  // different fact wording/classification produce different LLM input and
  // must hash differently — parallel to how member `event` strings (not
  // just `refs`) are already covered via `storyMembers`. Each component is
  // built in deterministic order (members + facts follow their canonical
  // order; metadata/refs are positional), so the bundle is stable across
  // runs with identical input.
  const inputHash = createHash("sha256")
    .update(
      JSON.stringify({
        members: storyMembers,
        storyMetadata,
        refs,
        enrichmentFacts,
        inputFactRefs,
      }),
    )
    .digest("hex");

  void auditLog({
    ...auditBase,
    action: "ai_analysis.request_issued",
    targetId: `${job.customer_id}/${job.story_id}`,
    details: {
      customer_id: job.customer_id,
      story_id: job.story_id,
      lang: job.lang,
      model_name: job.model_name,
      model: job.model,
      generation: job.generation,
      force,
    },
  });

  let aimerResponse: AnalyzeStoryAimerResponse;
  try {
    aimerResponse = await callLlm({
      customerId: job.customer_id,
      storyId: job.story_id,
      members: storyMembers,
      storyMetadata,
      enrichmentFacts,
      modelName: job.model_name,
      model: job.model,
      lang: job.lang,
      aiceId: canonical.sourceAiceId,
    });
  } catch (err) {
    const classification = classifyAimerError(err);
    void auditLog({
      ...auditBase,
      action: "ai_analysis.aimer_call_failed",
      targetId: `${job.customer_id}/${job.story_id}`,
      details: {
        generation: job.generation,
        code: classification.code,
        retryable: classification.retryable,
        error: err instanceof Error ? err.message : String(err),
      },
    });
    if (!classification.retryable) {
      // Non-retryable aimer failures still consumed an LLM attempt —
      // record it in `attempts` so the request/audit trail and the row
      // agree on how many calls were made.
      await failJob(opts.authPool, job, classification.code, {
        attempts: job.attempts + 1,
      });
      return;
    }
    await requeueWithBackoff(opts.authPool, job, classification.code);
    return;
  }

  // Hallucination scan. IP-leak detection mirrors the redaction
  // engine's policy: only IPs the engine would have redacted (private,
  // or in the customer's configured range set — empty range set means
  // public IPs pass through) are treated as leaks. Public
  // out-of-range IPs that legitimately reached the prompt unredacted
  // are NOT flagged when the LLM echoes them back.
  const ranges = await (opts.loadRanges ?? loadCustomerRanges)(
    opts.authPool,
    job.customer_id,
  );
  // Owned domains gate the same scan for customer-owned hostnames the
  // LLM echoed verbatim (RFC 0001 Amendment A.2). Loaded alongside
  // ranges so a leaked owned domain fails the job before the result row
  // is written, parallel to the runAnalyzeFlow hallucination scan.
  const ownedDomains = await (
    opts.loadOwnedDomains ?? loadCustomerOwnedDomains
  )(opts.authPool, job.customer_id);

  // Shape-filter the score factors BEFORE the leak scan so the scan can
  // cover the persisted factor strings, not just the narrative body.
  // With `enrichmentFacts` (`F{k}`) now in the prompt (#440), aimer can
  // echo a fact token — or worse, decode it to a customer-asset IP/domain
  // — inside a short score factor. The shape filter alone (length /
  // sentence-start) waves such a factor through, and the report-input
  // builder can re-mask a live `F{k}` token but CANNOT recover a decoded
  // plaintext value, so it would reach the report LLM input and violate
  // the #440 report-scope guarantee. Scanning `kept` (exactly what
  // `writeResultRow` persists and the report builder later reads) closes
  // that gap. `validateTtpTags` is deferred until after the gate — TTP
  // ids come from a fixed enum and cannot carry free-text plaintext.
  const severityFilter = filterFactors(
    aimerResponse.severityFactors,
    "severity",
  );
  const likelihoodFilter = filterFactors(
    aimerResponse.likelihoodFactors,
    "likelihood",
  );
  const leakScan = scanStoryAnalysisForLeaks(
    [
      aimerResponse.analysis,
      ...severityFilter.kept,
      ...likelihoodFilter.kept,
    ].join("\n"),
    allowedTokens,
    ranges,
    ownedDomains,
  );
  if (leakScan.hasLeak) {
    void auditLog({
      ...auditBase,
      action: "ai_analysis.hallucination_detected",
      targetId: `${job.customer_id}/${job.story_id}`,
      details: {
        generation: job.generation,
        leaks: leakScan.leaks.slice(0, 20),
      },
    });
    // Hallucination is detected AFTER a completed LLM call, so this
    // attempt consumed a real aimer call — bump `attempts` accordingly
    // even though the path is fatal (per #296 attempt-accounting).
    await failJob(opts.authPool, job, "hallucination_detected", {
      attempts: job.attempts + 1,
    });
    return;
  }

  // Pre-storage validation.
  const ttpResult = validateTtpTags(aimerResponse.ttpTags);

  emitFactorAuditRows({
    auditBase,
    storyId: job.story_id,
    axis: "severity",
    rawInput: aimerResponse.severityFactors,
    filter: severityFilter,
  });
  emitFactorAuditRows({
    auditBase,
    storyId: job.story_id,
    axis: "likelihood",
    rawInput: aimerResponse.likelihoodFactors,
    filter: likelihoodFilter,
  });
  if (ttpResult.dropped.length > 0) {
    emitTtpDropAuditRows({
      auditBase,
      storyId: job.story_id,
      dropped: ttpResult.dropped,
    });
  }

  // Apply likelihood floors at the matrix-lookup site (NOT on disk).
  const flooredLikelihood = applyLikelihoodFloors(
    aimerResponse.likelihoodScore,
    {
      knownIocHit: canonical.knownIocHit,
      memberCount: canonical.members.length,
    },
  );
  const priorityTier = computePriorityTier(
    aimerResponse.severityScore,
    flooredLikelihood,
  );

  // Step 1 — customer-DB INSERT + supersede prior.
  try {
    await writeResultRow(customerPool, {
      job,
      aimerResponse,
      severityFilter,
      likelihoodFilter,
      ttpValid: ttpResult.valid,
      priorityTier,
      inputEventRefs: refs,
      inputFactRefs,
      inputHash,
      redactionPolicyVersion: policyCheck.version,
      requestedBy: job.force_requested_by,
    });
  } catch (err) {
    // Step 1 failed — leave job processing; watchdog re-queues.
    void auditLog({
      ...auditBase,
      action: "ai_analysis.aimer_call_failed",
      targetId: `${job.customer_id}/${job.story_id}`,
      details: {
        generation: job.generation,
        stage: "result_insert",
        error: err instanceof Error ? err.message : String(err),
      },
    });
    throw err;
  }

  // Step 2 — auth-DB finalize. The raw on-disk scores (not the floored
  // likelihood used only for tier lookup) are denormalized onto
  // `story_analysis_state` for the default variant inside `finalizeJob`.
  await finalizeJob(opts.authPool, job, {
    priorityTier,
    severityScore: aimerResponse.severityScore,
    likelihoodScore: aimerResponse.likelihoodScore,
    promptVersion: aimerResponse.promptVersion,
    modelActualVersion: aimerResponse.modelActualVersion,
  });

  void auditLog({
    ...auditBase,
    action: "ai_analysis.result_stored",
    targetId: `${job.customer_id}/${job.story_id}`,
    details: {
      customer_id: job.customer_id,
      story_id: job.story_id,
      generation: job.generation,
      prompt_version: aimerResponse.promptVersion,
      model_actual_version: aimerResponse.modelActualVersion,
      priority_tier: priorityTier,
    },
  });
}

// ---------------------------------------------------------------------------
// Canonical member loader
// ---------------------------------------------------------------------------

interface CanonicalMembers {
  storyVersion: string;
  sourceAiceId: string;
  knownIocHit: boolean;
  timeWindowStart: Date;
  timeWindowEnd: Date;
  members: StoryMemberRow[];
}

async function loadCanonicalMembers(
  customerPool: Pool,
  storyId: string,
): Promise<CanonicalMembers | null> {
  // Canonical version = latest by `story.received_at` per #294 decision 1.
  // The `story_version DESC` tie-break matches the shared convention
  // documented at reconcile.ts:569: received_at defaults to NOW() and is
  // transaction-stable, so versions ingested in one tx tie on received_at
  // and must resolve deterministically to the highest story_version.
  const storyRow = await customerPool.query<{
    story_version: string;
    source_aice_id: string;
    known_ioc_hit: boolean;
    time_window_start: Date;
    time_window_end: Date;
  }>(
    `SELECT story_version, source_aice_id, known_ioc_hit,
            time_window_start, time_window_end
       FROM story
      WHERE story_id = $1::bigint
      ORDER BY received_at DESC, story_version DESC
      LIMIT 1`,
    [storyId],
  );
  if (storyRow.rows.length === 0) return null;
  const {
    story_version,
    source_aice_id,
    known_ioc_hit,
    time_window_start,
    time_window_end,
  } = storyRow.rows[0];

  // Member rows for the canonical version, with `role` (for the
  // structured payload + roleDistribution) and a per-member `event_time`
  // resolved from `baseline_event` (RFC 0002 #344, option (a)).
  //
  // `baseline_event`'s PK is `(baseline_version, event_key)`, so a
  // rebaselined event survives as multiple rows
  // (`migrations/customer/0000_init.sql`). We therefore
  // dedupe to one row per `(source_aice_id, event_key)` — latest by
  // `received_at` — in the `latest_baseline` CTE BEFORE joining. Deduping
  // over the joined result instead would risk collapsing members shared
  // across co-occurring stories and dropping them.
  //
  // The dedupe set is scoped twice over: to this story's `source_aice_id`
  // AND to the canonical-version member `event_key`s (materialized in the
  // `member_rows` CTE). Without the `event_key` scope, every analysis would
  // `DISTINCT ON`-sort the entire historical baseline for the source just
  // to resolve a handful of member timestamps; the `(source_aice_id,
  // event_key)` index can only bound the scan once both columns are
  // constrained.
  //
  // A LEFT JOIN keeps every `story_member` row even when no
  // `baseline_event` matches; the caller re-queues the job with backoff
  // (`member_event_time_unresolved`, #352) on any NULL `event_time` —
  // letting a lagging baseline self-heal before turning terminal at
  // `MAX_ATTEMPTS` — rather than silently shrinking the member set (an
  // INNER JOIN would do exactly that, feeding aimer a
  // self-consistent-but-truncated story).
  const memberRows = await customerPool.query<StoryMemberRow>(
    `WITH member_rows AS (
       SELECT sm.story_id,
              sm.story_version,
              sm.member_event_key,
              sm.role,
              sm.event,
              sm.redaction_policy_version
         FROM story_member sm
        WHERE sm.story_id = $1::bigint
          AND sm.story_version = $3
     ),
     latest_baseline AS (
       SELECT DISTINCT ON (source_aice_id, event_key)
              source_aice_id, event_key, event_time
         FROM baseline_event
        WHERE source_aice_id = $2
          AND event_key IN (SELECT member_event_key FROM member_rows)
        ORDER BY source_aice_id, event_key, received_at DESC
     )
     SELECT mr.story_id::text          AS story_id,
            mr.story_version,
            mr.member_event_key::text  AS member_event_key,
            $2::text                   AS source_aice_id,
            mr.role,
            mr.event,
            mr.redaction_policy_version,
            lb.event_time              AS event_time
       FROM member_rows mr
       LEFT JOIN latest_baseline lb
         ON lb.event_key = mr.member_event_key
      ORDER BY mr.member_event_key`,
    [storyId, source_aice_id, story_version],
  );

  return {
    storyVersion: story_version,
    sourceAiceId: source_aice_id,
    knownIocHit: known_ioc_hit,
    timeWindowStart: time_window_start,
    timeWindowEnd: time_window_end,
    members: memberRows.rows,
  };
}

// ---------------------------------------------------------------------------
// Redaction-policy-version precondition
// ---------------------------------------------------------------------------

type PolicyCheck =
  | { kind: "ok"; version: string }
  | { kind: "missing" }
  | { kind: "mismatched" };

export function checkRedactionPolicyVersion(
  members: ReadonlyArray<StoryMemberRow>,
): PolicyCheck {
  if (members.length === 0) return { kind: "missing" };
  let version: string | null = null;
  for (const m of members) {
    // Defensive: reject empty string AND any nullish shape (null /
    // undefined) — the column is NOT NULL today, but pg's typed row
    // reader can surface null if a future migration relaxes that
    // constraint or a JOIN drops the row. Either way, "no policy
    // version" must fail the precondition, not silently coerce.
    if (typeof m.redaction_policy_version !== "string") {
      return { kind: "missing" };
    }
    if (m.redaction_policy_version === "") return { kind: "missing" };
    if (version === null) version = m.redaction_policy_version;
    else if (m.redaction_policy_version !== version) {
      return { kind: "mismatched" };
    }
  }
  return { kind: "ok", version: version as string };
}

// ---------------------------------------------------------------------------
// aimer call wrapper
// ---------------------------------------------------------------------------

export interface AnalyzeStoryAimerResponse {
  severityScore: number;
  likelihoodScore: number;
  severityFactors: string[];
  likelihoodFactors: string[];
  ttpTags: string[];
  analysis: string;
  promptVersion: string;
  modelActualVersion: string;
}

/**
 * Normalise a TIMESTAMPTZ column value (pg returns `Date`) to the ISO
 * 8601 string aimer's `DateTime` scalar expects. Strings are passed
 * through unchanged (defensive — some pg type configs / test fixtures
 * may hand back a pre-formatted string).
 */
function toIsoTimestamp(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : value;
}

async function callAnalyzeStory(args: {
  customerId: string;
  storyId: string;
  members: StoryMemberInput[];
  storyMetadata: StoryMetadataInput;
  /** RFC 0003 C1 (#440) — redacted, F-scoped enrichment fact texts. */
  enrichmentFacts: string[];
  modelName: string;
  model: string;
  lang: string;
  aiceId: string;
}): Promise<AnalyzeStoryAimerResponse> {
  // Lang sent to aimer must be one of the SDL enum values. The job
  // row's `lang` column is already constrained at the regenerate-API /
  // worker-default boundary, so a raw `${args.lang}` cast is safe.
  const result = await graphqlRequest(
    AnalyzeStoryDocument,
    {
      customerId: args.customerId,
      storyId: args.storyId,
      members: args.members,
      storyMetadata: args.storyMetadata,
      // aimer#480 wraps each fact text in `EnrichmentFactInput { text }`.
      // We keep the internal `enrichmentFacts: string[]` shape and wrap
      // only at the GraphQL boundary.
      enrichmentFacts: args.enrichmentFacts.map((text) => ({ text })),
      name: args.modelName,
      model: args.model,
      lang: args.lang as "KOREAN" | "ENGLISH",
    },
    { accountId: WORKER_ACCOUNT_ID, aiceId: args.aiceId },
  );
  return result.analyzeStory;
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
    // GraphQL error with no body / transport — treat as retryable.
    return { code: "aimer_transport_error", retryable: true };
  }
  // Network / mTLS errors — retryable.
  return { code: "aimer_unavailable", retryable: true };
}

// ---------------------------------------------------------------------------
// Customer-DB write
// ---------------------------------------------------------------------------

async function writeResultRow(
  customerPool: Pool,
  args: {
    job: JobPickup;
    aimerResponse: AnalyzeStoryAimerResponse;
    severityFilter: FilterFactorsResult;
    likelihoodFilter: FilterFactorsResult;
    ttpValid: string[];
    priorityTier: PriorityTier;
    inputEventRefs: ReadonlyArray<{
      index: number;
      aiceId: string;
      eventKey: string;
    }>;
    inputFactRefs: ReadonlyArray<FactRef>;
    inputHash: string;
    redactionPolicyVersion: string;
    requestedBy: string | null;
  },
): Promise<void> {
  const client = await customerPool.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      `INSERT INTO story_analysis_result
         (customer_id, story_id, lang, model_name, model,
          model_actual_version, prompt_version, generation,
          severity_score, likelihood_score,
          severity_factors, likelihood_factors, ttp_tags,
          priority_tier, analysis_text,
          input_event_refs, input_fact_refs, input_hash,
          redaction_policy_version, requested_by)
       VALUES ($1, $2::bigint, $3, $4, $5,
               $6, $7, $8,
               $9, $10,
               $11::jsonb, $12::jsonb, $13::jsonb,
               $14, $15,
               $16::jsonb, $17::jsonb, $18,
               $19, $20::uuid)`,
      [
        args.job.customer_id,
        args.job.story_id,
        args.job.lang,
        args.job.model_name,
        args.job.model,
        args.aimerResponse.modelActualVersion,
        args.aimerResponse.promptVersion,
        args.job.generation,
        args.aimerResponse.severityScore,
        args.aimerResponse.likelihoodScore,
        JSON.stringify(args.severityFilter.kept),
        JSON.stringify(args.likelihoodFilter.kept),
        JSON.stringify(args.ttpValid),
        args.priorityTier,
        args.aimerResponse.analysis,
        JSON.stringify(args.inputEventRefs),
        JSON.stringify(args.inputFactRefs),
        args.inputHash,
        args.redactionPolicyVersion,
        args.requestedBy,
      ],
    );
    // Mark prior generations (if any) superseded. This is the NATIVE English
    // canonical write, so the new canonical at `generation` is the authority
    // for the whole bilingual pair. Supersede EVERY lower-generation row of
    // this `(customer, story, model)` variant — both the prior English row AND
    // any prior translated user-language row — NOT just `lang = job.lang`
    // (#580). The translated row always shares the canonical's
    // `model_name`/`model` and copies its `generation`, so any translated row
    // at a lower generation is pinned to a now-superseded English canonical.
    // Superseding it the moment the new canonical lands closes the
    // stale-user-language-row window: if the matching translation is still
    // in-flight or permanently fails (4xx / factor-shape / leak), no live
    // translated row remains, so the reader and report builder fall back to the
    // new English canonical instead of consuming stale translated scores. The
    // `generation < $6` bound never touches the same-generation translated row
    // (which derives FROM this canonical and is written afterward).
    await client.query(
      `UPDATE story_analysis_result
          SET superseded_at = NOW()
        WHERE customer_id = $1 AND story_id = $2::bigint
          AND model_name = $3 AND model = $4
          AND generation < $5
          AND superseded_at IS NULL`,
      [
        args.job.customer_id,
        args.job.story_id,
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

async function finalizeJob(
  authPool: Pool,
  job: JobPickup,
  detail: {
    priorityTier: PriorityTier;
    severityScore: number;
    likelihoodScore: number;
    promptVersion: string | null;
    modelActualVersion: string | null;
  },
): Promise<void> {
  // Captured generation must still match. If a force-regenerate raced
  // ahead while the LLM call was in flight, the WHERE-clause matches
  // zero rows and the new queued generation runs on the next tick.
  const finalized = await authPool.query(
    `UPDATE story_analysis_job
        SET status = 'done',
            last_generated_at = NOW(),
            last_error = NULL,
            dry_run = FALSE,
            updated_at = NOW()
      WHERE customer_id = $1 AND story_id = $2::bigint
        AND lang = $3 AND model_name = $4 AND model = $5
        AND generation = $6
        AND status = 'processing'`,
    [
      job.customer_id,
      job.story_id,
      job.lang,
      job.model_name,
      job.model,
      job.generation,
    ],
  );

  // Only mirror the priority when THIS generation actually finalized. If the
  // guarded update above matched zero rows — a force-regenerate raced ahead
  // and bumped the auth row to a newer generation while the LLM call was in
  // flight — then this generation's result is already (or about to be)
  // superseded. Publishing its priority/scores would show a stale, superseded
  // generation as the canonical denormalized priority on the Threat Stories
  // list until the newer job finishes. The newer generation mirrors its own
  // values when it finalizes, so skip the write here.
  if ((finalized.rowCount ?? 0) === 0) return;

  // WS3 (#392) — denormalize the canonical variant's priority onto
  // `story_analysis_state` so the Threat Stories list can order
  // priority-first and keyset-paginate in a single auth-DB query. Only the
  // default variant feeds these columns — `story_analysis_state` carries one
  // row per `(customer_id, story_id)`, and the list resolves each story to
  // its single canonical variant, so a non-default-variant finalize must not
  // overwrite the mirror. The default MODEL is now per-customer (#473):
  // resolved through `resolveDefaultModel` so the mirror tracks the same
  // variant the seeder treats as default (no silent mismatch). The mirror is
  // fed by the English canonical (`DEFAULT_LANG`, #580): its scores are
  // language-invariant, so the priority-first story list orders identically
  // regardless of the app user-language, and the translated user-language row —
  // which merely copies the canonical's scores — must NOT write the mirror
  // (each generation updates it exactly once). The scores stored here are the
  // raw on-disk values (matching `story_analysis_result`), not the floored
  // likelihood used only for tier lookup. Guarded on `status <> 'archived'`: a
  // row that archived while this generation was in flight stays archived (the
  // result is already superseded by the lifecycle).
  const defaultPair = await resolveDefaultModel(job.customer_id, authPool);
  if (
    job.lang === DEFAULT_LANG &&
    job.model_name === defaultPair.modelName &&
    job.model === defaultPair.model
  ) {
    await authPool.query(
      `UPDATE story_analysis_state
          SET priority_tier    = $3,
              severity_score   = $4,
              likelihood_score = $5,
              updated_at       = NOW()
        WHERE customer_id = $1 AND story_id = $2::bigint
          AND status <> 'archived'`,
      [
        job.customer_id,
        job.story_id,
        detail.priorityTier,
        detail.severityScore,
        detail.likelihoodScore,
      ],
    );
  }
}

async function failJob(
  authPool: Pool,
  job: JobPickup,
  reason: string,
  opts: { attempts?: number } = {},
): Promise<void> {
  // Precondition failures that happen BEFORE the LLM call leave
  // `attempts` at the captured value (no aimer call was made). Fatal
  // outcomes that follow a real aimer call (non-retryable 4xx,
  // hallucination_detected) pass `attempts = job.attempts + 1` so the
  // row reflects the consumed attempt, matching the issue's
  // attempt-accounting requirement and what `requeueWithBackoff` would
  // have written on the retryable path.
  const nextAttempts = opts.attempts ?? job.attempts;
  await authPool.query(
    `UPDATE story_analysis_job
        SET status = 'failed',
            attempts = $7,
            last_error = $8,
            updated_at = NOW()
      WHERE customer_id = $1 AND story_id = $2::bigint
        AND lang = $3 AND model_name = $4 AND model = $5
        AND generation = $6`,
    [
      job.customer_id,
      job.story_id,
      job.lang,
      job.model_name,
      job.model,
      job.generation,
      nextAttempts,
      reason,
    ],
  );
}

/**
 * RFC 0003 P1a (#361) default enrichment-readiness check: the canonical
 * `(story_id, story_version)` has a `story_enrichment_state` row marked
 * `complete`. Absent or non-complete → not ready (analysis requeues).
 *
 * Reads `story.known_ioc_hit` in the same statement (LEFT JOIN, one
 * snapshot) as the completion marker so the caller can floor on a value
 * that is consistent with the readiness it just gated on — closing the
 * race where `loadCanonicalMembers` read `known_ioc_hit` before enrichment
 * committed. `persistEnrichment` writes the floor UPDATE and the marker in
 * one transaction, so a `complete` status implies the joined
 * `known_ioc_hit` is the post-enrichment value. Returns `knownIocHit:
 * false` when no `story` row exists (the caller has already loaded the
 * canonical version, so in practice the row is always present).
 */
async function defaultCheckEnrichmentReady(
  customerPool: Pool,
  storyId: string,
  storyVersion: string,
): Promise<EnrichmentReadiness> {
  const { rows } = await customerPool.query<{
    status: string | null;
    last_error: string | null;
    known_ioc_hit: boolean | null;
  }>(
    `SELECT ses.status, ses.last_error, s.known_ioc_hit
       FROM story s
       LEFT JOIN story_enrichment_state ses
         ON ses.story_id = s.story_id
        AND ses.story_version = s.story_version
      WHERE s.story_id = $1::bigint AND s.story_version = $2`,
    [storyId, storyVersion],
  );
  return {
    ready: rows[0]?.status === "complete",
    knownIocHit: rows[0]?.known_ioc_hit ?? false,
    status: rows[0]?.status ?? null,
    lastError: rows[0]?.last_error ?? null,
  };
}

/**
 * RFC 0003 C1 (#440) default enrichment-fact loader: the redacted fact
 * bodies for the canonical `(story_id, story_version)`, ordered by
 * `fact_id` so the `F{k}` fact-scope index is stable across runs with the
 * same facts. Empty when the story produced no enrichment facts.
 */
async function defaultLoadEnrichmentFacts(
  customerPool: Pool,
  storyId: string,
  storyVersion: string,
): Promise<FactInput[]> {
  const { rows } = await customerPool.query<{
    fact_id: string;
    fact_text: string;
  }>(
    `SELECT fact_id::text AS fact_id, fact_text
       FROM story_enrichment_fact
      WHERE story_id = $1::bigint AND story_version = $2
      ORDER BY fact_id`,
    [storyId, storyVersion],
  );
  return rows.map((r) => ({ factId: r.fact_id, text: r.fact_text }));
}

/**
 * Re-queue a claimed job because enrichment has not yet completed for its
 * canonical version (RFC 0003 P1a #361). Unlike {@link requeueWithBackoff}
 * this does NOT consume a retry attempt: enrichment latency is an ordering
 * wait, not a job failure, so the job must not exhaust `MAX_ATTEMPTS` while
 * waiting. `attempts` is left untouched (typically 0), so the next tick
 * re-picks the row immediately. Guarded on `status = 'processing'` so only
 * the row this worker claimed is requeued.
 */
async function requeueForEnrichment(
  authPool: Pool,
  job: JobPickup,
): Promise<void> {
  await authPool.query(
    `UPDATE story_analysis_job
        SET status = 'queued',
            processing_started_at = NULL,
            next_due_at = NULL,
            last_error = 'awaiting_enrichment',
            updated_at = NOW()
      WHERE customer_id = $1 AND story_id = $2::bigint
        AND lang = $3 AND model_name = $4 AND model = $5
        AND generation = $6
        AND status = 'processing'`,
    [
      job.customer_id,
      job.story_id,
      job.lang,
      job.model_name,
      job.model,
      job.generation,
    ],
  );
}

async function requeueWithBackoff(
  authPool: Pool,
  job: JobPickup,
  reason: string,
): Promise<void> {
  const nextAttempts = job.attempts + 1;
  if (nextAttempts >= MAX_ATTEMPTS) {
    await authPool.query(
      `UPDATE story_analysis_job
          SET status = 'failed',
              attempts = $7,
              last_error = $8,
              updated_at = NOW()
        WHERE customer_id = $1 AND story_id = $2::bigint
          AND lang = $3 AND model_name = $4 AND model = $5
          AND generation = $6`,
      [
        job.customer_id,
        job.story_id,
        job.lang,
        job.model_name,
        job.model,
        job.generation,
        nextAttempts,
        reason,
      ],
    );
    return;
  }
  await authPool.query(
    // Reset next_due_at on the non-terminal requeue so retry timing is governed
    // solely by the attempts-based backoff in the picker, not by a leftover
    // future next_due_at (e.g. a canonical-defer value) (#580).
    `UPDATE story_analysis_job
        SET status = 'queued',
            attempts = $7,
            last_error = $8,
            processing_started_at = NULL,
            next_due_at = NULL,
            updated_at = NOW()
      WHERE customer_id = $1 AND story_id = $2::bigint
        AND lang = $3 AND model_name = $4 AND model = $5
        AND generation = $6`,
    [
      job.customer_id,
      job.story_id,
      job.lang,
      job.model_name,
      job.model,
      job.generation,
      nextAttempts,
      reason,
    ],
  );
}

// ---------------------------------------------------------------------------
// Translate path (#580) — user-language row derived from the English canonical
// ---------------------------------------------------------------------------

/**
 * The English canonical `story_analysis_result` row a user-language variant
 * derives from: the English row at the SAME `(model_name, model, generation)`
 * as the job. The `generation` match is load-bearing AND sufficient — the
 * result PK includes `generation`, so a translate job bumped to generation N
 * (dirty / force) cannot read a stale generation N-1 row; it matches gen N or
 * defers. We deliberately do NOT require `superseded_at IS NULL`: a
 * same-generation English row superseded by a later English-only generation is
 * still the correct canonical for a translate job pinned to that generation
 * (mirrors the report worker). `null` when no English row exists at this
 * generation yet — the caller defers.
 */
interface StoryEnglishCanonical {
  analysisText: string;
  severityFactors: string[];
  likelihoodFactors: string[];
  severityScore: number;
  likelihoodScore: number;
  ttpTags: string[];
  priorityTier: PriorityTier;
  inputEventRefs: unknown;
  inputFactRefs: unknown;
  modelActualVersion: string;
  promptVersion: string;
  inputHash: string;
  redactionPolicyVersion: string;
}

async function loadStoryEnglishCanonical(
  customerPool: Pool,
  job: JobPickup,
): Promise<StoryEnglishCanonical | null> {
  const { rows } = await customerPool.query<{
    analysis_text: string;
    severity_factors: string[] | null;
    likelihood_factors: string[] | null;
    severity_score: number;
    likelihood_score: number;
    ttp_tags: string[] | null;
    priority_tier: string;
    input_event_refs: unknown;
    input_fact_refs: unknown;
    model_actual_version: string;
    prompt_version: string;
    input_hash: string;
    redaction_policy_version: string;
  }>(
    `SELECT analysis_text,
            severity_factors, likelihood_factors,
            severity_score, likelihood_score,
            ttp_tags, priority_tier,
            input_event_refs, input_fact_refs,
            model_actual_version, prompt_version,
            input_hash, redaction_policy_version
       FROM story_analysis_result
      WHERE customer_id = $1 AND story_id = $2::bigint
        AND lang = $3 AND model_name = $4 AND model = $5
        AND generation = $6
      LIMIT 1`,
    [
      job.customer_id,
      job.story_id,
      DEFAULT_LANG,
      job.model_name,
      job.model,
      job.generation,
    ],
  );
  if (rows.length === 0) return null;
  const r = rows[0];
  return {
    analysisText: r.analysis_text,
    severityFactors: Array.isArray(r.severity_factors)
      ? r.severity_factors
      : [],
    likelihoodFactors: Array.isArray(r.likelihood_factors)
      ? r.likelihood_factors
      : [],
    severityScore: r.severity_score,
    likelihoodScore: r.likelihood_score,
    ttpTags: Array.isArray(r.ttp_tags) ? r.ttp_tags : [],
    priorityTier: r.priority_tier as PriorityTier,
    inputEventRefs: r.input_event_refs,
    inputFactRefs: r.input_fact_refs,
    modelActualVersion: r.model_actual_version,
    promptVersion: r.prompt_version,
    inputHash: r.input_hash,
    redactionPolicyVersion: r.redaction_policy_version,
  };
}

export interface TranslateNarrativeAimerResponse {
  analysis: string;
  severityFactors: string[];
  likelihoodFactors: string[];
  promptVersion: string;
  modelActualVersion: string;
}

// Translate-path call wrapper — aimer's stateless, token-preserving
// `translateAnalysisNarrative` mutation (#580 / aimer#495). The numeric scores,
// MITRE codes, and priority tier are language-invariant and are NOT sent or
// returned; only the narrative and the score-factor phrases are localized.
async function callTranslateAnalysisNarrative(args: {
  analysis: string;
  severityFactors: string[];
  likelihoodFactors: string[];
  targetLang: string;
  modelName: string;
  model: string;
  aiceId: string;
}): Promise<TranslateNarrativeAimerResponse> {
  const result = await graphqlRequest(
    TranslateAnalysisNarrativeDocument,
    {
      analysis: args.analysis,
      severityFactors: args.severityFactors,
      likelihoodFactors: args.likelihoodFactors,
      targetLang: args.targetLang as "KOREAN" | "ENGLISH",
      name: args.modelName,
      model: args.model,
    },
    { accountId: WORKER_ACCOUNT_ID, aiceId: args.aiceId },
  );
  return result.translateAnalysisNarrative;
}

// Defer a user-language translate job whose English canonical is not yet
// available. NON-TERMINAL: leaves `status = 'queued'` and `attempts` UNCHANGED
// (never counts toward `MAX_ATTEMPTS` / `failed`), and sets `next_due_at` so the
// picker — which now honors `next_due_at` for queued rows — does not re-pick it
// on the next tick (no hot spin). Keyed by the claim marker so a stale
// timed-out attempt cannot defer a later re-claimed one (#580).
async function deferJobForCanonical(
  authPool: Pool,
  job: JobPickup,
  claimMarker: string | null,
): Promise<void> {
  await authPool.query(
    `UPDATE story_analysis_job
        SET status = 'queued',
            processing_started_at = NULL,
            next_due_at = NOW() + ($7::bigint * interval '1 millisecond'),
            last_error = 'english_canonical_not_ready',
            updated_at = NOW()
      WHERE customer_id = $1 AND story_id = $2::bigint
        AND lang = $3 AND model_name = $4 AND model = $5
        AND generation = $6
        AND status = 'processing'
        AND processing_started_at::text = $8`,
    [
      job.customer_id,
      job.story_id,
      job.lang,
      job.model_name,
      job.model,
      job.generation,
      CANONICAL_DEFER_MS,
      claimMarker,
    ],
  );
}

interface StoryTranslationAudit {
  translationModelName: string;
  translationModel: string;
  translationPromptVersion: string;
}

/**
 * Persist the translation audit columns on the `story_analysis_job` row while
 * it is still `processing`, BEFORE the customer-DB result-row insert. The
 * result row (customer DB) and the audit columns (auth DB) cannot share a
 * transaction, so a crash between the insert and finalize would otherwise leave
 * a durable translated row whose audit trail never landed. Writing the audit
 * first means the crash-recovery result probe only has to PRESERVE these
 * columns (the native `finalizeJob` never touches them). It is also the
 * authoritative claim re-check: if the watchdog returned the row to `queued`
 * and cleared `processing_started_at`, the claim-marker guard matches zero rows
 * and the caller ABORTS before the customer-DB insert (#580). Returns the
 * affected row count.
 */
async function recordStoryTranslationAudit(
  authPool: Pool,
  job: JobPickup,
  claimMarker: string | null,
  audit: StoryTranslationAudit,
): Promise<number> {
  const res = await authPool.query(
    `UPDATE story_analysis_job
        SET translation_model_name = $7,
            translation_model = $8,
            translation_prompt_version = $9,
            updated_at = NOW()
      WHERE customer_id = $1 AND story_id = $2::bigint
        AND lang = $3 AND model_name = $4 AND model = $5
        AND generation = $6
        AND status = 'processing'
        AND processing_started_at::text = $10`,
    [
      job.customer_id,
      job.story_id,
      job.lang,
      job.model_name,
      job.model,
      job.generation,
      audit.translationModelName,
      audit.translationModel,
      audit.translationPromptVersion,
      claimMarker,
    ],
  );
  return res.rowCount ?? 0;
}

/**
 * Finalize a user-language translate job: flip to `done` and re-assert the
 * translation audit columns (already persisted by `recordStoryTranslationAudit`
 * before the result insert), guarded by the claim marker. The translate job is
 * never the English canonical, so it never feeds the `story_analysis_state`
 * mirror (#580) — hence no `resolveDefaultModel` / state write here.
 */
async function finalizeTranslatedJob(
  authPool: Pool,
  job: JobPickup,
  claimMarker: string | null,
  audit: StoryTranslationAudit,
): Promise<void> {
  await authPool.query(
    `UPDATE story_analysis_job
        SET status = 'done',
            last_generated_at = NOW(),
            next_due_at = NULL,
            last_error = NULL,
            dry_run = FALSE,
            translation_model_name = $7,
            translation_model = $8,
            translation_prompt_version = $9,
            updated_at = NOW()
      WHERE customer_id = $1 AND story_id = $2::bigint
        AND lang = $3 AND model_name = $4 AND model = $5
        AND generation = $6
        AND status = 'processing'
        AND processing_started_at::text = $10`,
    [
      job.customer_id,
      job.story_id,
      job.lang,
      job.model_name,
      job.model,
      job.generation,
      audit.translationModelName,
      audit.translationModel,
      audit.translationPromptVersion,
      claimMarker,
    ],
  );
}

/**
 * Customer-DB write for the translated user-language row: copies the English
 * canonical's numeric scores, priority tier, TTP codes, cited refs, and
 * provenance (`model_actual_version` / `prompt_version`) verbatim, stores the
 * translated narrative + factor phrases, and pins `restoration_lang = ENGLISH`
 * so the loader replays the English cited leaves. Supersedes any prior live
 * translated row of the same `(customer, story, lang, model)` so a fresh
 * translation replaces a stale one (idempotent under crash/retry).
 */
async function writeTranslatedResultRow(
  customerPool: Pool,
  job: JobPickup,
  values: {
    canonical: StoryEnglishCanonical;
    translatedAnalysis: string;
    translatedSeverityFactors: string[];
    translatedLikelihoodFactors: string[];
    requestedBy: string | null;
  },
): Promise<void> {
  const { canonical } = values;
  const client = await customerPool.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      `INSERT INTO story_analysis_result
         (customer_id, story_id, lang, restoration_lang, model_name, model,
          model_actual_version, prompt_version, generation,
          severity_score, likelihood_score,
          severity_factors, likelihood_factors, ttp_tags,
          priority_tier, analysis_text,
          input_event_refs, input_fact_refs, input_hash,
          redaction_policy_version, requested_by)
       VALUES ($1, $2::bigint, $3, $4, $5, $6,
               $7, $8, $9,
               $10, $11,
               $12::jsonb, $13::jsonb, $14::jsonb,
               $15, $16,
               $17::jsonb, $18::jsonb, $19,
               $20, $21::uuid)`,
      [
        job.customer_id,
        job.story_id,
        job.lang,
        DEFAULT_LANG, // restoration_lang = ENGLISH
        job.model_name,
        job.model,
        canonical.modelActualVersion,
        canonical.promptVersion,
        job.generation,
        canonical.severityScore,
        canonical.likelihoodScore,
        JSON.stringify(values.translatedSeverityFactors),
        JSON.stringify(values.translatedLikelihoodFactors),
        JSON.stringify(canonical.ttpTags),
        canonical.priorityTier,
        values.translatedAnalysis,
        JSON.stringify(canonical.inputEventRefs ?? []),
        JSON.stringify(canonical.inputFactRefs ?? []),
        canonical.inputHash,
        canonical.redactionPolicyVersion,
        values.requestedBy,
      ],
    );
    await client.query(
      `UPDATE story_analysis_result
          SET superseded_at = NOW()
        WHERE customer_id = $1 AND story_id = $2::bigint
          AND lang = $3 AND model_name = $4 AND model = $5
          AND generation < $6
          AND superseded_at IS NULL`,
      [
        job.customer_id,
        job.story_id,
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

interface RunStoryTranslationArgs {
  job: JobPickup;
  opts: ProcessOptions;
  customerPool: Pool;
  claimMarker: string | null;
}

/**
 * Derive the user-language row by ALWAYS translating the English canonical
 * (#580). Defers (without consuming the retry budget) until the canonical
 * exists; copies the canonical's numeric scores / tier / TTP / cited refs
 * verbatim; translates ONLY the narrative and the factor phrases; preserves the
 * canonical factor count and order element-wise (no `filterFactors` re-run);
 * leak-scans the translated text against the canonical's allowed tokens; and
 * persists with `restoration_lang = ENGLISH`.
 */
async function runStoryTranslation(
  args: RunStoryTranslationArgs,
): Promise<void> {
  const { job, opts, customerPool, claimMarker } = args;
  const callTranslate =
    opts.callTranslateAnalysisNarrative ?? callTranslateAnalysisNarrative;

  // The English canonical must already exist. If absent, defer WITHOUT
  // consuming the retry/failure budget — "canonical not ready" is a normal
  // wait, not a failure. The defer sets `next_due_at` so the job does not
  // hot-spin and leaves `attempts` untouched.
  const canonical = await loadStoryEnglishCanonical(customerPool, job);
  if (canonical === null) {
    await deferJobForCanonical(opts.authPool, job, claimMarker);
    console.warn(
      JSON.stringify({
        level: "warn",
        event: "analysis.story_canonical_defer",
        customer_id: job.customer_id,
        story_id: job.story_id,
        lang: job.lang,
        model_name: job.model_name,
        model: job.model,
        generation: job.generation,
        reason: "english_canonical_not_ready",
      }),
    );
    return;
  }

  // Resolve the story's `source_aice_id` for the aimer request context and
  // confirm the source story still exists; if it is gone, fail loudly (we
  // refuse to persist a translation whose source has vanished).
  const members = await loadCanonicalMembers(customerPool, job.story_id);
  if (!members) {
    await failJob(opts.authPool, job, "source_unavailable");
    return;
  }
  // Leak-scan allow-list = the EXACT redaction tokens (member `E{i}` + fact
  // `F{k}`) the English canonical was generated and ALREADY validated against,
  // taken from its STORED narrative + factor phrases (#580). Deriving it from
  // the stored canonical row — rather than re-running `buildStoryTokenMap`
  // against whatever story version / enrichment facts are latest at
  // translation time — keeps the scan pinned to generation N's actual LLM
  // input. If ingestion advances the story version or facts between the
  // English generation and this translation attempt, a member-rebuilt set
  // would falsely fail a valid translation (a now-removed token) or admit a
  // token absent from the canonical (a newly-added one). aimer preserves every
  // redaction token verbatim, so a faithful translation can only echo tokens
  // already in the canonical text. Mirrors the report translate path's
  // canonical-pinned allow-list.
  const allowedTokens = extractRedactionTokens(
    [
      canonical.analysisText,
      ...canonical.severityFactors,
      ...canonical.likelihoodFactors,
    ].join("\n"),
  );

  const auditBase: AuditEmissionBase = {
    actorId: WORKER_ACCOUNT_ID,
    authContext: "general",
    targetType: "story_analysis_result",
    customerId: job.customer_id,
    aiceId: members.sourceAiceId,
  };
  const force = job.force_requested_at !== null;

  void auditLog({
    ...auditBase,
    action: "ai_analysis.request_issued",
    targetId: `${job.customer_id}/${job.story_id}`,
    details: {
      customer_id: job.customer_id,
      story_id: job.story_id,
      lang: job.lang,
      model_name: job.model_name,
      model: job.model,
      generation: job.generation,
      force,
      translate: true,
      translation_model_name: TRANSLATION_MODEL_NAME,
      translation_model: TRANSLATION_MODEL,
    },
  });

  let aimerResponse: TranslateNarrativeAimerResponse;
  try {
    aimerResponse = await callTranslate({
      analysis: canonical.analysisText,
      severityFactors: canonical.severityFactors,
      likelihoodFactors: canonical.likelihoodFactors,
      targetLang: job.lang,
      modelName: TRANSLATION_MODEL_NAME,
      model: TRANSLATION_MODEL,
      aiceId: members.sourceAiceId,
    });
  } catch (err) {
    const classification = classifyAimerError(err);
    void auditLog({
      ...auditBase,
      action: "ai_analysis.aimer_call_failed",
      targetId: `${job.customer_id}/${job.story_id}`,
      details: {
        generation: job.generation,
        stage: "translate",
        code: classification.code,
        retryable: classification.retryable,
        error: err instanceof Error ? err.message : String(err),
      },
    });
    if (!classification.retryable) {
      await failJob(opts.authPool, job, classification.code, {
        attempts: job.attempts + 1,
      });
      return;
    }
    await requeueWithBackoff(opts.authPool, job, classification.code);
    return;
  }

  // Factor length/order preservation (#580): the translated arrays are an
  // element-wise translation of the canonical's already-shape-filtered factors.
  // Do NOT re-run `filterFactors` on the translated row — a length or order
  // change would silently break the factor↔meaning correspondence even though
  // the numbers match. aimer#495 guarantees the element count; treat any
  // mismatch as a loud shape failure.
  if (
    aimerResponse.severityFactors.length !== canonical.severityFactors.length ||
    aimerResponse.likelihoodFactors.length !==
      canonical.likelihoodFactors.length
  ) {
    void auditLog({
      ...auditBase,
      action: "ai_analysis.hallucination_detected",
      targetId: `${job.customer_id}/${job.story_id}`,
      details: {
        generation: job.generation,
        stage: "translate_factor_shape",
        canonical_severity: canonical.severityFactors.length,
        canonical_likelihood: canonical.likelihoodFactors.length,
        translated_severity: aimerResponse.severityFactors.length,
        translated_likelihood: aimerResponse.likelihoodFactors.length,
      },
    });
    await failJob(opts.authPool, job, "translation_factor_shape_changed", {
      attempts: job.attempts + 1,
    });
    return;
  }

  // Leak scan on the translated narrative AND factor phrases: aimer#495
  // preserves every redaction token verbatim, so the same `allowedTokens`
  // derived from the canonical's leaves must cover the translated text. Any
  // residual / leaked token (or decoded plaintext IP/domain) fails the job
  // before the row is written, exactly as the native path does.
  const ranges = await (opts.loadRanges ?? loadCustomerRanges)(
    opts.authPool,
    job.customer_id,
  );
  const ownedDomains = await (
    opts.loadOwnedDomains ?? loadCustomerOwnedDomains
  )(opts.authPool, job.customer_id);
  const leakScan = scanStoryAnalysisForLeaks(
    [
      aimerResponse.analysis,
      ...aimerResponse.severityFactors,
      ...aimerResponse.likelihoodFactors,
    ].join("\n"),
    allowedTokens,
    ranges,
    ownedDomains,
  );
  if (leakScan.hasLeak) {
    void auditLog({
      ...auditBase,
      action: "ai_analysis.hallucination_detected",
      targetId: `${job.customer_id}/${job.story_id}`,
      details: {
        generation: job.generation,
        stage: "translate",
        leaks: leakScan.leaks.slice(0, 20),
      },
    });
    await failJob(opts.authPool, job, "hallucination_detected", {
      attempts: job.attempts + 1,
    });
    return;
  }

  const translationAudit: StoryTranslationAudit = {
    translationModelName: TRANSLATION_MODEL_NAME,
    translationModel: TRANSLATION_MODEL,
    translationPromptVersion: aimerResponse.promptVersion,
  };

  // Persist the translation audit BEFORE the customer-DB result insert (so a
  // crash between insert and finalize cannot lose it) AND as the authoritative
  // claim re-check: a zero row count means the watchdog returned this row to
  // `queued` mid-translation, so ABORT before the durable result insert.
  const auditRows = await recordStoryTranslationAudit(
    opts.authPool,
    job,
    claimMarker,
    translationAudit,
  );
  if (auditRows === 0) {
    console.warn(
      JSON.stringify({
        level: "warn",
        event: "analysis.story_translation_claim_lost",
        customer_id: job.customer_id,
        story_id: job.story_id,
        generation: job.generation,
      }),
    );
    return;
  }

  // Step 1 — customer-DB INSERT (translated text + copied canonical fields).
  try {
    await writeTranslatedResultRow(customerPool, job, {
      canonical,
      translatedAnalysis: aimerResponse.analysis,
      translatedSeverityFactors: aimerResponse.severityFactors,
      translatedLikelihoodFactors: aimerResponse.likelihoodFactors,
      requestedBy: force ? job.force_requested_by : null,
    });
  } catch (err) {
    void auditLog({
      ...auditBase,
      action: "ai_analysis.aimer_call_failed",
      targetId: `${job.customer_id}/${job.story_id}`,
      details: {
        generation: job.generation,
        stage: "result_insert",
        error: err instanceof Error ? err.message : String(err),
      },
    });
    throw err;
  }

  // Step 2 — auth-DB finalize (re-asserting the translation audit, no mirror).
  await finalizeTranslatedJob(
    opts.authPool,
    job,
    claimMarker,
    translationAudit,
  );

  void auditLog({
    ...auditBase,
    action: "ai_analysis.result_stored",
    targetId: `${job.customer_id}/${job.story_id}`,
    details: {
      customer_id: job.customer_id,
      story_id: job.story_id,
      generation: job.generation,
      prompt_version: canonical.promptVersion,
      model_actual_version: canonical.modelActualVersion,
      priority_tier: canonical.priorityTier,
      translate: true,
      restoration_lang: DEFAULT_LANG,
      translation_model_name: TRANSLATION_MODEL_NAME,
      translation_model: TRANSLATION_MODEL,
      translation_prompt_version: aimerResponse.promptVersion,
    },
  });
}

// ---------------------------------------------------------------------------
// Audit row helpers
// ---------------------------------------------------------------------------

function groupBy<K extends string, V>(
  items: readonly V[],
  key: (v: V) => K,
): Map<K, V[]> {
  const map = new Map<K, V[]>();
  for (const item of items) {
    const k = key(item);
    const bucket = map.get(k);
    if (bucket) bucket.push(item);
    else map.set(k, [item]);
  }
  return map;
}

function emitFactorAuditRows(args: {
  auditBase: AuditEmissionBase;
  storyId: string;
  axis: FactorAxis;
  rawInput: readonly string[];
  filter: FilterFactorsResult;
}): void {
  const targetId = `${args.auditBase.customerId}/${args.storyId}`;
  const targetFields = {
    customer_id: args.auditBase.customerId,
    aice_id: null,
    event_key: null,
    story_id: args.storyId,
  } as const;
  const byReason = groupBy(args.filter.dropped, (d) => d.reason);
  for (const [reason, items] of byReason) {
    void auditLog({
      ...args.auditBase,
      action: "ai_analysis.factor_dropped",
      targetId,
      details: {
        ...targetFields,
        axis: args.axis,
        dropped_items: items.map((d) => d.item),
        reason,
        replaced_with_sentinel: false,
      },
    });
  }
  if (args.filter.usedSentinel) {
    void auditLog({
      ...args.auditBase,
      action: "ai_analysis.factor_dropped",
      targetId,
      details: {
        ...targetFields,
        axis: args.axis,
        dropped_items: [...args.rawInput],
        reason: "all_items_filtered",
        replaced_with_sentinel: true,
      },
    });
  }
}

function emitTtpDropAuditRows(args: {
  auditBase: AuditEmissionBase;
  storyId: string;
  dropped: ReadonlyArray<{ id: string; reason: string }>;
}): void {
  const targetId = `${args.auditBase.customerId}/${args.storyId}`;
  const targetFields = {
    customer_id: args.auditBase.customerId,
    aice_id: null,
    event_key: null,
    story_id: args.storyId,
  } as const;
  const byReason = groupBy(args.dropped, (d) => d.reason);
  for (const [reason, items] of byReason) {
    void auditLog({
      ...args.auditBase,
      action: "ai_analysis.ttp_tag_dropped",
      targetId,
      details: {
        ...targetFields,
        dropped_ids: items.map((d) => d.id),
        reason,
        mitre_vendor_version: MITRE_VENDOR_VERSION,
      },
    });
  }
}

// ---------------------------------------------------------------------------
// Tick + helpers exported for the analysis-job-worker
// ---------------------------------------------------------------------------

/**
 * Process up to `limit` queued story jobs. Wraps each job in an
 * advisory lock so concurrent worker replicas cannot double-run the
 * same `(customer_id, story_id)`. Returns the count of jobs attempted
 * (does not distinguish success from failure — the per-job paths emit
 * their own audit + status transitions).
 */
export async function tickStoryJobsOnce(
  authPool: Pool,
  limit: number,
  opts: ProcessOptions = { authPool },
): Promise<number> {
  // Pickup is a short auth-DB transaction. We commit the `processing`
  // marker before running the (potentially slow) LLM call.
  const client = await authPool.connect();
  let picks: JobPickup[] = [];
  try {
    await client.query("BEGIN");
    picks = await pickQueuedStoryJobs(client, limit);
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }

  for (const job of picks) {
    const lockId = customerLockId(job.customer_id);
    const lockId2 = jobStoryLockId2(job.story_id);
    const lockClient = await authPool.connect();
    try {
      const lockRes = await lockClient.query<{ locked: boolean }>(
        `SELECT pg_try_advisory_lock($1, $2) AS locked`,
        [lockId, lockId2],
      );
      if (!lockRes.rows[0]?.locked) continue;
      try {
        await processStoryJob(job, opts);
      } finally {
        await lockClient
          .query(`SELECT pg_advisory_unlock($1, $2)`, [lockId, lockId2])
          .catch(() => {});
      }
    } catch (err) {
      console.error("[story-worker] processStoryJob failed:", err);
    } finally {
      lockClient.release();
    }
  }

  return picks.length;
}

/**
 * Boot-time + watchdog recovery: flip `processing` rows that have been
 * stuck past the timeout back to `queued` so the next tick re-picks
 * them. The pickup-time result-row probe ensures that if step 1
 * already landed, step 2 is the only thing rerun.
 */
export async function recoverStuckStoryJobs(authPool: Pool): Promise<void> {
  await authPool.query(
    // Reset next_due_at too: a stuck row is being returned for IMMEDIATE
    // reprocessing, so a leftover future canonical-defer value must not stall
    // it now that the picker honors next_due_at for queued rows (#580).
    `UPDATE story_analysis_job
        SET status = 'queued',
            processing_started_at = NULL,
            next_due_at = NULL,
            updated_at = NOW()
      WHERE status = 'processing'
        AND dry_run = FALSE
        AND (processing_started_at IS NULL
             OR processing_started_at <= NOW() - ($1 || ' minutes')::interval)`,
    [PROCESSING_TIMEOUT_MINUTES],
  );
}

/**
 * Seed a real (non-dry-run) job row for every `ready`/`dirty` state row that
 * is missing a job for any language in the eager set (`EAGER_LANGS` — English
 * baseline ∪ the app user-language, #580). English is generated natively and
 * is the canonical; every other eager language is always TRANSLATED from it.
 *
 * The eager set is seeded "along the language dimension only": every entry
 * shares the per-customer default model pair. A `ready` bucket that already
 * has English but not the user language is still picked up (anti-join) and the
 * missing language seeded. On a `dirty` signal every existing variant is
 * bumped together so English and the user-language translate job stay at the
 * same generation (the translate job derives from the English canonical at its
 * own generation).
 */
export async function seedRealStoryJobs(
  authClient: PoolClient,
  batchSize: number,
  nowIso: string = getCurrentTimestamp().toISOString(),
): Promise<void> {
  // The default MODEL is per-customer (#473): the effective default for a
  // customer is COALESCE(per-customer override, admin-set global, env). The
  // override / global tiers live in `customer_default_model` /
  // `system_settings`, so the seeding query computes the effective pair
  // per row via a LEFT JOIN + COALESCE and carries it forward — what used
  // to be the single env `WORKER_MODEL_NAME`/`WORKER_MODEL` pair is now
  // resolved per customer. Every eager language shares this one resolved pair.
  //
  // DEFENSIVE catalog filtering (#473 review round 1): the SQL must mirror
  // `resolveDefaultModel`'s read-path fallback so worker seeding and the
  // page/coverage resolver cannot disagree. A stored per-customer override
  // or global default that is malformed/partial (e.g. a global JSON missing
  // `model`, which would otherwise mix the global `modelName` with the env
  // `model`) or has fallen out of `ANALYSIS_MODEL_CATALOG` after it was
  // saved (catalog change, or a direct DB write that bypassed the
  // validating setter) is SKIPPED so resolution falls through to the next
  // tier instead of seeding under a stale or mixed pair. The catalog is
  // env/code-resident, so it is passed in as a JSON array ($5) and each DB
  // tier is filtered against it here. `FOR UPDATE OF s` keeps the row lock
  // on `story_analysis_state` only — the joined config tables are not
  // locked.
  const catalogJson = JSON.stringify(
    getModelCatalog().map((e) => ({ modelName: e.modelName, model: e.model })),
  );
  const { rows: actionable } = await authClient.query<{
    customer_id: string;
    story_id: string;
    status: "ready" | "dirty";
    model_name: string;
    model: string;
  }>(
    `WITH catalog AS (
       SELECT elem->>'modelName' AS model_name,
              elem->>'model'     AS model
         FROM jsonb_array_elements($5::jsonb) AS elem
     ),
     global_default AS (
       SELECT g.model_name, g.model
         FROM (
           SELECT value->>'modelName' AS model_name,
                  value->>'model'     AS model
             FROM system_settings
            WHERE key = 'analysis_default_model'
         ) g
        WHERE g.model_name IS NOT NULL
          AND g.model IS NOT NULL
          AND EXISTS (
            SELECT 1 FROM catalog c
             WHERE c.model_name = g.model_name AND c.model = g.model
          )
     )
     SELECT s.customer_id::text AS customer_id,
            s.story_id::text    AS story_id,
            s.status,
            COALESCE(cdm.model_name, gd.model_name, $3) AS model_name,
            COALESCE(cdm.model,      gd.model,      $4) AS model
       FROM story_analysis_state s
       LEFT JOIN customer_default_model cdm
         ON cdm.customer_id = s.customer_id
        AND EXISTS (
          SELECT 1 FROM catalog c
           WHERE c.model_name = cdm.model_name AND c.model = cdm.model
        )
       LEFT JOIN global_default gd ON TRUE
      WHERE s.status = 'dirty'
         OR (s.status = 'ready'
             -- Actionable when ANY eager-set language lacks a job (anti-join
             -- over unnest($2)): a story that has English but not the user
             -- language is still picked up and the missing language seeded.
             AND EXISTS (
               SELECT 1 FROM unnest($2::text[]) AS el(lang)
                WHERE NOT EXISTS (
                  SELECT 1 FROM story_analysis_job j
                   WHERE j.customer_id = s.customer_id
                     AND j.story_id    = s.story_id
                     AND j.lang        = el.lang
                     AND j.model_name  = COALESCE(cdm.model_name, gd.model_name, $3)
                     AND j.model       = COALESCE(cdm.model,      gd.model,      $4)
                )
             ))
      ORDER BY s.customer_id, s.story_id
      LIMIT $1
      FOR UPDATE OF s SKIP LOCKED`,
    [batchSize, EAGER_LANGS, WORKER_MODEL_NAME, WORKER_MODEL, catalogJson],
  );
  for (const row of actionable) {
    if (row.status === "dirty") {
      // Surface every existing variant already at the cap. An at-cap variant
      // cannot auto-bump on a dirty signal; only an operator force may push
      // past the cap (via the regenerate endpoint).
      const { rows: capped } = await authClient.query<{
        lang: string;
        model_name: string;
        model: string;
      }>(
        `SELECT lang, model_name, model FROM story_analysis_job
          WHERE customer_id = $1 AND story_id = $2::bigint
            AND generation >= $3`,
        [row.customer_id, row.story_id, MAX_GENERATION],
      );
      for (const variant of capped) {
        console.warn(
          JSON.stringify({
            level: "warn",
            event: "analysis.story_max_generation_reached",
            customer_id: row.customer_id,
            story_id: row.story_id,
            lang: variant.lang,
            model_name: variant.model_name,
            model: variant.model,
            max_generation: MAX_GENERATION,
          }),
        );
      }
      // Bump the eager bilingual pair under the dirty state to ONE shared
      // target generation — not a per-row `generation + 1` (#580). The
      // user-language translate job derives from the English canonical at the
      // SAME generation, so the pair must advance in lockstep: a per-row `+1`
      // preserves any pre-existing offset (e.g. English at 3, no Korean →
      // English 4 but a missing Korean seeded at a stale generation), leaving a
      // user-language row pinned to a superseded English generation. Compute
      // the target as MAX(existing generation) + 1 for THIS model pair (capped
      // at MAX_GENERATION) and apply it uniformly to every eager-lang variant,
      // then seed any missing eager variant at the same target. Reset
      // next_due_at so a leftover canonical-defer value cannot stall the bumped
      // row; clear the force metadata so a source-driven bump stays classified
      // automatic. The cap is honored via `generation < MAX` (the at-cap
      // variants warned above are skipped, and `min(..., MAX)` keeps the target
      // from overshooting). Legacy variants under a DIFFERENT model are not part
      // of this row's eager pair, so they keep the independent `+1` refresh.
      const { rows: maxGenRows } = await authClient.query<{
        max_gen: number | null;
      }>(
        `SELECT MAX(generation) AS max_gen FROM story_analysis_job
          WHERE customer_id = $1 AND story_id = $2::bigint
            AND model_name = $3 AND model = $4`,
        [row.customer_id, row.story_id, row.model_name, row.model],
      );
      const eagerTarget = Math.min(
        (maxGenRows[0]?.max_gen ?? 0) + 1,
        MAX_GENERATION,
      );
      await authClient.query(
        `UPDATE story_analysis_job
            SET generation = generation + 1,
                status = 'queued',
                attempts = 0,
                last_error = NULL,
                processing_started_at = NULL,
                next_due_at = NULL,
                dry_run = FALSE,
                force_requested_at = NULL,
                force_requested_by = NULL,
                updated_at = $3::timestamptz
          WHERE customer_id = $1 AND story_id = $2::bigint
            AND NOT (model_name = $4 AND model = $5)
            AND generation < $6`,
        [
          row.customer_id,
          row.story_id,
          nowIso,
          row.model_name,
          row.model,
          MAX_GENERATION,
        ],
      );
      await authClient.query(
        `UPDATE story_analysis_job
            SET generation = $7,
                status = 'queued',
                attempts = 0,
                last_error = NULL,
                processing_started_at = NULL,
                next_due_at = NULL,
                dry_run = FALSE,
                force_requested_at = NULL,
                force_requested_by = NULL,
                updated_at = $3::timestamptz
          WHERE customer_id = $1 AND story_id = $2::bigint
            AND model_name = $4 AND model = $5
            AND generation < $6`,
        [
          row.customer_id,
          row.story_id,
          nowIso,
          row.model_name,
          row.model,
          MAX_GENERATION,
          eagerTarget,
        ],
      );
      // Seed any still-missing eager-language variant at the shared target so a
      // freshly-seeded translation pairs with the bumped English canonical.
      // ON CONFLICT DO NOTHING leaves a variant that was just bumped above — or
      // one already at the cap — untouched.
      await seedEagerStoryLangJobs(authClient, row, nowIso, eagerTarget);
      await authClient.query(
        `UPDATE story_analysis_state
            SET status = 'ready',
                last_ready_at = $3::timestamptz,
                updated_at = $3::timestamptz
          WHERE customer_id = $1 AND story_id = $2::bigint AND status = 'dirty'`,
        [row.customer_id, row.story_id, nowIso],
      );
      continue;
    }
    // Ready branch: the story is already analyzed and some eager-lang variant
    // is simply missing a job (e.g. an existing single-language story after the
    // bilingual rollout). Seed the missing variant at the EXISTING canonical's
    // generation — NOT a fixed `1` — so the new translate job derives from and
    // pairs with the live English canonical instead of a superseded generation
    // (#580). With no existing variant (brand-new story) MAX resolves to NULL
    // and we fall back to generation 1.
    const { rows: readyGenRows } = await authClient.query<{
      max_gen: number | null;
    }>(
      `SELECT MAX(generation) AS max_gen FROM story_analysis_job
        WHERE customer_id = $1 AND story_id = $2::bigint
          AND model_name = $3 AND model = $4`,
      [row.customer_id, row.story_id, row.model_name, row.model],
    );
    const readyTarget = readyGenRows[0]?.max_gen ?? 1;
    await seedEagerStoryLangJobs(authClient, row, nowIso, readyTarget);
  }
}

/**
 * Seed a `queued` job at `generation` for every eager-set language (#580) that
 * does not already have one under this story state. ON CONFLICT DO NOTHING
 * makes it idempotent, so an existing variant is left untouched and only the
 * genuinely-missing languages get a row. Every eager language shares the
 * customer's effective default model pair, resolved by `seedRealStoryJobs`.
 *
 * `generation` MUST be the generation of the existing English canonical for
 * this story/model pair (or `1` for a brand-new story with no variants), so a
 * freshly-seeded user-language translate job derives from — and pairs with —
 * the CURRENT canonical generation. Seeding a missing translation at a fixed
 * `1` while the English canonical sits at a higher generation would pin the
 * translation to a stale/superseded canonical (the bilingual-pairing invariant
 * the force-regenerate path already upholds).
 */
async function seedEagerStoryLangJobs(
  authClient: PoolClient,
  row: {
    customer_id: string;
    story_id: string;
    model_name: string;
    model: string;
  },
  nowIso: string,
  generation: number,
): Promise<void> {
  for (const lang of EAGER_LANGS) {
    await authClient.query(
      `INSERT INTO story_analysis_job
         (customer_id, story_id, lang, model_name, model,
          status, generation, dry_run, created_at, updated_at)
       VALUES ($1, $2::bigint, $3, $4, $5,
               'queued', $7, FALSE, $6::timestamptz, $6::timestamptz)
       ON CONFLICT (customer_id, story_id, lang, model_name, model)
       DO NOTHING`,
      [
        row.customer_id,
        row.story_id,
        lang,
        row.model_name,
        row.model,
        nowIso,
        generation,
      ],
    );
  }
}

// Pair the customer-id-derived advisory lock half with a stable
// story-id-derived second half so two different stories under the
// same customer can run concurrently. We hash the story_id rather than
// cast to int to stay within the int4 advisory-lock argument range.
function jobStoryLockId2(storyId: string): number {
  let hash = 0;
  for (const ch of storyId) {
    hash = (hash * 31 + ch.charCodeAt(0)) | 0;
  }
  // Keep positive; advisory locks accept int4 signed but using a stable
  // positive value avoids confusion in logs.
  return Math.abs(hash) | 1;
}

export const __testables = {
  classifyAimerError,
  checkRedactionPolicyVersion,
  jobStoryLockId2,
  loadCanonicalMembers,
};
