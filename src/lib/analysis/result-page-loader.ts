// Server-side data loader for the analysis result page
// (`/[locale]/subjects/.../analysis`).
//
// The page is a server component that calls this loader once per
// request:
//   1. Authenticate the caller from the JWT cookie.
//   2. Authorize against the customer in the URL path
//      (operationKind: 'read').
//   3. Fetch the `event_analysis_result` row + the matching
//      `event_redaction_map` row from the customer DB.
//   4. Note whether the underlying source row still exists (cascade-edge
//      state for the force re-run button). The source table depends on the
//      result's `origin`: a `manual` row probes `detection_events`, an
//      `auto_baseline` row probes `baseline_event` (#493).
//
// Returns a discriminated union so the page renders a typed result
// without ever throwing across the network boundary.

import "server-only";

import { authorize, isAnalystForCustomer } from "@/lib/auth/authorization";
import { getAuthCookie } from "@/lib/auth/cookies";
import { verifyJwtFull } from "@/lib/auth/jwt";
import { getSessionPolicy } from "@/lib/auth/session-policy";
import { validateSession } from "@/lib/auth/session-validator";
import { getAuthPool, withTransaction } from "@/lib/db/client";
import { getCustomerRuntimePool } from "@/lib/db/customer-runtime-pool";
import { decryptRedactionMap, type RedactionMap } from "@/lib/redaction";
import { resolveDefaultModel } from "./default-model";
import { lookupTtpName } from "./mitre-ttp";
import type { PriorityTier } from "./priority-tier";
import { restoreRedactedTokens } from "./restore";

// Default LANG the story detail page resolves when a backlink opens it
// without explicit variant params (mirrors `story-result-page-loader.ts`).
// The default MODEL is per-customer (#473) and resolved at request time via
// `resolveDefaultModel`, so only `lang` remains env-derived here. The
// event→story backlink lookup is scoped to that default variant so the
// generation it pins is one the story page can actually render.
const DEFAULT_LANG = process.env.ANALYSIS_DEFAULT_LANG ?? "ENGLISH";

/**
 * The event's identity for the `{event time} · {kind display name}` title
 * (#559), composed by `<EventTitle>`. `eventTime` is `null` only when there is
 * no row to read it from (a missing pinned row) — the title then degrades to
 * the static `Event` / `이벤트` fallback. Read off the result row regardless of
 * `superseded_at` since both are variant-independent (same rule as #552's
 * `CitedEventSource`). Carried as a nested object rather than sibling fields so
 * the event `kind` never collides with `ResultPageOutcome`'s `kind` discriminant.
 */
export interface EventTitleFields {
  eventTime: Date | null;
  kind: string | null;
}

export type ResultPageOutcome =
  | { kind: "unauthorized" }
  | { kind: "not_found" }
  // A specific generation was pinned (T1 Sources link) but the pinned row
  // is missing or superseded. The page shows the "evidence version no
  // longer available" notice and does NOT fall back to the latest
  // generation (parent #386 generation-pin contract). `eventTitle` keeps the
  // pinned subtitle meaningful in the superseded case (the row still exists);
  // it falls back to the static label when the row is missing entirely (#559).
  | {
      kind: "pin_unavailable";
      generation: number;
      eventTitle: EventTitleFields;
    }
  | { kind: "ok"; data: AnalysisResultPageData };

/**
 * One compare column's rendered data for the analyst-only side-by-side event
 * view (#464): the token-restored analysis text, scores, severity/likelihood
 * factors, TTP tags, priority tier, and the analyst-only provenance. Built by a
 * read-only EXACT lookup at the primary's language + the compare model — it
 * never enqueues work. An event analysis is self-contained (it re-uses the same
 * stored redacted event across models, #463), so unlike the report path there
 * is no leaf-coverage caveat to carry here.
 */
export interface EventCompareColumn {
  modelName: string;
  model: string;
  modelActualVersion: string;
  promptVersion: string;
  generation: number;
  lang: "KOREAN" | "ENGLISH";
  severityScore: number;
  likelihoodScore: number;
  priorityTier: PriorityTier;
  severityFactors: string[];
  likelihoodFactors: string[];
  ttpTags: Array<{ id: string; name: string | null }>;
  analysisText: string;
}

/**
 * Outcome of resolving the analyst-only compare column (#464). `not_generated`
 * means no stored `event_analysis_result` row exists for that
 * `(model_name, model)` at the primary's language — the page shows the
 * regenerate CTA rather than generating work.
 */
