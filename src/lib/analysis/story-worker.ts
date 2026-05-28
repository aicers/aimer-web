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
import { auditLog } from "@/lib/audit";
import { customerLockId } from "@/lib/db/customer-db";
import { getCustomerRuntimePool } from "@/lib/db/customer-runtime-pool";
import { AnalyzeStoryDocument } from "@/lib/graphql/__generated__/analyze-story";
import { graphqlRequest } from "@/lib/graphql/client";
import { getCurrentTimestamp } from "@/lib/instrumentation/time";
import {
  type FactorAxis,
  type FilterFactorsResult,
  filterFactors,
} from "./factor-filter";
import { MITRE_VENDOR_VERSION, validateTtpTags } from "./mitre-ttp";
import {
  applyLikelihoodFloors,
  computePriorityTier,
  type PriorityTier,
} from "./priority-tier";
import { buildStoryTokenMap, scanStoryAnalysisForLeaks } from "./story-token";

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
  event: unknown;
  redaction_policy_version: string;
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
  /** Override the customer-DB pool resolver — used by tests. */
  resolveCustomerPool?: (customerId: string) => Pool;
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
  const claim = await opts.authPool.query(
    `UPDATE story_analysis_job
        SET status = 'processing',
            processing_started_at = NOW(),
            updated_at = NOW()
      WHERE customer_id = $1 AND story_id = $2::bigint
        AND lang = $3 AND model_name = $4 AND model = $5
        AND generation = $6
        AND status = 'queued'
        AND attempts = $7`,
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

  // Result-row probe — if the result row at the captured PK already
  // exists, step 1 was completed by a previous attempt that crashed
  // before step 2. Skip the LLM call entirely and finalize.
  const existingResult = await customerPool.query<{ priority_tier: string }>(
    `SELECT priority_tier FROM story_analysis_result
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
    await finalizeJob(opts.authPool, job, {
      priorityTier: existingResult.rows[0].priority_tier as PriorityTier,
      promptVersion: null,
      modelActualVersion: null,
    });
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

  // Token rewrite + LLM call.
  const { rewrittenMembers, refs, allowedTokens } = buildStoryTokenMap(
    canonical.members.map((m) => ({
      aiceId: m.source_aice_id,
      eventKey: m.member_event_key,
      event: m.event,
    })),
  );
  const inputHash = createHash("sha256")
    .update(JSON.stringify(rewrittenMembers))
    .digest("hex");
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
    },
  });

  let aimerResponse: AnalyzeStoryAimerResponse;
  try {
    aimerResponse = await callLlm({
      membersJson: JSON.stringify(rewrittenMembers),
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
      await failJob(opts.authPool, job, classification.code);
      return;
    }
    await requeueWithBackoff(opts.authPool, job, classification.code);
    return;
  }

  // Hallucination scan.
  const leakScan = scanStoryAnalysisForLeaks(
    aimerResponse.analysis,
    allowedTokens,
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
    await failJob(opts.authPool, job, "hallucination_detected");
    return;
  }

  // Pre-storage validation.
  const severityFilter = filterFactors(
    aimerResponse.severityFactors,
    "severity",
  );
  const likelihoodFilter = filterFactors(
    aimerResponse.likelihoodFactors,
    "likelihood",
  );
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
      knownIocHit: false,
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

  // Step 2 — auth-DB finalize.
  await finalizeJob(opts.authPool, job, {
    priorityTier,
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
  members: StoryMemberRow[];
}

async function loadCanonicalMembers(
  customerPool: Pool,
  storyId: string,
): Promise<CanonicalMembers | null> {
  // Canonical version = latest by `story.received_at` per #294 decision 1.
  const storyRow = await customerPool.query<{
    story_version: string;
    source_aice_id: string;
  }>(
    `SELECT story_version, source_aice_id
       FROM story
      WHERE story_id = $1::bigint
      ORDER BY received_at DESC
      LIMIT 1`,
    [storyId],
  );
  if (storyRow.rows.length === 0) return null;
  const { story_version, source_aice_id } = storyRow.rows[0];

  const memberRows = await customerPool.query<StoryMemberRow>(
    `SELECT story_id::text          AS story_id,
            story_version,
            member_event_key::text  AS member_event_key,
            $2::text                AS source_aice_id,
            event,
            redaction_policy_version
       FROM story_member
      WHERE story_id = $1::bigint
        AND story_version = $3
      ORDER BY member_event_key`,
    [storyId, source_aice_id, story_version],
  );

  return {
    storyVersion: story_version,
    sourceAiceId: source_aice_id,
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

async function callAnalyzeStory(args: {
  membersJson: string;
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
      members: args.membersJson,
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
          input_event_refs, input_hash,
          redaction_policy_version, requested_by)
       VALUES ($1, $2::bigint, $3, $4, $5,
               $6, $7, $8,
               $9, $10,
               $11::jsonb, $12::jsonb, $13::jsonb,
               $14, $15,
               $16::jsonb, $17,
               $18, $19::uuid)`,
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
        args.inputHash,
        args.redactionPolicyVersion,
        args.requestedBy,
      ],
    );
    // Mark prior generation (if any) superseded. Excludes the row we
    // just inserted to keep the UPDATE deterministic.
    await client.query(
      `UPDATE story_analysis_result
          SET superseded_at = NOW()
        WHERE customer_id = $1 AND story_id = $2::bigint
          AND lang = $3 AND model_name = $4 AND model = $5
          AND generation < $6
          AND superseded_at IS NULL`,
      [
        args.job.customer_id,
        args.job.story_id,
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

async function finalizeJob(
  authPool: Pool,
  job: JobPickup,
  _detail: {
    priorityTier: PriorityTier;
    promptVersion: string | null;
    modelActualVersion: string | null;
  },
): Promise<void> {
  // Captured generation must still match. If a force-regenerate raced
  // ahead while the LLM call was in flight, the WHERE-clause matches
  // zero rows and the new queued generation runs on the next tick.
  await authPool.query(
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
}

async function failJob(
  authPool: Pool,
  job: JobPickup,
  reason: string,
): Promise<void> {
  await authPool.query(
    `UPDATE story_analysis_job
        SET status = 'failed',
            last_error = $7,
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
      reason,
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
    `UPDATE story_analysis_job
        SET status = 'queued',
            attempts = $7,
            last_error = $8,
            processing_started_at = NULL,
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
    `UPDATE story_analysis_job
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

/**
 * Seed a real (non-dry-run) job row for every `ready`/`dirty` state
 * row that lacks one for the default variant. Mirrors the Phase 0
 * seeding tick — without it, Phase 1's first deployment would have
 * the migration delete all dry-run rows but no `ready` row would ever
 * receive a real job until something hand-inserted it.
 */
export async function seedRealStoryJobs(
  authClient: PoolClient,
  batchSize: number,
  nowIso: string = getCurrentTimestamp().toISOString(),
): Promise<void> {
  const { rows: actionable } = await authClient.query<{
    customer_id: string;
    story_id: string;
    status: "ready" | "dirty";
  }>(
    `SELECT s.customer_id::text AS customer_id,
            s.story_id::text    AS story_id,
            s.status
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
    [batchSize, WORKER_LANG, WORKER_MODEL_NAME, WORKER_MODEL],
  );
  for (const row of actionable) {
    if (row.status === "dirty") {
      // Bump the existing job to a fresh queued generation, but only
      // if the current generation is below `ANALYSIS_MAX_GENERATION`.
      // RFC 0002 §"Force regenerate" calls this guardrail out
      // explicitly: dirty re-queue is capped to bound LLM spend on
      // noisy stories that keep re-entering `dirty`; force regenerate
      // (via the API endpoint) is intentionally exempt.
      //
      // We move the state row back to `ready` regardless — the
      // pipeline is "done" until the next dirty transition, and
      // leaving it stuck on `dirty` would make the seeding pass keep
      // re-selecting it forever.
      const bumped = await authClient.query<{ generation: number }>(
        `UPDATE story_analysis_job
            SET generation = generation + 1,
                status = 'queued',
                attempts = 0,
                last_error = NULL,
                processing_started_at = NULL,
                dry_run = FALSE,
                updated_at = $6::timestamptz
          WHERE customer_id = $1 AND story_id = $2::bigint
            AND lang = $3 AND model_name = $4 AND model = $5
            AND generation < $7
          RETURNING generation`,
        [
          row.customer_id,
          row.story_id,
          WORKER_LANG,
          WORKER_MODEL_NAME,
          WORKER_MODEL,
          nowIso,
          MAX_GENERATION,
        ],
      );
      if (bumped.rowCount === 0) {
        console.warn(
          JSON.stringify({
            level: "warn",
            event: "analysis.story_max_generation_reached",
            customer_id: row.customer_id,
            story_id: row.story_id,
            max_generation: MAX_GENERATION,
          }),
        );
      }
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
    await authClient.query(
      `INSERT INTO story_analysis_job
         (customer_id, story_id, lang, model_name, model,
          status, generation, dry_run, created_at, updated_at)
       VALUES ($1, $2::bigint, $3, $4, $5,
               'queued', 1, FALSE, $6::timestamptz, $6::timestamptz)
       ON CONFLICT (customer_id, story_id, lang, model_name, model)
       DO NOTHING`,
      [
        row.customer_id,
        row.story_id,
        WORKER_LANG,
        WORKER_MODEL_NAME,
        WORKER_MODEL,
        nowIso,
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
};
