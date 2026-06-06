// Server-side loader for the story analysis result page
// (`/[locale]/customers/{customerId}/analysis/story/{storyId}`).
//
// Mirrors `result-page-loader.ts` (event scope) but operates on the
// `story_analysis_result` table and resolves the customer's default
// `(lang, model_name, model)` variant. Story-scope
// `<<REDACTED_*_E{i}_*>>` tokens are restored to plaintext per RFC 0002
// §"Token namespacing for multi-event LLM inputs": parse `E{i}` →
// resolve to `(aice_id, event_key)` via `input_event_refs` → decrypt
// that event's `event_redaction_map` → substitute the original entity.

import "server-only";

import { authorize } from "@/lib/auth/authorization";
import { getAuthCookie } from "@/lib/auth/cookies";
import { verifyJwtFull } from "@/lib/auth/jwt";
import { getSessionPolicy } from "@/lib/auth/session-policy";
import { validateSession } from "@/lib/auth/session-validator";
import { getAuthPool, withTransaction } from "@/lib/db/client";
import { getCustomerRuntimePool } from "@/lib/db/customer-runtime-pool";
import { decryptRedactionMap, type RedactionMap } from "@/lib/redaction";
import { restoreStoryFactTokens } from "./fact-token";
import { lookupTtpName } from "./mitre-ttp";
import type { PriorityTier } from "./priority-tier";
import { restoreStoryAnalysisTokens } from "./story-token-restore";

const DEFAULT_LANG = process.env.ANALYSIS_DEFAULT_LANG ?? "ENGLISH";
const DEFAULT_MODEL_NAME = process.env.ANALYSIS_DEFAULT_MODEL_NAME ?? "openai";
const DEFAULT_MODEL = process.env.ANALYSIS_DEFAULT_MODEL ?? "gpt-4o";

export type StoryResultPageOutcome =
  | { kind: "unauthorized" }
  | { kind: "not_found" }
  | { kind: "pending"; stateStatus: "pending" | "ready" | "dirty" }
  // A specific generation/variant was pinned (T1 Sources link) but the
  // pinned row is missing or superseded. The page shows the "evidence
  // version no longer available" notice and does NOT fall back to the
  // latest generation (parent #386 generation-pin contract).
  | { kind: "pin_unavailable"; generation: number }
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
  /** Token-restored analysis text. Story-scope
   * `<<REDACTED_*_E{i}_*>>` tokens are resolved back to plaintext via
   * `input_event_refs` + each referenced event's redaction map. Tokens
   * that cannot be resolved (missing map row, decrypt failure,
   * out-of-range index) are passed through unchanged so the page still
   * renders. */
  analysisText: string;
  requestedBy: string | null;
  requestedAt: Date;
  /**
   * The story's member suspicious events, in `input_event_refs[].index`
   * order (the member ordinal — see `story-token.ts`, which persists
   * `index: ordinal`). Each carries display fields fetched from the
   * canonical event variant when available; `display` is `null` when no
   * canonical event row exists (e.g. swept by retention), in which case
   * the page still links to the event by id (T2 #396). Empty when the
   * story has no recorded members.
   */
  memberEvents: StoryMemberEvent[];
  /**
   * The canonical event variant the member display fields were fetched
   * at. The story page builds each member link with these so the event
   * detail page (which requires `model_name` / `model`) resolves the same
   * variant the cards describe.
   */
  memberEventVariant: { lang: string; modelName: string; model: string };
}

/**
 * A story's member suspicious event, surfaced on the story detail page so
 * a reader can drill down from the story into each cited event (T2 #396).
 * Display fields stay within the parent guardrails (tier + leaf-derived
 * scores, already exposed on the event detail page).
 */
export interface StoryMemberEvent {
  index: number;
  aiceId: string;
  eventKey: string;
  display: {
    priorityTier: PriorityTier;
    severityScore: number;
    likelihoodScore: number;
  } | null;
}

export interface StoryResultPageInput {
  customerId: string;
  storyId: string;
  /**
   * Optional generation/variant pin (T1 Sources link, parent #386). When
   * present, the loader resolves the EXACT pinned row — that generation at
   * `(lang, modelName, model)` — instead of the latest non-superseded one,
   * and reports `pin_unavailable` when that row is missing or superseded
   * (no silent fallback to latest). `lang`/`modelName`/`model` default to
   * the env-configured variant when omitted. `lang` is the report-language
   * enum (`ENGLISH`/`KOREAN`), matching the leaf's stored `lang` column.
   */
  pin?: {
    generation: number;
    lang?: string;
    modelName?: string;
    model?: string;
  };
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