export type EventCompareOutcome =
  | { kind: "ok"; data: EventCompareColumn }
  | { kind: "not_generated"; modelName: string; model: string };

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
  modelActualVersion: string;
  promptVersion: string;
  /**
   * The event's time + kind for the page subtitle and breadcrumb title (#559),
   * read off the result row (variant-independent, same rule as #552). Composed
   * by `<EventTitle>`; `aice_id` stays separate provenance meta.
   */
  eventTitle: EventTitleFields;
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
  /**
   * How the result was produced (#493): `manual` is the synchronous
   * analyst-requested path; `auto_baseline` is the baseline-event
   * auto-analysis worker. Auto rows have a `NULL` `requestedBy` (no human
   * requester) and their source row lives in `baseline_event`, not
   * `detection_events` — both render branches key off this.
   */
  origin: "manual" | "auto_baseline";
  /**
   * The human who requested the analysis. `null` for an `auto_baseline`
   * row, which has no human requester (the worker is attributed via the
   * audit actor instead). The page renders the localized "system" label
   * in that case, mirroring the story/report pages.
   */
  requestedBy: string | null;
  requestedAt: Date;
  /**
   * Whether the viewer is an analyst for this customer (#457/#463). Gates
   * the model/prompt provenance fields on the event detail page; a
   * non-analyst viewer keeps everything that carries analytical meaning
   * (tier, TTP, language, scores, factors, narrative).
   */
  isViewerAnalyst: boolean;
  /**
   * Whether the viewer may regenerate this event = `isViewerAnalyst` AND
   * not a bridge session (#463). The event read loader allows bridge
   * sessions, but the in-app regenerate endpoint authorizes
   * `operationKind: "write"`, which a bridge session can never pass — so
   * the button gates on this rather than `isViewerAnalyst` alone, matching
   * the endpoint's write authorization (mirrors the story page).
   */
  canRegenerate: boolean;
  /**
   * Whether the source row still exists. The source table depends on
   * `origin`: a `manual` row probes `detection_events`; an
   * `auto_baseline` row probes `baseline_event` (an auto row has no
   * `detection_events` row by design, so probing that table would falsely
   * report a retention sweep even while the baseline event survives). When
   * `false`, retention has swept the source event but the analysis row +
   * map row survive (RFC 0001 §"Retention" cascade rule). The page renders
   * the "source event removed by retention; analysis preserved" banner and
   * hides the force re-run button.
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
  /**
   * Analyst-only side-by-side compare column (#464), present only when a
   * compare variant was requested (`?compareModelName=&compareModel=`) AND the
   * viewer is an analyst. Resolved by a read-only EXACT lookup at the primary's
   * language + the compare model — it never enqueues a job, so a
   * not-yet-generated compare variant returns `not_generated` (the page shows
   * the regenerate CTA).
   */
  compare?: EventCompareOutcome;
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
  /**
   * Analyst-only compare variant (#464). The second column's model pair; the
   * loader resolves it via a read-only EXACT, unpinned model-only lookup at the
   * primary's language (latest non-superseded row for that
   * `(lang, model_name, model)`) — NOT a generation-keyed pin. Only honored for
   * an analyst viewer; a non-analyst's crafted `?compareModel` is ignored.
   */
  compare?: {
    modelName: string;
    model: string;
  };
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

  // Bridge scope: a bridge session must be restricted to the customers
  // listed on the session row, even though the page is read-only. The
  // API routes apply the same scope via `withAuth`; the server-rendered
  // page reaches the loader without `withAuth`, so the bridge fields have
  // to be pulled from `validateSession` explicitly. Without this gate, a
  // bridge session for customer A could deep-link into `/subjects/B/...`
  // if the underlying account also has normal access to B. This brings the
  // event loader up to the story/report loaders' bridge handling (#463).
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

  // Resolve authorization AND the analyst-assignment signal in one
  // transaction so the analyst predicate reuses the already-acquired
  // connection (#457): no extra checkout, no extra auth handshake. The
  // flag is only meaningful when authorized, so it is computed only then.
  const isBridgeSession = bridgeCustomerIds !== null;
  const { auth, isViewerAnalyst } = await withTransaction(
    authPool,
    async (client) => {
      const auth = await authorize(
        client,
        "general",
        claims.sub,
        "analyses:read",
        {
          customerId: input.customerId,
          aiceId: input.aiceId,
          requiresAiceId: true,
          operationKind: "read",
          bridgeScope: bridgeCustomerIds
            ? { aiceId: bridgeAiceId ?? "", customerIds: bridgeCustomerIds }
            : null,
        },
      );
      const isViewerAnalyst = auth.authorized
        ? await isAnalystForCustomer(client, claims.sub, input.customerId)
        : false;
      return { auth, isViewerAnalyst };
    },
  );
  if (!auth.authorized) return { kind: "unauthorized" };

  // The default MODEL for the parent-story backlink is per-customer (#473).
  const defaultPair = await resolveDefaultModel(input.customerId, authPool);

  // The event read loader allows bridge sessions, but the in-app regenerate
  // endpoint authorizes with `operationKind: "write"`, which a bridge
  // session can never pass (`bridge_write_blocked`). Gate the button on a
  // dedicated signal that excludes bridge sessions even for an analyst
  // account (#463) — otherwise a bridge-session analyst would see a button
  // whose click 403s.
  const canRegenerate = isViewerAnalyst && !isBridgeSession;

  // ---- Fetch result + map + source-event presence -----------------------
  const customerPool = getCustomerRuntimePool(input.customerId);
  // When a generation is pinned, target that exact row and read
  // `superseded_at` so a superseded pin degrades to the notice rather than
  // silently resolving the latest generation; otherwise keep the
  // latest-non-superseded behavior.
  const pinnedGeneration = input.generation ?? null;
  const resultRow = await customerPool.query<{
    lang: "KOREAN" | "ENGLISH";
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
    superseded_at: Date | null;
    requested_by: string | null;
    requested_at: Date;
    origin: "manual" | "auto_baseline";
    // Event identity for the subtitle / breadcrumb title (#559). `event_time`
    // is `NOT NULL` on the column; `kind` is nullable.
    event_time: Date;
    kind: string | null;
  }>(
    // Non-pinned read resolves the viewer-language variant with a
    // requested -> English -> any fallback (#581): order so the requested
    // language wins, then the English canonical, then whatever exists, taking
    // the latest non-superseded generation. A generation pin is variant-exact
    // (a report citation pins a precise `(lang, generation)`) — no fallback.
    pinnedGeneration === null
      ? `SELECT
           lang,
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
           requested_at,
           origin,
           event_time,
           kind
         FROM event_analysis_result
         WHERE aice_id = $1
           AND event_key = $2::numeric
           AND model_name = $4
           AND model = $5
           AND superseded_at IS NULL
         ORDER BY (lang = $3) DESC, (lang = 'ENGLISH') DESC, generation DESC
         LIMIT 1`
      : `SELECT
           lang,
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
           requested_at,
           origin,
           event_time,
           kind
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
      // No row at the pinned variant — there is nothing to read the event
      // time / kind from, so the pinned subtitle degrades to the static label.
      return {
        kind: "pin_unavailable",
        generation: pinnedGeneration,
        eventTitle: { eventTime: null, kind: null },
      };
    }
    return { kind: "not_found" };
  }
  const row = resultRow.rows[0];
  // A superseded pinned row is treated as unavailable — the page must not
  // present stale evidence as the version the report cited. The event time /
  // kind are variant-independent, so read them off the superseded row to keep
  // the pinned subtitle's title meaningful (#559).
  if (pinnedGeneration !== null && row.superseded_at !== null) {
    return {
      kind: "pin_unavailable",
      generation: pinnedGeneration,
      eventTitle: { eventTime: row.event_time, kind: row.kind },
    };
  }

  // Always restore tokens — there is no "view redacted" mode. The decrypted
  // map is hoisted so the analyst-only compare column (#464) can reuse it: an
  // event's `event_redaction_map` is keyed on `(aice_id, event_key)` only, so
  // every model variant of the same event shares one map — no second decrypt.
  let restoredText = row.analysis_text;
  let redactionMap: RedactionMap = {};
  const mapRow = await customerPool.query<{
    ciphertext: Buffer;
    wrapped_dek: string;
  }>(
    `SELECT ciphertext, wrapped_dek FROM event_redaction_map
     WHERE aice_id = $1 AND event_key = $2::numeric`,
    [input.aiceId, input.eventKey],
  );
  if (mapRow.rows.length > 0) {
    try {
      redactionMap = await decryptRedactionMap(
        input.customerId,
        mapRow.rows[0].ciphertext,
        mapRow.rows[0].wrapped_dek,
      );
    } catch {
      // Map decryption failure is rare (KEK rotation race / vault
      // outage). Surfacing the token-form text is safer than a 500
      // — the page can still render the analysis with raw tokens
      // and the operator can retry.
      redactionMap = {};
    }
    restoredText = restoreRedactedTokens(row.analysis_text, redactionMap);
  }

  // Source-presence probe. The source table depends on how the result was
  // produced: a manual row's source lives in `detection_events`; an
  // auto-baseline row's source lives in `baseline_event` (keyed by
  // `source_aice_id`, which the seeder maps to `aice_id`). An auto row never
  // has a `detection_events` row, so probing that table unconditionally would
  // falsely raise the retention banner on a freshly auto-analyzed event whose
  // baseline source still exists (#493).
  const sourcePresent = await customerPool.query<{ exists: boolean }>(
    row.origin === "auto_baseline"
      ? `SELECT EXISTS (
           SELECT 1 FROM baseline_event
           WHERE source_aice_id = $1 AND event_key = $2::numeric
         ) AS exists`
      : `SELECT EXISTS (
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
      defaultPair.modelName,
      defaultPair.model,
    ],
  );
  const parentStories = [...parentStoryRows.rows]
    .sort((a, b) => b.requested_at.getTime() - a.requested_at.getTime())
    .map((r) => ({
      storyId: r.story_id,
      generation: r.generation,
      priorityTier: r.priority_tier,
    }));

  // Analyst-only compare column (#464): a read-only EXACT, unpinned model-only
  // lookup of the compare model at the primary's language. Gated on the analyst
  // flag so a non-analyst's crafted `?compareModel` never resolves analyst-only
  // data. The lookup re-uses the already-decrypted redaction map (same event →
  // same map) and is side-effect-free — it never enqueues a job, so a
  // not-yet-generated variant returns `not_generated` (the page shows the CTA).
  let compare: EventCompareOutcome | undefined;
  if (input.compare && isViewerAnalyst) {
    compare = await resolveEventCompareColumn(
      customerPool,
      {
        aiceId: input.aiceId,
        eventKey: input.eventKey,
        // Compare at the language actually resolved for the primary column.
        lang: row.lang,
        modelName: input.compare.modelName,
        model: input.compare.model,
      },
      redactionMap,
    );
  }

  return {
    kind: "ok",
    data: {
      customerId: input.customerId,
      aiceId: input.aiceId,
      eventKey: input.eventKey,
      // The language actually resolved (requested -> English -> any), so the
      // page chrome / switcher reflect what is displayed (#581).
      lang: row.lang,
      modelName: input.modelName,
      model: input.model,
      generation: row.generation,
      modelActualVersion: row.model_actual_version,
      promptVersion: row.prompt_version,
      eventTitle: { eventTime: row.event_time, kind: row.kind },
      severityScore: row.severity_score,
      likelihoodScore: row.likelihood_score,
      priorityTier: row.priority_tier,
      severityFactors: row.severity_factors,
      likelihoodFactors: row.likelihood_factors,
      ttpTags: row.ttp_tags.map((id) => ({ id, name: lookupTtpName(id) })),
      analysisText: restoredText,
      origin: row.origin,
      requestedBy: row.requested_by,
      requestedAt: row.requested_at,
      isViewerAnalyst,
      canRegenerate,
      sourceEventPresent: sourcePresent.rows[0]?.exists === true,
      parentStories,
      compare,
    },
  };
}

