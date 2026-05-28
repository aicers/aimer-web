// Server-side loader for the story analysis result page
// (`/[locale]/customers/{customerId}/analysis/story/{storyId}`).
//
// Mirrors `result-page-loader.ts` (event scope) but operates on the
// `story_analysis_result` table and resolves the customer's default
// `(lang, model_name, model)` variant. No event-scope token restore
// here — RFC 0002 §"Multi-event redaction tokens" keeps story-scope
// tokens intact in the rendered narrative (the UI tags them visually
// rather than substituting back to plaintext).

import "server-only";

import { authorize } from "@/lib/auth/authorization";
import { getAuthCookie } from "@/lib/auth/cookies";
import { verifyJwtFull } from "@/lib/auth/jwt";
import { getAuthPool, withTransaction } from "@/lib/db/client";
import { getCustomerRuntimePool } from "@/lib/db/customer-runtime-pool";
import { lookupTtpName } from "./mitre-ttp";
import type { PriorityTier } from "./priority-tier";

const DEFAULT_LANG = process.env.ANALYSIS_DEFAULT_LANG ?? "ENGLISH";
const DEFAULT_MODEL_NAME = process.env.ANALYSIS_DEFAULT_MODEL_NAME ?? "openai";
const DEFAULT_MODEL = process.env.ANALYSIS_DEFAULT_MODEL ?? "gpt-4o";

export type StoryResultPageOutcome =
  | { kind: "unauthorized" }
  | { kind: "not_found" }
  | { kind: "pending"; stateStatus: "pending" | "ready" | "dirty" }
  | { kind: "ok"; data: StoryResultPageData };

export interface StoryResultPageData {
  customerId: string;
  storyId: string;
  lang: "KOREAN" | "ENGLISH";
  modelName: string;
  model: string;
  modelActualVersion: string;
  promptVersion: string;
  generation: number;
  severityScore: number;
  likelihoodScore: number;
  priorityTier: PriorityTier;
  severityFactors: string[];
  likelihoodFactors: string[];
  ttpTags: Array<{ id: string; name: string | null }>;
  /** Token-form narrative; story-scope `<<REDACTED_*_E{i}_*>>` tokens
   * are preserved verbatim. */
  analysisText: string;
  requestedBy: string | null;
  requestedAt: Date;
}

export interface StoryResultPageInput {
  customerId: string;
  storyId: string;
}

export async function loadStoryResultPage(
  input: StoryResultPageInput,
): Promise<StoryResultPageOutcome> {
  const token = await getAuthCookie("general");
  if (!token) return { kind: "unauthorized" };
  let claims: Awaited<ReturnType<typeof verifyJwtFull>>;
  try {
    claims = await verifyJwtFull(token, "general");
  } catch {
    return { kind: "unauthorized" };
  }

  const authPool = getAuthPool();
  const auth = await withTransaction(authPool, (client) =>
    authorize(client, "general", claims.sub, "analyses:read", {
      customerId: input.customerId,
      operationKind: "read",
    }),
  );
  if (!auth.authorized) return { kind: "unauthorized" };

  // State row presence: if it doesn't exist, the story_id is unknown
  // for this customer. Surface as 404 indistinguishably from "exists
  // but archived" — operators see "removed by retention" rather than
  // a probe oracle.
  const stateRows = await authPool.query<{ status: string }>(
    `SELECT status FROM story_analysis_state
      WHERE customer_id = $1 AND story_id = $2::bigint`,
    [input.customerId, input.storyId],
  );
  if (stateRows.rows.length === 0) return { kind: "not_found" };
  if (stateRows.rows[0].status === "archived") return { kind: "not_found" };

  const customerPool = getCustomerRuntimePool(input.customerId);
  const resultRow = await customerPool.query<{
    severity_score: number;
    likelihood_score: number;
    priority_tier: PriorityTier;
    severity_factors: string[];
    likelihood_factors: string[];
    ttp_tags: string[];
    analysis_text: string;
    model_actual_version: string;
    prompt_version: string;
    generation: number;
    requested_by: string | null;
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
       generation,
       requested_by::text AS requested_by,
       requested_at
     FROM story_analysis_result
     WHERE customer_id = $1
       AND story_id = $2::bigint
       AND lang = $3 AND model_name = $4 AND model = $5
       AND superseded_at IS NULL
     ORDER BY generation DESC
     LIMIT 1`,
    [
      input.customerId,
      input.storyId,
      DEFAULT_LANG,
      DEFAULT_MODEL_NAME,
      DEFAULT_MODEL,
    ],
  );
  if (resultRow.rows.length === 0) {
    return {
      kind: "pending",
      stateStatus: stateRows.rows[0].status as "pending" | "ready" | "dirty",
    };
  }
  const row = resultRow.rows[0];

  return {
    kind: "ok",
    data: {
      customerId: input.customerId,
      storyId: input.storyId,
      lang: DEFAULT_LANG as "KOREAN" | "ENGLISH",
      modelName: DEFAULT_MODEL_NAME,
      model: DEFAULT_MODEL,
      modelActualVersion: row.model_actual_version,
      promptVersion: row.prompt_version,
      generation: row.generation,
      severityScore: row.severity_score,
      likelihoodScore: row.likelihood_score,
      priorityTier: row.priority_tier,
      severityFactors: row.severity_factors,
      likelihoodFactors: row.likelihood_factors,
      ttpTags: row.ttp_tags.map((id) => ({ id, name: lookupTtpName(id) })),
      analysisText: row.analysis_text,
      requestedBy: row.requested_by,
      requestedAt: row.requested_at,
    },
  };
}
