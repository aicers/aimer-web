// Server-side loader for the story analysis result page
// (`/[locale]/subjects/{customerId}/analysis/story/{storyId}`).
//
// Mirrors `result-page-loader.ts` (event scope) but operates on the
// `story_analysis_result` table and resolves the customer's default
// `(lang, model_name, model)` variant. Story-scope
// `<<REDACTED_*_E{i}_*>>` tokens are restored to plaintext per RFC 0002
// §"Token namespacing for multi-event LLM inputs": parse `E{i}` →
// resolve to `(aice_id, event_key)` via `input_event_refs` → decrypt
// that event's `event_redaction_map` → substitute the original entity.

import "server-only";

import {
  type AppLocale,
  appLocaleToReportLanguage,
  isSupportedLocale,
  reportLanguageToAppLocale,
} from "@/i18n/locale";
import { authorize, isAnalystForCustomer } from "@/lib/auth/authorization";
import { getAuthCookie } from "@/lib/auth/cookies";
import { verifyJwtFull } from "@/lib/auth/jwt";
import { getSessionPolicy } from "@/lib/auth/session-policy";
import { validateSession } from "@/lib/auth/session-validator";
import { getAuthPool, withTransaction } from "@/lib/db/client";
import { getCustomerRuntimePool } from "@/lib/db/customer-runtime-pool";
import { decryptRedactionMap, type RedactionMap } from "@/lib/redaction";
import { type ModelPair, resolveDefaultModel } from "./default-model";
import { restoreStoryFactTokens } from "./fact-token";
import { lookupTtpName } from "./mitre-ttp";
import type { PriorityTier } from "./priority-tier";
import { restoreStoryAnalysisTokens } from "./story-token-restore";

// English is the guaranteed baseline language (#580): the worker always seeds
// and natively generates it, so it is the second link in the reader's fallback
// chain (requested → English → any available). This is NOT `ANALYSIS_DEFAULT_LANG`
// — the displayed language is driven by the viewer's locale, mirroring the
// periodic-report reader.
const ENGLISH_BASELINE = "ENGLISH";

/**
 * RFC 0003 §"Audit / evidence model" IOC-enrichment coverage status,
 * persisted on `story_enrichment_state.coverage_status` for the canonical
 * `(story_id, story_version)`. `complete` = the floor was evaluated on full
 * Tier-1 coverage (a `known_ioc_hit = false` is a genuine clean miss);
 * `unknown`/`stale`/`partial` = a source was down / feed stale / coverage
 * partial, so a `false` reflects incomplete coverage rather than a confirmed
 * miss. `null` when no enrichment-state row exists yet for the canonical
 * version (enrichment has not completed). The loader surfaces this so an
 * operator can distinguish false-complete from false-unknown; it never feeds
 * the floor (the floor reads only the boolean, in the worker).
 */
export type CoverageStatus = "complete" | "partial" | "unknown" | "stale";

/**
 * One compare column's rendered data for the side-by-side story view (#458):
 * the token-restored analysis text, scores, severity/likelihood factors, and
 * the analyst-only provenance. Built by a read-only EXACT lookup at the
 * primary's language + the compare model — it never enqueues work.
 */
