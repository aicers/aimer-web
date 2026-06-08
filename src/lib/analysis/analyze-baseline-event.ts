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

import type { Pool } from "pg";
import {
  decryptRedactionMap,
  loadCustomerOwnedDomains,
  loadCustomerRanges,
  type RedactionMap,
} from "@/lib/redaction";
import type { AnalyzeErrorCode } from "./analyze-types";
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
 *   - `error`              — aimer call / storage / event_time failure.
 */
export type AnalyzeBaselineEventOutcome =
  | { kind: "analyzed"; generation: number }
  | { kind: "source_unavailable" }
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
  });
  if (stored.kind === "error") {
    return {
      kind: "error",
      errorCode: stored.errorCode,
      message: stored.message,
    };
  }
  return { kind: "analyzed", generation: stored.generation };
}