  // Bridge scope: a bridge session must be restricted to the customers
  // listed on the session row, even though the page is read-only. The
  // summary / regenerate API routes apply the same scope via
  // `withAuth`; the server-rendered page reaches the loader without
  // `withAuth`, so the bridge fields have to be pulled from
  // `validateSession` explicitly. Without this gate, a bridge session
  // for customer A could deep-link into `/customers/B/...` if the
  // underlying account also has normal access to B.
  let bridgeAiceId: string | null = null;
  let bridgeCustomerIds: string[] | null = null;
  try {
    const policy = await getSessionPolicy();
    const session = await validateSession(authPool, claims.sid, policy.general);
    bridgeAiceId = session.bridgeAiceId;
    bridgeCustomerIds = session.bridgeCustomerIds;
  } catch {
    return { kind: "unauthorized" };
  }

  const auth = await withTransaction(authPool, (client) =>
    authorize(client, "general", claims.sub, "analyses:read", {
      customerId: input.customerId,
      operationKind: "read",
      bridgeScope: bridgeCustomerIds
        ? {
            aiceId: bridgeAiceId ?? "",
            customerIds: bridgeCustomerIds,
          }
        : null,
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

  // Variant resolution: a pin (T1 Sources link) selects the exact cited
  // variant; otherwise the env-configured default variant. `lang` is the
  // report-language enum the leaf row is keyed on.
  const lang = input.pin?.lang ?? DEFAULT_LANG;
  const modelName = input.pin?.modelName ?? DEFAULT_MODEL_NAME;
  const model = input.pin?.model ?? DEFAULT_MODEL;
  const pinnedGeneration = input.pin?.generation ?? null;

  const customerPool = getCustomerRuntimePool(input.customerId);
  // When a generation is pinned, target that exact row and read
  // `superseded_at` so a superseded pin degrades to the notice rather than
  // silently resolving the latest generation; otherwise keep the
  // latest-non-superseded behavior. `superseded_at` is irrelevant on the
  // unpinned path (the predicate already excludes superseded rows) and is
  // selected uniformly to keep one row shape.
  const resultRow = await customerPool.query<{
    severity_score: number;
    likelihood_score: number;
    priority_tier: PriorityTier;
    severity_factors: string[];
    likelihood_factors: string[];
    ttp_tags: string[];
    analysis_text: string;
    input_event_refs: Array<{
      index: number;
      aiceId: string;
      eventKey: string;
    }>;
    input_fact_refs: Array<{ index: number; factId: string }>;
    model_actual_version: string;
    prompt_version: string;
    generation: number;
    superseded_at: Date | null;
    requested_by: string | null;
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
           input_event_refs,
           input_fact_refs,
           model_actual_version,
           prompt_version,
           generation,
           superseded_at,
           requested_by::text AS requested_by,
           requested_at
         FROM story_analysis_result
         WHERE customer_id = $1
           AND story_id = $2::bigint
           AND lang = $3 AND model_name = $4 AND model = $5
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
           input_event_refs,
           input_fact_refs,
           model_actual_version,
           prompt_version,
           generation,
           superseded_at,
           requested_by::text AS requested_by,
           requested_at
         FROM story_analysis_result
         WHERE customer_id = $1
           AND story_id = $2::bigint
           AND lang = $3 AND model_name = $4 AND model = $5
           AND generation = $6
         LIMIT 1`,
    pinnedGeneration === null
      ? [input.customerId, input.storyId, lang, modelName, model]
      : [
          input.customerId,
          input.storyId,
          lang,
          modelName,
          model,
          pinnedGeneration,
        ],
  );
  if (resultRow.rows.length === 0) {
    // A pinned generation that no longer exists is "evidence no longer
    // available", not a still-generating pending state.
    if (pinnedGeneration !== null) {
      return { kind: "pin_unavailable", generation: pinnedGeneration };
    }
    return {
      kind: "pending",
      stateStatus: stateRows.rows[0].status as "pending" | "ready" | "dirty",
    };
  }
  const row = resultRow.rows[0];
  // A superseded pinned row is treated as unavailable — the page must not
  // present stale evidence as the version the report cited.
  if (pinnedGeneration !== null && row.superseded_at !== null) {
    return { kind: "pin_unavailable", generation: pinnedGeneration };
  }

  // Restore story-scope tokens to plaintext. RFC 0002 §"Token
  // namespacing for multi-event LLM inputs": each `E{i}` references an
  // entry in `input_event_refs` carrying `(aice_id, event_key)`, which
  // anchors that event's `event_redaction_map` row. We decrypt every
  // referenced map once and pass the keyed lookup to the restorer.
  // Page callers who reach this branch have already passed the
  // customer-scope authorize() above, so they are entitled to see
  // plaintext per the same rule that drives RFC 0001's
  // `restoreRedactedTokens` on the event result page.
  const refs = Array.isArray(row.input_event_refs) ? row.input_event_refs : [];
  const mapsByIndex = new Map<number, RedactionMap>();
  if (refs.length > 0) {
    const mapRows = await customerPool.query<{
      aice_id: string;
      event_key: string;
      ciphertext: Buffer;
      wrapped_dek: string;
    }>(
      `SELECT aice_id::text AS aice_id,
              event_key::text AS event_key,
              ciphertext, wrapped_dek
         FROM event_redaction_map
        WHERE (aice_id, event_key) IN (${refs
          .map((_, i) => `($${i * 2 + 1}::text, $${i * 2 + 2}::numeric)`)
          .join(", ")})`,
      refs.flatMap((r) => [r.aiceId, r.eventKey]),
    );
    const byKey = new Map<
      string,
      { ciphertext: Buffer; wrapped_dek: string }
    >();
    for (const r of mapRows.rows) {
      byKey.set(`${r.aice_id}:${r.event_key}`, {
        ciphertext: r.ciphertext,
        wrapped_dek: r.wrapped_dek,
      });
    }
    for (const ref of refs) {
      const found = byKey.get(`${ref.aiceId}:${ref.eventKey}`);
      if (!found) continue;
      try {
        const map = await decryptRedactionMap(
          input.customerId,
          found.ciphertext,
          found.wrapped_dek,
        );
        mapsByIndex.set(ref.index, map);
      } catch {
        // Map decryption failure (KEK rotation race / vault outage) —
        // skip this index; tokens for it fall through as-is rather
        // than failing the whole page render.
      }
    }
  }
  const eventRestoredText = restoreStoryAnalysisTokens(
    row.analysis_text,
    mapsByIndex,
  );

  // Restore fact-scope tokens to plaintext (RFC 0003 C1 #440). Parallel
  // two-hop to the `E{i}` path above: each `F{k}` references an entry in
  // `input_fact_refs` carrying the producing `fact_id`, which anchors that
  // fact's `enrichment_redaction_map` row. The same customer-scope
  // authorize() that entitles the viewer to event plaintext entitles them
  // to the fact's customer-asset plaintext (the fact was derived from this
  // customer's own story). Decrypt each referenced map once, keyed by `k`.
  const factRefs = Array.isArray(row.input_fact_refs)
    ? row.input_fact_refs
    : [];
  const factMapsByIndex = new Map<number, RedactionMap>();
  if (factRefs.length > 0) {
    const factMapRows = await customerPool.query<{
      fact_id: string;
      ciphertext: Buffer;
      wrapped_dek: string;
    }>(
      `SELECT fact_id::text AS fact_id, ciphertext, wrapped_dek
         FROM enrichment_redaction_map
        WHERE fact_id IN (${factRefs
          .map((_, i) => `$${i + 1}::bigint`)
          .join(", ")})`,
      factRefs.map((r) => r.factId),
    );
    const byFactId = new Map<
      string,
      { ciphertext: Buffer; wrapped_dek: string }
    >();
    for (const r of factMapRows.rows) {
      byFactId.set(r.fact_id, {
        ciphertext: r.ciphertext,
        wrapped_dek: r.wrapped_dek,
      });
    }
    for (const ref of factRefs) {
      const found = byFactId.get(ref.factId);
      if (!found) continue;
      try {
        const map = await decryptRedactionMap(
          input.customerId,
          found.ciphertext,
          found.wrapped_dek,
        );
        factMapsByIndex.set(ref.index, map);
      } catch {
        // Decrypt failure (KEK rotation race / vault outage) — skip this
        // index; its `F{k}` tokens fall through unchanged so the page
        // still renders.
      }
    }
  }
  const restoredText = restoreStoryFactTokens(
    eventRestoredText,
    factMapsByIndex,
  );

  // Score factors run through the SAME two-hop restore as the narrative
  // body (#440). A factor can legitimately carry an `E{i}` member token or
  // an `F{k}` fact token (the pre-storage leak scan rejects only UNMAPPED
  // tokens and decoded plaintext), so without this the authorized viewer
  // would see a raw `<<REDACTED_*_F1_001>>` in a factor while the narrative
  // shows the resolved customer-asset value. Resolve `E{i}` first, then
  // `F{k}`, identical to the narrative pipeline above.
  const restoreFactorTokens = (factor: string): string =>
    restoreStoryFactTokens(
      restoreStoryAnalysisTokens(factor, mapsByIndex),
      factMapsByIndex,
    );
  const severityFactors = row.severity_factors.map(restoreFactorTokens);
  const likelihoodFactors = row.likelihood_factors.map(restoreFactorTokens);

  // Member suspicious events for the story → member drill-down (T2 #396).
  // Fetched at the canonical event variant so the cards match the
  // Suspicious Events list; ordered by the member ordinal (`index`).
  const memberEvents = await fetchMemberEventDisplays(customerPool, refs);

  return {
    kind: "ok",
    data: {
      customerId: input.customerId,
      storyId: input.storyId,
      lang: lang as "KOREAN" | "ENGLISH",
      modelName,
      model,
      modelActualVersion: row.model_actual_version,
      promptVersion: row.prompt_version,
      generation: row.generation,
      severityScore: row.severity_score,
      likelihoodScore: row.likelihood_score,
      priorityTier: row.priority_tier,
      severityFactors,
      likelihoodFactors,
      ttpTags: row.ttp_tags.map((id) => ({ id, name: lookupTtpName(id) })),
      analysisText: restoredText,
      requestedBy: row.requested_by,
      requestedAt: row.requested_at,
      memberEvents,
      memberEventVariant: {
        lang: DEFAULT_LANG,
        modelName: DEFAULT_MODEL_NAME,
        model: DEFAULT_MODEL,
      },
    },
  };
}

/**
 * Fetch display fields for a story's member events at the canonical event
 * variant, returning them in member-ordinal (`index`) order. A member
 * with no canonical event row (swept by retention, or never analyzed at
 * this variant) maps to `display: null` so the page still links to it by
 * id (T2 #396). One batched SELECT covers all members; the
 * `DISTINCT ON (aice_id, event_key) … ORDER BY … generation DESC` picks
 * each event's latest non-superseded generation.
 */
async function fetchMemberEventDisplays(
  // biome-ignore lint/suspicious/noExplicitAny: pg Pool minimal surface
  customerPool: any,
  refs: ReadonlyArray<{ index: number; aiceId: string; eventKey: string }>,
): Promise<StoryMemberEvent[]> {
  const ordered = [...refs].sort((a, b) => a.index - b.index);
  if (ordered.length === 0) return [];

  const tuples = ordered
    .map((_, i) => `($${i * 2 + 1}::text, $${i * 2 + 2}::numeric)`)
    .join(", ");
  const params: unknown[] = ordered.flatMap((r) => [r.aiceId, r.eventKey]);
  const base = ordered.length * 2;
  params.push(DEFAULT_LANG, DEFAULT_MODEL_NAME, DEFAULT_MODEL);

  const { rows } = await customerPool.query(
    `SELECT DISTINCT ON (aice_id, event_key)
            aice_id, event_key::text AS event_key,
            priority_tier, severity_score, likelihood_score
       FROM event_analysis_result
      WHERE (aice_id, event_key) IN (${tuples})
        AND lang = $${base + 1}
        AND model_name = $${base + 2}
        AND model = $${base + 3}
        AND superseded_at IS NULL
      ORDER BY aice_id, event_key, generation DESC`,
    params,
  );
  const byKey = new Map<
    string,
    {
      priorityTier: PriorityTier;
      severityScore: number;
      likelihoodScore: number;
    }
  >();
  for (const r of rows as Array<{
    aice_id: string;
    event_key: string;
    priority_tier: PriorityTier;
    severity_score: number;
    likelihood_score: number;
  }>) {
    byKey.set(`${r.aice_id}:${r.event_key}`, {
      priorityTier: r.priority_tier,
      severityScore: r.severity_score,
      likelihoodScore: r.likelihood_score,
    });
  }
  return ordered.map((r) => ({
    index: r.index,
    aiceId: r.aiceId,
    eventKey: r.eventKey,
    display: byKey.get(`${r.aiceId}:${r.eventKey}`) ?? null,
  }));
}