export interface StoryCompareColumn {
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
 * Outcome of resolving the analyst-only compare column (#458). `not_generated`
 * means no stored row exists for that `(model_name, model)` at the primary's
 * language — the page shows the regenerate CTA rather than generating work.
 */
export type StoryCompareOutcome =
  | { kind: "ok"; data: StoryCompareColumn }
  | { kind: "not_generated"; modelName: string; model: string };

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
  /**
   * IOC-enrichment coverage status for the story's *current canonical*
   * `(story_id, story_version)` (RFC 0003 #498). Surfaces the transparency
   * half of the evidence model so a `known_ioc_hit = false` decided under
   * incomplete Tier-1 coverage (`unknown`/`stale`/`partial`) is
   * distinguishable from a fully-checked clean miss (`complete`). `null`
   * when no `story_enrichment_state` row exists for the canonical version.
   * Purely additive — orthogonal to `priorityTier`, never feeds the floor.
   * Because `story_analysis_result` carries no `story_version`, in a dirty
   * state this reflects the latest canonical coverage, which may differ from
   * the version the displayed result was analysed on (issue #498 scope).
   */
  coverageStatus: CoverageStatus | null;
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
   * Whether the viewer is an analyst for this customer (#457). Gates the
   * model/prompt provenance fields on the detail page; a non-analyst viewer
   * keeps everything that carries analytical meaning (tier, TTP, language,
   * scores, factors, narrative).
   */
  isViewerAnalyst: boolean;
  /**
   * Whether the viewer may regenerate this story = `isViewerAnalyst` AND not
   * a bridge session (#457). The story read loader allows bridge sessions,
   * but the regenerate endpoint authorizes `operationKind: "write"`, which a
   * bridge session can never pass — so the button gates on this rather than
   * `isViewerAnalyst` alone, matching the endpoint's write authorization.
   */
  canRegenerate: boolean;
  /**
   * The language the viewer asked for (their locale, or a pinned `?lang`), as
   * an app-locale code. Equals `reportLanguageToAppLocale(data.lang)` when the
   * requested variant exists; differs when a fallback occurred (#580).
   */
  requestedLocale: AppLocale;
  /**
   * Languages with a stored, non-superseded result for this
   * `(model_name, model)` variant, as app-locale codes, for the language
   * switcher. Always includes the shown language (#580).
   */
  availableLocales: AppLocale[];
  /**
   * Present only when the shown story fell back from the requested language
   * (the requested variant has no stored row). Describes the fallback for the
   * notice. Unlike the report reader there is no on-demand job — every story is
   * seeded eagerly in both languages, so a fallback is transient (the
   * user-language row is still translating) (#580).
   */
  languageFallback: {
    requestedLocale: AppLocale;
    shownLocale: AppLocale;
  } | null;
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
  /**
   * Analyst-only side-by-side compare column (#458), present only when a
   * compare variant was requested (`?compareModelName=&compareModel=`) AND the
   * viewer is an analyst. Resolved by a read-only EXACT lookup at the primary's
   * language + the compare model — it never enqueues a job, so a
   * not-yet-generated compare variant returns `not_generated` (the page shows
   * the regenerate CTA).
   */
  compare?: StoryCompareOutcome;
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
  /**
   * The event's time + kind for the member row title `{event time} · {kind
   * display name}` (#559), read off the canonical `event_analysis_result` row.
   * Top-level (not inside `display`) so they survive a `display: null` member —
   * though both come from the same row, so a member with no canonical row keeps
   * `eventTime`/`kind` null and the title degrades to the static fallback while
   * `aiceId` (from `input_event_refs`) still shows on the meta line.
   */
  eventTime: Date | null;
  kind: string | null;
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
   * The viewer's resolved app locale (the page's `[locale]` route param). This
   * is the DEFAULT displayed story language when `?lang` is not pinned —
   * converted to the aimer enum via the canonical locale↔language mapper, NOT
   * `ANALYSIS_DEFAULT_LANG` (#580, mirroring the periodic-report reader).
   */
  locale: string;
  /**
   * Optional generation/variant pin (T1 Sources link, parent #386). When
   * present, the loader resolves the EXACT pinned row — that generation at
   * `(lang, modelName, model)` — instead of the latest non-superseded one,
   * and reports `pin_unavailable` when that row is missing or superseded
   * (no silent fallback to latest). `modelName`/`model` default to the
   * customer's effective default when omitted. `lang` is an app-locale code
   * (`en` / `ko`), validated and mapped to the aimer enum; an enum-shaped value
   * is not a valid reader param and falls through to the viewer locale (#580).
   */
  pin?: {
    generation: number;
    lang?: string;
    modelName?: string;
    model?: string;
  };
  /**
   * Unpinned primary variant selected by model (#458): the latest
   * non-superseded row for `(lang, modelName, model)`. Unlike `pin` this
   * carries NO generation, so a `?model_name=&model=` link (no `?generation`)
   * opens that model as the primary column rather than silently resolving the
   * env default — the report loader already supports this via
   * `variant.{model_name, model}`. Ignored when `pin` is present (a generation
   * pin already carries its own `lang`/`modelName`/`model`). Fields default to
   * the env-configured variant when omitted.
   */
  variant?: {
    /** App-locale code (`en` / `ko`), validated and mapped to the aimer enum. */
    lang?: string;
    modelName?: string;
    model?: string;
  };
  /**
   * Analyst-only compare variant (#458). The second column's model pair; the
   * loader resolves it via a read-only EXACT unpinned model-only lookup at the
   * primary's language (latest non-superseded row for that
   * `(lang, model_name, model)`) — NOT a generation-keyed pin. Only honored
   * for an analyst viewer; a non-analyst's crafted `?compareModel` is ignored.
   */
  compare?: {
    modelName: string;
    model: string;
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
  // for customer A could deep-link into `/subjects/B/...` if the
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
          operationKind: "read",
          bridgeScope: bridgeCustomerIds
            ? {
                aiceId: bridgeAiceId ?? "",
                customerIds: bridgeCustomerIds,
              }
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

  // The default MODEL is per-customer (#473): resolve the customer's
  // effective default (override → global → env) once and use it wherever
  // the "default variant" was previously the env pair. The displayed language
  // is resolved from the viewer locale below (#580), not from the env.
  const defaultPair = await resolveDefaultModel(input.customerId, authPool);

  // The story read loader allows bridge sessions, but the story regenerate
  // endpoint authorizes with `operationKind: "write"`, which a bridge
  // session can never pass (`bridge_write_blocked`). So gate the button on
  // a dedicated signal that excludes bridge sessions even for an analyst
  // account (#457) — otherwise a bridge-session analyst would see a button
  // whose click 403s.
  const canRegenerate = isViewerAnalyst && !isBridgeSession;

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

  // Model resolution: a pin / unpinned `variant` selects a model; otherwise the
  // customer's effective default. `pin` wins over `variant`.
  const modelName =
    input.pin?.modelName ?? input.variant?.modelName ?? defaultPair.modelName;
  const model = input.pin?.model ?? input.variant?.model ?? defaultPair.model;
  const pinnedGeneration = input.pin?.generation ?? null;

  // Language resolution (#580, mirroring the report reader): the requested
  // language is the pinned `?lang` (validated to a real app locale) → else the
  // viewer's locale (validated) → else the English baseline. The pinned value
  // MUST be validated to `{en, ko}` BEFORE mapping: an enum-shaped
  // `?lang=KOREAN` is not a supported locale, so it falls through to the viewer
  // default rather than being mapped.
  const pinnedLang = input.pin?.lang ?? input.variant?.lang;
  const requestedLocale: AppLocale = isSupportedLocale(pinnedLang)
    ? pinnedLang
    : isSupportedLocale(input.locale)
      ? input.locale
      : "en";
  const requestedLang = appLocaleToReportLanguage(requestedLocale);

  const customerPool = getCustomerRuntimePool(input.customerId);

  // Languages with a stored, non-superseded row for this model variant — the
  // switcher options and the fallback chain's candidate set.
  const availLangRows = await customerPool.query<{ lang: string }>(
    `SELECT DISTINCT lang FROM story_analysis_result
      WHERE customer_id = $1 AND story_id = $2::bigint
        AND model_name = $3 AND model = $4
        AND superseded_at IS NULL`,
    [input.customerId, input.storyId, modelName, model],
  );
  const availableLangs = availLangRows.rows.map((r) => r.lang);

  // Resolve the SHOWN language. A pin targets its exact cited variant (no
  // fallback — a missing pin is `pin_unavailable`). On the unpinned path the
  // fallback chain is requested → English baseline → any available, so a
  // shareable link is stable and a still-translating user-language row degrades
  // to English rather than a spinner.
  let shownLang: string;
  let languageFallback: StoryResultPageData["languageFallback"] = null;
  if (pinnedGeneration !== null) {
    shownLang = requestedLang;
  } else if (availableLangs.includes(requestedLang)) {
    shownLang = requestedLang;
  } else if (availableLangs.includes(ENGLISH_BASELINE)) {
    shownLang = ENGLISH_BASELINE;
  } else {
    // Deterministic "any available" pick so a shareable link is stable.
    const any = [...availableLangs].sort()[0];
    if (any === undefined) {
      // No result for any language yet — the first generation is still in
      // flight (the worker is producing the English canonical).
      return {
        kind: "pending",
        stateStatus: stateRows.rows[0].status as "pending" | "ready" | "dirty",
      };
    }
    shownLang = any;
  }
  if (pinnedGeneration === null && shownLang !== requestedLang) {
    languageFallback = {
      requestedLocale,
      shownLocale: reportLanguageToAppLocale(
        shownLang === "KOREAN" ? "KOREAN" : "ENGLISH",
      ),
    };
  }
  const lang = shownLang;

  // When a generation is pinned, target that exact row and read
  // `superseded_at` so a superseded pin degrades to the notice rather than
  // silently resolving the latest generation; otherwise keep the
  // latest-non-superseded behavior. `superseded_at` is irrelevant on the
  // unpinned path (the predicate already excludes superseded rows) and is
  // selected uniformly to keep one row shape.
  const resultRow = await customerPool.query<StoryResultRow>(
    pinnedGeneration === null
      ? `SELECT ${STORY_RESULT_COLUMNS}
         FROM story_analysis_result
         WHERE customer_id = $1
           AND story_id = $2::bigint
           AND lang = $3 AND model_name = $4 AND model = $5
           AND superseded_at IS NULL
         ORDER BY generation DESC
         LIMIT 1`
      : `SELECT ${STORY_RESULT_COLUMNS}
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

  const { analysisText, severityFactors, likelihoodFactors } =
    await restoreStoryVariant(customerPool, input.customerId, row);

  // Member suspicious events for the story → member drill-down (T2 #396).
  // Fetched at the canonical event variant so the cards match the
  // Suspicious Events list; ordered by the member ordinal (`index`).
  const refs = Array.isArray(row.input_event_refs) ? row.input_event_refs : [];
  // Member-event displays follow the shown story language where a variant
  // exists, keeping the English baseline fallback (#580). The display fields
  // (tier / scores) are language-invariant, but resolving at the shown
  // language keeps the member-event link consistent with the displayed story.
  const memberLangPrefs = [...new Set([lang, ENGLISH_BASELINE])];
  const memberEvents = await fetchMemberEventDisplays(
    customerPool,
    refs,
    memberLangPrefs,
    defaultPair,
  );

  // IOC-enrichment coverage for the *current canonical* version (#498).
  // `story_analysis_result` carries no `story_version`, so resolve the
  // canonical `(story_id, story_version)` by the worker's rule and join
  // `story_enrichment_state` on it. Additive surfacing only — independent of
  // the floored `priorityTier` already loaded above.
  const coverageStatus = await loadCanonicalCoverageStatus(
    customerPool,
    input.storyId,
  );

  // Analyst-only compare column (#458): a read-only EXACT, unpinned model-only
  // lookup of the compare model at the primary's language. Unlike the story
  // page's existing `pin` (which requires a generation), this resolves the
  // latest non-superseded row for `(lang, model_name, model)` directly. Story
  // analysis is leaf-complete (it analyzes its own members), so there is no
  // on-demand generation to guard against here — but the lookup is still kept
  // side-effect-free for symmetry with the report path.
  let compare: StoryCompareOutcome | undefined;
  if (input.compare && isViewerAnalyst) {
    compare = await resolveStoryCompareColumn(customerPool, input.customerId, {
      storyId: input.storyId,
      lang,
      modelName: input.compare.modelName,
      model: input.compare.model,
    });
  }

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
      coverageStatus,
      analysisText,
      requestedBy: row.requested_by,
      requestedAt: row.requested_at,
      isViewerAnalyst,
      canRegenerate,
      requestedLocale,
      availableLocales: availableLangs
        .filter(
          (l): l is "ENGLISH" | "KOREAN" => l === "ENGLISH" || l === "KOREAN",
        )
        .map((l) => reportLanguageToAppLocale(l)),
      languageFallback,
      memberEvents,
      memberEventVariant: {
        // Follow the shown story language so the member-event link opens the
        // matching variant; the member fetch + the event reader keep an English
        // fallback for variants that do not exist yet (#580).
        lang,
        modelName: defaultPair.modelName,
        model: defaultPair.model,
      },
      compare,
    },
  };
}

/**
 * One stored `story_analysis_result` row in the loader's working shape. The
 * primary and compare lookups select the same column set so they share
 * `restoreStoryVariant`.
 */
interface StoryResultRow {
  severity_score: number;
  likelihood_score: number;
  priority_tier: PriorityTier;
  severity_factors: string[];
  likelihood_factors: string[];
  ttp_tags: string[];
  analysis_text: string;
  input_event_refs: Array<{ index: number; aiceId: string; eventKey: string }>;
  input_fact_refs: Array<{ index: number; factId: string }>;
  model_actual_version: string;
  prompt_version: string;
  generation: number;
  superseded_at: Date | null;
  requested_by: string | null;
  requested_at: Date;
}

// Column list shared by the primary (pinned / latest non-superseded) query and
// the compare lookup, kept in one place so the row shape stays consistent.
const STORY_RESULT_COLUMNS = `severity_score,
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
         requested_at`;

/**
 * Restore a story result row's narrative text and score factors to plaintext.
 * Two-hop: `E{i}` member tokens via each event's `event_redaction_map`, then
 * `F{k}` fact tokens via each fact's `enrichment_redaction_map` (RFC 0002 /
 * RFC 0003 C1 #440). Factors run through the SAME two-hop restore as the
 * narrative. Shared by the primary render and the read-only compare column
 * (#458). Callers have already passed the customer-scope authorize(), which is
 * what entitles the viewer to plaintext.
 */
async function restoreStoryVariant(
  // biome-ignore lint/suspicious/noExplicitAny: pg Pool minimal surface
  customerPool: any,
  customerId: string,
  row: Pick<
    StoryResultRow,
    | "analysis_text"
    | "input_event_refs"
    | "input_fact_refs"
    | "severity_factors"
    | "likelihood_factors"
  >,
): Promise<{
  analysisText: string;
  severityFactors: string[];
  likelihoodFactors: string[];
}> {
  const refs = Array.isArray(row.input_event_refs) ? row.input_event_refs : [];
  const mapsByIndex = new Map<number, RedactionMap>();
  if (refs.length > 0) {
    const mapRows = await customerPool.query(
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
    for (const r of mapRows.rows as Array<{
      aice_id: string;
      event_key: string;
      ciphertext: Buffer;
      wrapped_dek: string;
    }>) {
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
          customerId,
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

  const factRefs = Array.isArray(row.input_fact_refs)
    ? row.input_fact_refs
    : [];
  const factMapsByIndex = new Map<number, RedactionMap>();
  if (factRefs.length > 0) {
    const factMapRows = await customerPool.query(
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
    for (const r of factMapRows.rows as Array<{
      fact_id: string;
      ciphertext: Buffer;
      wrapped_dek: string;
    }>) {
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
          customerId,
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
  const analysisText = restoreStoryFactTokens(
    eventRestoredText,
    factMapsByIndex,
  );

  const restoreFactorTokens = (factor: string): string =>
    restoreStoryFactTokens(
      restoreStoryAnalysisTokens(factor, mapsByIndex),
      factMapsByIndex,
    );
  return {
    analysisText,
    severityFactors: row.severity_factors.map(restoreFactorTokens),
    likelihoodFactors: row.likelihood_factors.map(restoreFactorTokens),
  };
}

/**
 * Read-only EXACT, unpinned model-only lookup of a compare model variant at a
 * fixed language (#458). The story loader previously had no unpinned
 * model-only input path (its `pin` requires a generation), so this resolves
 * the latest non-superseded row for `(lang, model_name, model)` directly,
 * restores its narrative/factors, and returns `not_generated` when no stored
 * row exists. Side-effect-free — it never enqueues a job.
 */
async function resolveStoryCompareColumn(
  // biome-ignore lint/suspicious/noExplicitAny: pg Pool minimal surface
  customerPool: any,
  customerId: string,
  params: { storyId: string; lang: string; modelName: string; model: string },
): Promise<StoryCompareOutcome> {
  const { storyId, lang, modelName, model } = params;
  const resultRow = await customerPool.query(
    `SELECT ${STORY_RESULT_COLUMNS}
       FROM story_analysis_result
      WHERE customer_id = $1
        AND story_id = $2::bigint
        AND lang = $3 AND model_name = $4 AND model = $5
        AND superseded_at IS NULL
      ORDER BY generation DESC
      LIMIT 1`,
    [customerId, storyId, lang, modelName, model],
  );
  if (resultRow.rows.length === 0) {
    return { kind: "not_generated", modelName, model };
  }
  const row = resultRow.rows[0] as StoryResultRow;
  const { analysisText, severityFactors, likelihoodFactors } =
    await restoreStoryVariant(customerPool, customerId, row);
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
      severityFactors,
      likelihoodFactors,
      ttpTags: row.ttp_tags.map((id) => ({ id, name: lookupTtpName(id) })),
      analysisText,
    },
  };
}

/**
 * Resolve the IOC-enrichment coverage status for a story's *current
 * canonical* version (#498). `story_analysis_result` is keyed on `story_id`
 * only, whereas `story_enrichment_state` is keyed on `(story_id,
 * story_version)`, so this follows the worker's canonical rule
 * (`story-worker.ts` `loadCanonicalMembers`): pick the latest
 * `(story_id, story_version)` from `story` by `received_at DESC,
 * story_version DESC`, then LEFT JOIN `story_enrichment_state` on it. Both
 * tables live in the same customer DB, so this is one in-DB join. The join is
 * gated on `ses.status = 'complete'` so only a *completed* enrichment run
 * surfaces coverage: a hard failure persists `status = 'failed',
 * coverage_status = 'unknown'` (`enrichment-worker.ts`
 * `persistEnrichmentFailure`), which is "not checked yet" — not the
 * false-unknown (completed-but-degraded) case this banner is for — so a
 * `failed` row is treated as no coverage. Returns `null` when the story has
 * no row (already ruled out upstream), when no enrichment-state row exists
 * for the canonical version, or when that row has not completed. Never
 * throws the page — it is additive transparency.
 */
async function loadCanonicalCoverageStatus(
  // biome-ignore lint/suspicious/noExplicitAny: pg Pool minimal surface
  customerPool: any,
  storyId: string,
): Promise<CoverageStatus | null> {
  const { rows } = await customerPool.query(
    `SELECT ses.coverage_status
       FROM story s
       LEFT JOIN story_enrichment_state ses
         ON ses.story_id = s.story_id
        AND ses.story_version = s.story_version
        AND ses.status = 'complete'
      WHERE s.story_id = $1::bigint
      ORDER BY s.received_at DESC, s.story_version DESC
      LIMIT 1`,
    [storyId],
  );
  if (rows.length === 0) return null;
  return (rows[0] as { coverage_status: CoverageStatus | null })
    .coverage_status;
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
  // Language preference order (#580): the shown story language first, then the
  // English baseline. Per `(aice_id, event_key)` the first available language
  // wins. The display fields are language-invariant, so this only steers which
  // stored event variant supplies them and keeps the English fallback.
  langPrefs: ReadonlyArray<string>,
  // The canonical event variant the member cards match — keyed on the
  // customer's per-customer default model (#473), not the env pair.
  defaultPair: ModelPair,
): Promise<StoryMemberEvent[]> {
  const ordered = [...refs].sort((a, b) => a.index - b.index);
  if (ordered.length === 0) return [];

  const tuples = ordered
    .map((_, i) => `($${i * 2 + 1}::text, $${i * 2 + 2}::numeric)`)
    .join(", ");
  const params: unknown[] = ordered.flatMap((r) => [r.aiceId, r.eventKey]);
  const base = ordered.length * 2;
  // Lang preference list ($base+1) ranks variants; model pair follows.
  params.push(langPrefs, defaultPair.modelName, defaultPair.model);

  // `array_position(langPrefs, lang)` ranks each row by the preference order;
  // DISTINCT ON keeps the best-ranked (then latest-generation) row per event.
  const { rows } = await customerPool.query(
    `SELECT DISTINCT ON (aice_id, event_key)
            aice_id, event_key::text AS event_key,
            priority_tier, severity_score, likelihood_score,
            event_time, kind
       FROM event_analysis_result
      WHERE (aice_id, event_key) IN (${tuples})
        AND lang = ANY($${base + 1}::text[])
        AND model_name = $${base + 2}
        AND model = $${base + 3}
        AND superseded_at IS NULL
      ORDER BY aice_id, event_key,
               array_position($${base + 1}::text[], lang),
               generation DESC`,
    params,
  );
  const byKey = new Map<
    string,
    {
      priorityTier: PriorityTier;
      severityScore: number;
      likelihoodScore: number;
      // Event identity for the member row title (#559); from the same row.
      eventTime: Date | null;
      kind: string | null;
    }
  >();
  for (const r of rows as Array<{
    aice_id: string;
    event_key: string;
    priority_tier: PriorityTier;
    severity_score: number;
    likelihood_score: number;
    event_time: Date | null;
    kind: string | null;
  }>) {
    byKey.set(`${r.aice_id}:${r.event_key}`, {
      priorityTier: r.priority_tier,
      severityScore: r.severity_score,
      likelihoodScore: r.likelihood_score,
      eventTime: r.event_time ?? null,
      kind: r.kind ?? null,
    });
  }
  return ordered.map((r) => {
    const v = byKey.get(`${r.aiceId}:${r.eventKey}`);
    return {
      index: r.index,
      aiceId: r.aiceId,
      eventKey: r.eventKey,
      // Title fields surface even when there is no canonical display row.
      eventTime: v?.eventTime ?? null,
      kind: v?.kind ?? null,
      display: v
        ? {
            priorityTier: v.priorityTier,
            severityScore: v.severityScore,
            likelihoodScore: v.likelihoodScore,
          }
        : null,
    };
  });
}
