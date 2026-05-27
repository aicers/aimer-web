// Server-side data loader for the analysis result page
// (`/[locale]/customers/.../analysis`).
//
// The page is a server component that calls this loader once per
// request:
//   1. Authenticate the caller from the JWT cookie.
//   2. Authorize against the customer in the URL path
//      (operationKind: 'read').
//   3. Fetch the `event_analysis_result` row + the matching
//      `event_redaction_map` row from the customer DB.
//   4. Note whether the underlying `detection_events` row still
//      exists (cascade-edge state for the force re-run button).
//
// Returns a discriminated union so the page renders a typed result
// without ever throwing across the network boundary.

import "server-only";

import { authorize } from "@/lib/auth/authorization";
import { getAuthCookie } from "@/lib/auth/cookies";
import { verifyJwtFull } from "@/lib/auth/jwt";
import { getAuthPool, withTransaction } from "@/lib/db/client";
import { getCustomerRuntimePool } from "@/lib/db/customer-runtime-pool";
import { decryptRedactionMap, type RedactionMap } from "@/lib/redaction";
import { lookupTtpName } from "./mitre-ttp";
import type { PriorityTier } from "./priority-tier";
import { restoreRedactedTokens } from "./restore";

export type ResultPageOutcome =
  | { kind: "unauthorized" }
  | { kind: "not_found" }
  | { kind: "ok"; data: AnalysisResultPageData };

export interface AnalysisResultPageData {
  customerId: string;
  aiceId: string;
  eventKey: string;
  lang: "KOREAN" | "ENGLISH";
  modelName: string;
  model: string;
  modelActualVersion: string | null;
  promptVersion: string | null;
  severityScore: number;
  likelihoodScore: number;
  priorityTier: PriorityTier;
  /**
   * Short noun phrases articulating `severityScore` (RFC 0002 §"Score
   * factor articulation"). At least one item; the sentinel
   * `["insufficient evidence"]` indicates the LLM had thin input.
   */
  severityFactors: string[];
  /** Same shape as {@link severityFactors}, for `likelihoodScore`. */
  likelihoodFactors: string[];
  /**
   * Validated MITRE ATT&CK technique IDs paired with their resolved
   * technique names. `name` is `null` when the stored ID is absent from
   * the currently vendored MITRE bundle — possible for legacy / manually-
   * edited / corrupted rows; under the current write path every persisted
   * ID has already passed `validateTtpTags` against the same vendored set
   * the loader reads, so a `null` name is a defensive case rather than a
   * steady-state value. The UI falls back to the ID-only label when
   * `name === null`.
   */
  ttpTags: Array<{ id: string; name: string | null }>;
  /** Token-restored analysis text — safe to render as-is. */
  analysisText: string;
  requestedBy: string;
  requestedAt: Date;
  /**
   * Whether the source `detection_events` row still exists. When
   * `false`, retention has swept the source event but the analysis
   * row + map row survive (RFC 0001 §"Retention" cascade rule). The
   * page renders the "source event removed by retention; analysis
   * preserved" banner and hides the force re-run button.
   */
  sourceEventPresent: boolean;
}

export interface ResultPageInput {
  customerId: string;
  aiceId: string;
  eventKey: string;
  lang: string;
  modelName: string;
  model: string;
}

export async function loadAnalysisResultPage(
  input: ResultPageInput,
): Promise<ResultPageOutcome> {
  // ---- Authenticate -----------------------------------------------------
  const token = await getAuthCookie("general");
  if (!token) return { kind: "unauthorized" };
  let claims: Awaited<ReturnType<typeof verifyJwtFull>>;
  try {
    claims = await verifyJwtFull(token, "general");
  } catch {
    return { kind: "unauthorized" };
  }

  // ---- Authorize against the customer in the URL ------------------------
  // The route loader uses the path's `customer_id` directly per RFC 0001
  // §"UI — analysis result page". No reverse lookup, no fallback to
  // external_key on this path.
  const authPool = getAuthPool();
  const auth = await withTransaction(authPool, (client) =>
    authorize(client, "general", claims.sub, "analyses:read", {
      customerId: input.customerId,
      aiceId: input.aiceId,
      requiresAiceId: true,
      operationKind: "read",
    }),
  );
  if (!auth.authorized) return { kind: "unauthorized" };

  // ---- Fetch result + map + source-event presence -----------------------
  const customerPool = getCustomerRuntimePool(input.customerId);
  const resultRow = await customerPool.query<{
    severity_score: number;
    likelihood_score: number;
    priority_tier: PriorityTier;
    severity_factors: string[];
    likelihood_factors: string[];
    ttp_tags: string[];
    analysis_text: string;
    model_actual_version: string | null;
    prompt_version: string | null;
    requested_by: string;
    requested_at: Date;
  }>(
    `SELECT
       severity_score,
       likelihood_score,
       priority_tier,
       severity_factors,
       likelihood_factors,
       ttp_tags,
       analysis_text,
       model_actual_version,
       prompt_version,
       requested_by,
       requested_at
     FROM event_analysis_result
     WHERE aice_id = $1
       AND event_key = $2::numeric
       AND lang = $3
       AND model_name = $4
       AND model = $5`,
    [input.aiceId, input.eventKey, input.lang, input.modelName, input.model],
  );
  if (resultRow.rows.length === 0) return { kind: "not_found" };
  const row = resultRow.rows[0];

  // Always restore tokens — there is no "view redacted" mode.
  let restoredText = row.analysis_text;
  const mapRow = await customerPool.query<{
    ciphertext: Buffer;
    wrapped_dek: string;
  }>(
    `SELECT ciphertext, wrapped_dek FROM event_redaction_map
     WHERE aice_id = $1 AND event_key = $2::numeric`,
    [input.aiceId, input.eventKey],
  );
  if (mapRow.rows.length > 0) {
    let map: RedactionMap;
    try {
      map = await decryptRedactionMap(
        input.customerId,
        mapRow.rows[0].ciphertext,
        mapRow.rows[0].wrapped_dek,
      );
    } catch {
      // Map decryption failure is rare (KEK rotation race / vault
      // outage). Surfacing the token-form text is safer than a 500
      // — the page can still render the analysis with raw tokens
      // and the operator can retry.
      map = {};
    }
    restoredText = restoreRedactedTokens(row.analysis_text, map);
  }

  const sourcePresent = await customerPool.query<{ exists: boolean }>(
    `SELECT EXISTS (
       SELECT 1 FROM detection_events
       WHERE aice_id = $1 AND event_key = $2::numeric
     ) AS exists`,
    [input.aiceId, input.eventKey],
  );

  return {
    kind: "ok",
    data: {
      customerId: input.customerId,
      aiceId: input.aiceId,
      eventKey: input.eventKey,
      lang: input.lang as "KOREAN" | "ENGLISH",
      modelName: input.modelName,
      model: input.model,
      modelActualVersion: row.model_actual_version,
      promptVersion: row.prompt_version,
      severityScore: row.severity_score,
      likelihoodScore: row.likelihood_score,
      priorityTier: row.priority_tier,
      severityFactors: row.severity_factors,
      likelihoodFactors: row.likelihood_factors,
      ttpTags: row.ttp_tags.map((id) => ({ id, name: lookupTtpName(id) })),
      analysisText: restoredText,
      requestedBy: row.requested_by,
      requestedAt: row.requested_at,
      sourceEventPresent: sourcePresent.rows[0]?.exists === true,
    },
  };
}
