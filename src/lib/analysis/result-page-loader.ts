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

// Default variant the story detail page resolves when a backlink opens it
// without explicit variant params (mirrors `story-result-page-loader.ts`).
// The event→story backlink lookup is scoped to this variant so the
// generation it pins is one the story page can actually render.
const DEFAULT_LANG = process.env.ANALYSIS_DEFAULT_LANG ?? "ENGLISH";
const DEFAULT_MODEL_NAME = process.env.ANALYSIS_DEFAULT_MODEL_NAME ?? "openai";
const DEFAULT_MODEL = process.env.ANALYSIS_DEFAULT_MODEL ?? "gpt-4o";

export type ResultPageOutcome =
  | { kind: "unauthorized" }
  | { kind: "not_found" }
  // A specific generation was pinned (T1 Sources link) but the pinned row
  // is missing or superseded. The page shows the "evidence version no
  // longer available" notice and does NOT fall back to the latest
  // generation (parent #386 generation-pin contract).
  | { kind: "pin_unavailable"; generation: number }
  | { kind: "ok"; data: AnalysisResultPageData };

export interface AnalysisResultPageData {
  customerId: string;
  aiceId: string;
  eventKey: string;
  lang: "KOREAN" | "ENGLISH";
  modelName: string;
  model: string;
  /**
   * The resolved generation of the event leaf shown on the page (the
   * pinned generation, or the latest non-superseded one). The reverse
   * "Cited by" trail probes this so it only surfaces reports that cited
   * THIS generation, not other generations of the same event (T2 #396,
   * parent #386 exact-evidence contract).
   */
  generation: number;
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
  /**
   * The threat story / stories this event is a member of, for the
   * upward "part of story" backlink (T2 #396). Found by a reverse
   * containment lookup over `story_analysis_result.input_event_refs`,
   * scoped to the story page's default variant. An event usually belongs
   * to one story, but the lookup tolerates several (deduped by story,
   * newest-first). Empty when the event is not a member of any story.
   *
   * `generation` is the default-variant generation whose membership
   * actually contains this event; the backlink pins it (`?generation=`)
   * so the story page lands on the version that lists the event, not
   * whatever the latest generation happens to be (membership can change
   * across re-analysis generations — T2 #396 review round 1).
   */
  parentStories: Array<{
    storyId: string;
    generation: number;
    priorityTier: PriorityTier;
  }>;
}

export interface ResultPageInput {
  customerId: string;
  aiceId: string;
  eventKey: string;
  lang: string;
  modelName: string;
  model: string;
  /**
   * Optional generation pin (T1 Sources link, parent #386). When present,
   * the loader resolves the EXACT pinned row at `(lang, modelName, model,
   * generation)` instead of the latest non-superseded one, and reports
   * `pin_unavailable` when that row is missing or superseded (no silent
   * fallback to latest).
   */
  generation?: number;
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
  // When a generation is pinned, target that exact row and read
  // `superseded_at` so a superseded pin degrades to the notice rather than
  // silently resolving the latest generation; otherwise keep the
  // latest-non-superseded behavior.
  const pinnedGeneration = input.generation ?? null;
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
    generation: number;
    superseded_at: Date | null;
    requested_by: string;
    requested_at: Date;
  }>(
    pinnedGeneration === null
      ? `SELECT
           severity_score,
           likelihood_score,
           priority_tier,
           severity_factors,
           likelihood_factors,
           ttp_tags,
           analysis_text,
           model_actual_version,
           prompt_version,
           generation,
           superseded_at,
           requested_by,
           requested_at
         FROM event_analysis_result
         WHERE aice_id = $1
           AND event_key = $2::numeric
           AND lang = $3
           AND model_name = $4
           AND model = $5
           AND superseded_at IS NULL
         ORDER BY generation DESC
         LIMIT 1`
      : `SELECT
           severity_score,
           likelihood_score,
           priority_tier,
           severity_factors,
           likelihood_factors,
           ttp_tags,
           analysis_text,
           model_actual_version,
           prompt_version,
           generation,
           superseded_at,
           requested_by,
           requested_at
         FROM event_analysis_result
         WHERE aice_id = $1
           AND event_key = $2::numeric
           AND lang = $3
           AND model_name = $4
           AND model = $5
           AND generation = $6
         LIMIT 1`,
    pinnedGeneration === null
      ? [input.aiceId, input.eventKey, input.lang, input.modelName, input.model]
      : [
          input.aiceId,
          input.eventKey,
          input.lang,
          input.modelName,
          input.model,
          pinnedGeneration,
        ],
  );
  if (resultRow.rows.length === 0) {
    if (pinnedGeneration !== null) {
      return { kind: "pin_unavailable", generation: pinnedGeneration };
    }
    return { kind: "not_found" };
  }
  const row = resultRow.rows[0];
  // A superseded pinned row is treated as unavailable — the page must not
  // present stale evidence as the version the report cited.
  if (pinnedGeneration !== null && row.superseded_at !== null) {
    return { kind: "pin_unavailable", generation: pinnedGeneration };
  }

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

  // Upward backlink: the story / stories that include this event as a
  // member (T2 #396). Membership lives in `story_analysis_result.
  // input_event_refs` (camelCase `{index, aiceId, eventKey}`), so the
  // probe uses those keys. The lookup is scoped to the story page's
  // DEFAULT variant — the variant a bare backlink opens — so the kept
  // `generation` is one the story page can render, and `DISTINCT ON
  // (story_id) … generation DESC` keeps that variant's latest
  // membership-matching generation. Carrying the generation lets the
  // backlink pin it (`?generation=`): membership can change across
  // re-analysis generations, so linking to the latest generation blindly
  // could land on a version that no longer lists this event (review round
  // 1). Newest-first by the kept row's `requested_at`.
  const parentStoryRows = await customerPool.query<{
    story_id: string;
    generation: number;
    priority_tier: PriorityTier;
    requested_at: Date;
  }>(
    `SELECT DISTINCT ON (story_id)
            story_id::text AS story_id, generation, priority_tier, requested_at
       FROM story_analysis_result
      WHERE customer_id = $1
        AND lang = $3 AND model_name = $4 AND model = $5
        AND input_event_refs @> $2::jsonb
        AND superseded_at IS NULL
      ORDER BY story_id, generation DESC`,
    [
      input.customerId,
      JSON.stringify([{ aiceId: input.aiceId, eventKey: input.eventKey }]),
      DEFAULT_LANG,
      DEFAULT_MODEL_NAME,
      DEFAULT_MODEL,
    ],
  );
  const parentStories = [...parentStoryRows.rows]
    .sort((a, b) => b.requested_at.getTime() - a.requested_at.getTime())
    .map((r) => ({
      storyId: r.story_id,
      generation: r.generation,
      priorityTier: r.priority_tier,
    }));

  return {
    kind: "ok",
    data: {
      customerId: input.customerId,
      aiceId: input.aiceId,
      eventKey: input.eventKey,
      lang: input.lang as "KOREAN" | "ENGLISH",
      modelName: input.modelName,
      model: input.model,
      generation: row.generation,
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
      parentStories,
    },
  };
}
