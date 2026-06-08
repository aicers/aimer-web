// Baseline-sourced single-event analysis caller (#493).
//
// The auto-baseline analog of `regenerateEventLeaf` (`regenerate-event.ts`):
// a NEW caller of the payload-source-agnostic primitive
// `analyzeAndStoreEventResult`, not a rewrite of it. It sources the event
// from `baseline_event` (the auto-baseline path's storage) rather than
// `detection_events` (the manual path's), then feeds the existing primitive.
//
// Like the regenerate path it holds redaction CONSTANT — it sources the
// already-redacted `baseline_event.raw_event` and the row's stored
// `baseline_event.redaction_policy_version` (aimer never sees raw payload)
// and re-runs only the LLM analysis under the resolved default variant.
//
// Grain mapping (#493): `event_analysis_result` is keyed by `aice_id`, but
// `baseline_event` carries `source_aice_id`; the caller maps
// `aice_id := source_aice_id`. `baseline_event`'s PK is
// `(baseline_version, event_key)` and `event_key` recurs across baseline
// versions after a rebaseline, so the EXACT `baseline_version` ingested at
// enqueue is loaded (carried on `event_analysis_job`) for reproducibility.
//
// Actor / `requested_by` separation: the auto path has no human requester,
// so it writes `requested_by = NULL` (relaxed in `customer/0014`) while
// attributing the audit actor to the non-human worker account — no
// synthetic account id is smuggled in to satisfy the column.
//
// SERVER-ONLY. Reads the customer DB (`baseline_event`,
// `event_redaction_map`) and the auth DB (redaction ranges / owned
// domains), and calls aimer.

import "server-only";

import type { Pool, PoolClient } from "pg";
import {
  decryptRedactionMap,
  loadCustomerOwnedDomains,
  loadCustomerRanges,
  type RedactionMap,
} from "@/lib/redaction";
import type { AnalyzeErrorCode } from "./analyze-types";
import { isStoryMember } from "./event-enrichment-worker";
import { parseEventTime } from "./event-time";
import {
  analyzeAndStoreEventResult,
  type SupportedLang,
} from "./run-analyze-flow";

/**
 * Categorized outcome of a baseline-sourced analysis, mirroring
 * {@link RegenerateEventOutcome}.
 *
 *   - `analyzed`           — a fresh `generation+1` row was written.
 *   - `source_unavailable` — no `baseline_event` row survives for the exact
 *                            `(source_aice_id, event_key, baseline_version)`
 *                            (rebaselined away / retention swept); cannot
 *                            analyze.
 *   - `stale`              — the pre-store eligibility re-check (run inside the
 *                            storage transaction, under the event-variant lock,
 *                            immediately before supersede+insert) found the job
 *                            became ineligible DURING the LLM window: a story
 *                            member adopted the event or a live leaf appeared
 *                            after the worker's claim-time check. The store was
 *                            rolled back — no live row was superseded and no
 *                            `auto_baseline` row inserted. The worker cancels
 *                            the job terminally (same as the claim-time path).
 *   - `error`              — aimer call / storage / event_time failure.
 */
export type AnalyzeBaselineEventOutcome =
  | { kind: "analyzed"; generation: number }
  | { kind: "source_unavailable" }
  | { kind: "stale"; reason: string }
  | { kind: "error"; errorCode: AnalyzeErrorCode; message: string };

export interface AnalyzeBaselineEventParams {
  /** Auth pool — source of the customer's redaction ranges / owned domains. */
  authPool: Pool;
  /** Customer runtime pool — source of the stored baseline event + map. */
  customerPool: Pool;
  customerId: string;
  /** `baseline_event.source_aice_id`, mapped to `aice_id` for storage. */
  sourceAiceId: string;
  /** Decimal event key string (NUMERIC in storage). */
  eventKey: string;
  /** Exact version ingested at enqueue — pins the reproduced `raw_event`. */
  baselineVersion: string;
  /** Target variant language; written to the result PK and sent to aimer. */
  lang: SupportedLang;
  modelName: string;
  model: string;
  /**
   * Non-human worker account threaded into aimer's request context and the
   * audit actor. NEVER written to `requested_by` (that stays NULL).
   */
  workerAccountId: string;
  auditMeta?: { ipAddress: string | undefined; sid: string };
}

/**
 * Analyze a single loose baseline event, sourcing the redacted payload from
 * `baseline_event` storage (never raw payload). The caller (the
 * auto-analysis worker) is responsible for tier/budget gating and for the
 * dedup decision (skip when a non-superseded target-variant leaf already
 * exists); this helper always re-runs the LLM analysis.
 */
