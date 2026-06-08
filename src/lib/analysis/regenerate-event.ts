// Shared single-event re-analysis (regenerate) service.
//
// #463 established the per-event regenerate path, but its logic — read
// `detection_events.redacted_event`, recover `event_time`, load the
// redaction map / ranges / owned domains, re-call aimer, write a fresh
// `generation+1` superseding the prior row — lived INLINE in the
// regenerate route. #470's event-leaf backfill re-runs that exact path in
// bulk, so the logic is extracted HERE and both the single-event endpoint
// and the bulk backfill worker call `regenerateEventLeaf` rather than
// re-implementing it.
//
// Like the #463 endpoint, this holds redaction CONSTANT: it sources the
// already-stored redacted event + its `redaction_policy_version` (aimer
// never sees raw payload) and re-runs only the LLM analysis under the
// requested `(lang, model_name, model)` variant. Re-ingesting a fresh raw
// event is aice-web-next's Force Rerun and is out of scope.
//
// SERVER-ONLY. Reads the customer DB (`detection_events`,
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
 * Categorized outcome of a single-event re-analysis. The bulk backfill
 * maps these 1:1 onto its per-item status categories
 * (`reanalyzed` / `source_unavailable` / `failed`); the single-event
 * endpoint maps them onto HTTP responses.
 *
 *   - `reanalyzed`         — a fresh `generation+1` row was written.
 *   - `source_unavailable` — no `detection_events` row survives (retention
 *                            swept the redacted source); cannot re-analyze.
 *   - `error`              — aimer call / storage / event_time failure.
 */
export type RegenerateEventOutcome =
  | { kind: "reanalyzed"; generation: number }
  | { kind: "source_unavailable" }
  | { kind: "error"; errorCode: AnalyzeErrorCode; message: string };

export interface RegenerateEventParams {
  /** Auth pool — source of the customer's redaction ranges / owned domains. */
  authPool: Pool;
  /** Customer runtime pool — source of the stored redacted event + map. */
  customerPool: Pool;
  customerId: string;
  aiceId: string;
  /** Decimal event key string (NUMERIC in storage). */
  eventKey: string;
  /** Target variant language; written to the result PK and sent to aimer. */
  lang: SupportedLang;
  modelName: string;
  model: string;
  /** Acting account (audit actor + `requested_by`). */
  accountId: string;
  auditMeta: { ipAddress: string | undefined; sid: string };
  /** Audit-only flag distinguishing a forced (re)generation. */
  force: boolean;
}

/**
 * Re-analyze a single event leaf under the target variant, sourcing the
 * event from storage (never the request / raw payload). Shared by the
 * #463 single-event endpoint and the #470 bulk backfill worker so the two
 * paths never diverge.
 *
 * The caller is responsible for authorization and for the idempotency
 * decision (skip when a non-superseded target-variant row already exists);
 * this helper always re-runs.
 */
export async function regenerateEventLeaf(
  params: RegenerateEventParams,
): Promise<RegenerateEventOutcome> {
  const { authPool, customerPool, customerId, aiceId, eventKey } = params;

  // 1. Source the stored redacted event. Its absence means retention swept
  //    the `detection_events` row while the analysis row survived — the
  //    `source_unavailable` state. We cannot re-analyze without the stored
  //    redacted payload (re-ingesting raw is aice-web-next's Force Rerun).
  const sourceRow = await customerPool.query<{
    redacted_event: unknown;
    redaction_policy_version: string;
  }>(
    `SELECT redacted_event, redaction_policy_version
       FROM detection_events
      WHERE aice_id = $1 AND event_key = $2::numeric`,
    [aiceId, eventKey],
  );
  if (sourceRow.rows.length === 0) {
    return { kind: "source_unavailable" };
  }
  const { redacted_event: redactedEvent, redaction_policy_version } =
    sourceRow.rows[0];

  // 2. Recover `event_time` from the stored redacted event (the same
  //    cache-poisoning guard the analyze flow uses).
  const eventTimeForAimer =
    typeof redactedEvent === "object" && redactedEvent !== null
      ? parseEventTime((redactedEvent as Record<string, unknown>).event_time)
      : null;
  if (eventTimeForAimer === null) {
    return {
      kind: "error",
      errorCode: "event_time_invalid",
      message: "stored redacted_event.event_time is missing or invalid",
    };
  }

  // 3. Load the redaction map for the hallucination scan over the LLM
  //    output. A decrypt failure (KEK rotation race / vault outage) is
  //    non-fatal: the scan runs against an empty map rather than failing
  //    the re-analysis, mirroring the read loader's degradation.
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
    // Regenerate the exact target variant: pass the concrete lang as both
    // the GraphQL variable and the storage PK component.
    lang: params.lang,
    langForStorage: params.lang,
    modelName: params.modelName,
    model: params.model,
    accountId: params.accountId,
    mergedMap,
    ranges,
    ownedDomains,
    // Hold redaction constant: stamp the STORED policy version rather than
    // recomputing under current policy (that is Force Rerun's job).
    redactionPolicyVersion: redaction_policy_version,
    // Manual (human-initiated) re-analysis: keep `origin='manual'` and
    // attribute `requested_by` to the acting account (#493).
    origin: "manual",
    requestedBy: params.accountId,
    auditBase: {
      actorId: params.accountId,
      authContext: "general",
      targetType: "event_analysis_result",
      ipAddress: params.auditMeta.ipAddress,
      sid: params.auditMeta.sid,
      customerId,
      aiceId,
    },
    force: params.force,
  });
  if (stored.kind === "error") {
    return {
      kind: "error",
      errorCode: stored.errorCode,
      message: stored.message,
    };
  }
  if (stored.kind === "skipped") {
    // Unreachable: the regenerate path passes no `preStoreCheck`, so the
    // primitive never aborts the store. Handled only to keep the union total.
    return {
      kind: "error",
      errorCode: "storage_failed",
      message: `store skipped: ${stored.reason}`,
    };
  }
  return { kind: "reanalyzed", generation: stored.generation };
}