/**
 * Read-only EXACT, unpinned model-only lookup of a compare model variant at the
 * primary's language (#464). Resolves the latest non-superseded
 * `event_analysis_result` row for `(aice_id, event_key, lang, model_name,
 * model)`, restores its analysis text against the event's already-decrypted
 * redaction map, and returns `not_generated` when no stored row exists.
 * Side-effect-free — it never enqueues a job. Factors / TTP tags / scores are
 * forwarded as-is, mirroring the primary event column's render shape.
 */
async function resolveEventCompareColumn(
  // biome-ignore lint/suspicious/noExplicitAny: pg Pool minimal surface
  customerPool: any,
  params: {
    aiceId: string;
    eventKey: string;
    lang: string;
    modelName: string;
    model: string;
  },
  redactionMap: RedactionMap,
): Promise<EventCompareOutcome> {
  const { aiceId, eventKey, lang, modelName, model } = params;
  const resultRow = await customerPool.query(
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
       generation
     FROM event_analysis_result
     WHERE aice_id = $1
       AND event_key = $2::numeric
       AND lang = $3
       AND model_name = $4
       AND model = $5
       AND superseded_at IS NULL
     ORDER BY generation DESC
     LIMIT 1`,
    [aiceId, eventKey, lang, modelName, model],
  );
  if (resultRow.rows.length === 0) {
    return { kind: "not_generated", modelName, model };
  }
  const row = resultRow.rows[0] as {
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
  };
  return {
    kind: "ok",
    data: {
      modelName,
      model,
      modelActualVersion: row.model_actual_version,
      promptVersion: row.prompt_version,
      generation: row.generation,
      lang: lang as "KOREAN" | "ENGLISH",
      severityScore: row.severity_score,
      likelihoodScore: row.likelihood_score,
      priorityTier: row.priority_tier,
      severityFactors: row.severity_factors,
      likelihoodFactors: row.likelihood_factors,
      ttpTags: row.ttp_tags.map((id) => ({ id, name: lookupTtpName(id) })),
      analysisText: restoreRedactedTokens(row.analysis_text, redactionMap),
    },
  };
}