export async function analyzeBaselineEventLeaf(
  params: AnalyzeBaselineEventParams,
): Promise<AnalyzeBaselineEventOutcome> {
  const { authPool, customerPool, customerId, sourceAiceId, eventKey } = params;
  // `aice_id := source_aice_id` (grain mapping, #493).
  const aiceId = sourceAiceId;

  // 1. Source the EXACT stored redacted baseline event by
  //    `(source_aice_id, event_key, baseline_version)`. Its absence means
  //    the version was rebaselined away or retention swept it — the
  //    `source_unavailable` state. We cannot analyze without the stored
  //    redacted payload.
  const sourceRow = await customerPool.query<{
    raw_event: unknown;
    redaction_policy_version: string;
    event_time: Date;
  }>(
    `SELECT raw_event, redaction_policy_version, event_time
       FROM baseline_event
      WHERE source_aice_id = $1 AND event_key = $2::numeric
        AND baseline_version = $3`,
    [sourceAiceId, eventKey, params.baselineVersion],
  );
  if (sourceRow.rows.length === 0) {
    return { kind: "source_unavailable" };
  }
  const {
    raw_event: redactedEvent,
    redaction_policy_version,
    event_time,
  } = sourceRow.rows[0];

  // 2. Recover `event_time`, preferring the stored redacted payload's
  //    `event_time` (the cache-poisoning guard the manual path uses), and
  //    falling back to the authoritative `baseline_event.event_time` column.
  const eventTimeForAimer =
    (typeof redactedEvent === "object" && redactedEvent !== null
      ? parseEventTime((redactedEvent as Record<string, unknown>).event_time)
      : null) ?? event_time.toISOString();

  // 3. Load the redaction map for the hallucination scan over the LLM
  //    output. The event map is keyed `(aice_id, event_key)` with
  //    `aice_id = source_aice_id`. A decrypt failure is non-fatal: the scan
  //    runs against an empty map rather than failing the analysis, mirroring
  //    the regenerate path's degradation.
  let mergedMap: RedactionMap = {};
  const mapRow = await customerPool.query<{
    ciphertext: Buffer;
    wrapped_dek: string;
  }>(
    `SELECT ciphertext, wrapped_dek FROM event_redaction_map
      WHERE aice_id = $1 AND event_key = $2::numeric`,
    [aiceId, eventKey],
  );
  if (mapRow.rows.length > 0) {
    try {
      mergedMap = await decryptRedactionMap(
        customerId,
        mapRow.rows[0].ciphertext,
        mapRow.rows[0].wrapped_dek,
      );
    } catch {
      mergedMap = {};
    }
  }

  const ranges = await loadCustomerRanges(authPool, customerId);
  const ownedDomains = await loadCustomerOwnedDomains(authPool, customerId);

  const stored = await analyzeAndStoreEventResult({
    customerPool,
    aiceId,
    eventKey,
    redactedEvent,
    eventTimeForAimer,
    lang: params.lang,
    langForStorage: params.lang,
    modelName: params.modelName,
    model: params.model,
    // Worker account → aimer request context + audit actor only.
    accountId: params.workerAccountId,
    mergedMap,
    ranges,
    ownedDomains,
    // Hold redaction constant: stamp the STORED policy version.
    redactionPolicyVersion: redaction_policy_version,
    // Auto-baseline provenance + non-human requester.
    origin: "auto_baseline",
    requestedBy: null,
    auditBase: {
      actorId: params.workerAccountId,
      authContext: "general",
      targetType: "event_analysis_result",
      ipAddress: params.auditMeta?.ipAddress,
      sid: params.auditMeta?.sid ?? "",
      customerId,
      aiceId,
    },
    force: false,
    // Re-check eligibility a final time INSIDE the storage transaction, under
    // the event-variant lock, immediately before supersede+insert (#493 review
    // round 4). The worker's claim-time check runs BEFORE the (long) LLM call;
    // in that window a story batch can adopt the event or a manual /
    // default-variant leaf can be written. Without this last check the auto
    // path would supersede that leaf (changing the manual path's visible
    // result) or produce an `auto_baseline` leaf for a now-story-member event —
    // both violate the settled dedupe rule. Returning a reason rolls the store
    // back; the worker then cancels the job terminally.
    preStoreCheck: (client) => recheckEligibility(client, aiceId, params),
  });
  if (stored.kind === "skipped") {
    return { kind: "stale", reason: stored.reason };
  }
  if (stored.kind === "error") {
    return {
      kind: "error",
      errorCode: stored.errorCode,
      message: stored.message,
    };
  }
  return { kind: "analyzed", generation: stored.generation };
}

/**
 * Pre-store eligibility re-check for the auto-baseline path. Runs on the
 * storage transaction's own client (so its reads see committed state under the
 * event-variant advisory lock the transaction already holds). Returns a reason
 * string when the job is no longer eligible — to be analyzed by the worker —
 * or `null` to proceed:
 *
 *   - `story_member_appeared` — the event is now a member of some story
 *     (story members are enriched/analyzed at story scope, never here).
 *   - `live_leaf_appeared`    — a non-superseded `event_analysis_result` for
 *     the target `(aice_id, event_key, lang, model_name, model)` variant now
 *     exists (a manual / default-variant analysis landed); superseding it would
 *     change the manual path's visible result.
 *
 * For the live-leaf case the lock is load-bearing: a concurrent
 * `analyzeAndStoreEventResult` for the same variant blocks on the same lock, so
 * a committed leaf is always visible to this re-read.
 */
async function recheckEligibility(
  client: PoolClient,
  aiceId: string,
  params: AnalyzeBaselineEventParams,
): Promise<string | null> {
  if (await isStoryMember(client, params.sourceAiceId, params.eventKey)) {
    return "story_member_appeared";
  }
  const { rows } = await client.query<{ one: number }>(
    `SELECT 1 AS one
       FROM event_analysis_result
      WHERE aice_id = $1 AND event_key = $2::numeric
        AND lang = $3 AND model_name = $4 AND model = $5
        AND superseded_at IS NULL
      LIMIT 1`,
    [aiceId, params.eventKey, params.lang, params.modelName, params.model],
  );
  return rows.length > 0 ? "live_leaf_appeared" : null;
}
