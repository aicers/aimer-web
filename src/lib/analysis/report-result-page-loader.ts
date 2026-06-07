// Server-side loader for the periodic report detail page
// (`/[locale]/customers/{customerId}/analysis/reports/{period}/{bucketDate}`).
//
// Mirrors `story-result-page-loader.ts` but operates on
// `periodic_report_result` and the customer's default
// `(tz, lang, model_name, model)` variant. Report-scope
// `<<REDACTED_*_R{j}_*>>` tokens are restored to plaintext by replaying
// `buildReportTokenMap` over the cited leaf narratives AND their factor
// arrays (pinned by generation in `input_story_refs` / `input_event_refs`,
// in the same field order the builder used), then resolving each leaf's
// source token through the relevant event redaction map.

import "server-only";

import {
  type AppLocale,
  appLocaleToReportLanguage,
  isSupportedLocale,
  type ReportLanguage,
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
import { lookupTtpName } from "./mitre-ttp";
import type { PriorityTier } from "./priority-tier";
import { buildReportTokenMap } from "./report-token";
import { restoreReportAnalysisTokens } from "./report-token-restore";
import { enqueueOnDemandReportJob } from "./report-worker";

// English is the guaranteed baseline language (parent #386): the worker
// always seeds it, so it is the second link in the fallback chain
// (requested → English → any available). This is NOT `ANALYSIS_DEFAULT_LANG`:
// L2 defaults the report language to the *viewer's* locale, not the
// deployment's configured generation default (#388 scope).
const ENGLISH_BASELINE: ReportLanguage = "ENGLISH";
const DEFAULT_MODEL_NAME = process.env.ANALYSIS_DEFAULT_MODEL_NAME ?? "openai";
const DEFAULT_MODEL = process.env.ANALYSIS_DEFAULT_MODEL ?? "gpt-4o";

/**
 * Phase-2 on-demand status for the requested (not-yet-available) language,
 * surfaced from `periodic_report_job.status` (with `source_pending` for a
 * bucket whose settle window has not elapsed, so no job was created).
 */
export type LanguageJobStatus =
  | "queued"
  | "processing"
  | "done"
  | "failed"
  | "source_pending";

const STORY_SOURCE_RE = /<<REDACTED_(IP|EMAIL|MAC|DOMAIN)_E(\d+)_(\d+)>>/;
const EVENT_SOURCE_RE = /<<REDACTED_(IP|EMAIL|MAC|DOMAIN)_(\d+)>>/;

/**
 * Decoded citation source for one render unit (aimer-web-internal form, #449).
 *
 * aimer emits the wire form `{ type: "story", story_id }` |
 * `{ type: "event", event_ref }`, where `event_ref` is the opaque packed
 * `"{aice_id}:{event_key}"` string aimer-web sent it (`report-input-builder`).
 * The loader decodes it back to the composite leaf key and resolves the pinned
 * `variant` from `input_story_refs` / `input_event_refs` by source key — the
 * single source of truth for `generation` (Decisions (ii)), so a stale or
 * absent `generation` can never ride along on the citation. Modeled as a
 * discriminated union on `sourceType` so a story source can never carry an
 * event key (or vice versa).
 */
export type CitedUnitSource =
  | { sourceType: "story"; storyId: string; variant: CitedLeafVariant }
  | {
      sourceType: "event";
      aiceId: string;
      eventKey: string;
      variant: CitedLeafVariant;
    };

/**
 * One leaf-derived render unit (#449): a self-contained Markdown chunk plus,
 * when the unit is grounded in exactly one input leaf, the decoded citation
 * pointing at it. Uncited units (cross-cutting prose) carry no `source` and
 * render without a dangling citation. The three leaf-derived sections
 * (`executive_summary` / `story_highlights` / `notable_events`) converge on
 * this `[{ text, source? }]` shape; aimer authors the segmentation, so the
 * loader consumes the units verbatim and never re-splits prose.
 */
export interface CitationUnit {
  text: string;
  source?: CitedUnitSource;
}

// Display-ready report sections, keyed by aimer's `PERIODIC_SECURITY_REPORT`
// output schema (prompt v5, schemas/aimer.graphql @ de54869). The three
// leaf-derived sections (`executive_summary` / `story_highlights` /
// `notable_events`) are arrays of citation units `{ text, source? }` — the
// loader preserves each unit's boundary and decoded `source` so a citation can
// anchor to it. `baseline_observations` (an array of Markdown strings) and
// `period_outlook` (a single string) are NOT leaf-derived and carry no
// citations; the loader joins them into one display block as before.
export interface ReportSections {
  executive_summary: CitationUnit[];
  story_highlights: CitationUnit[];
  notable_events: CitationUnit[];
  baseline_observations: string;
  period_outlook: string;
}

/**
 * The cited variant a Sources card links to. `lang` is the report-language
 * enum (`ENGLISH`/`KOREAN`) the leaf row is keyed on — for a translated
 * report this is the canonical's replay language (`restoration_lang`), NOT
 * the translated row's own `lang` — paired with the per-leaf `generation`
 * from `input_*_refs` and the canonical `model_name`/`model`. The leaf
 * detail page rebuilds its generation pin from exactly these four fields.
 */
export interface CitedLeafVariant {
  generation: number;
  lang: string;
  modelName: string;
  model: string;
}

/**
 * Display fields fetched from the leaf table at the pinned variant. `null`
 * when the pinned row is missing or superseded — the card then degrades to
 * ID + generation only (parent #386 generation-pin contract). Fields stay
 * within the parent guardrails: tier + leaf-derived severity/likelihood
 * scores (+ TTP for stories), all already exposed on the leaf detail pages.
 */
export interface CitedStorySource {
  storyId: string;
  variant: CitedLeafVariant;
  display: {
    priorityTier: PriorityTier;
    severityScore: number;
    likelihoodScore: number;
    ttpTags: Array<{ id: string; name: string | null }>;
  } | null;
}

export interface CitedEventSource {
  aiceId: string;
  eventKey: string;
  variant: CitedLeafVariant;
  display: {
    priorityTier: PriorityTier;
    severityScore: number;
    likelihoodScore: number;
  } | null;
}

/**
 * Report-level cited sources — the generation-pinned leaf input list the
 * report was built from (NOT a section/sentence-level citation map). Drives
 * the Sources panel (T1).
 */
export interface CitedSources {
  stories: CitedStorySource[];
  events: CitedEventSource[];
}

/**
 * One compare column's rendered data for the side-by-side view (#458). Same
 * five display sections as the primary column plus the analyst-only
 * provenance fields. Built by a read-only EXACT lookup that NEVER enqueues an
 * on-demand job (Scope 3's "only render stored variants" rule).
 */
export interface ReportCompareColumn {
  modelName: string;
  model: string;
  modelActualVersion: string;
  promptVersion: string;
  generation: number;
  lang: string;
  priorityTier: PriorityTier;
  aggregateSeverityScore: number;
  aggregateLikelihoodScore: number;
  sections: ReportSections;
}

/**
 * Outcome of resolving the analyst-only compare column (#458). `not_generated`
 * means no stored row exists for that `(model_name, model)` at the primary's
 * shown language — the page shows the regenerate CTA rather than generating
 * work.
 */
export type ReportCompareOutcome =
  | { kind: "ok"; data: ReportCompareColumn }
  | { kind: "not_generated"; modelName: string; model: string };

export type ReportResultPageOutcome =
  | { kind: "unauthorized" }
  | { kind: "forbidden" }
  | { kind: "not_found" }
  // `tz` is the resolved report timezone (pinned variant → customer
  // default → UTC). The detail page anchors the LIVE period tab on
  // "today" in this tz, so the pending outcome must surface it too — the
  // `ok` outcome already exposes it via `data.tz`.
  | { kind: "pending"; stateStatus: string; tz: string }
  // A specific report generation was pinned (T2 "Cited by" link) but the
  // pinned row is missing or superseded. The page shows the "evidence
  // version no longer available" notice and does NOT fall back to the
  // latest generation (parent #386 generation-pin contract). Mirrors the
  // leaf loaders' `pin_unavailable`.
  | { kind: "pin_unavailable"; generation: number }
  | { kind: "ok"; data: ReportResultPageData };

export interface ReportResultPageData {
  customerId: string;
  period: string;
  bucketDate: string;
  tz: string;
  lang: string;
  modelName: string;
  model: string;
  modelActualVersion: string;
  promptVersion: string;
  generation: number;
  priorityTier: PriorityTier;
  aggregateSeverityScore: number;
  aggregateLikelihoodScore: number;
  ttpTags: Array<{ id: string; name: string | null }>;
  /** LLM narrative sections, with report-scope tokens restored. */
  sections: ReportSections;
  topStoryCount: number;
  topEventCount: number;
  /**
   * Report-level cited story/event leaf sources at the pinned variant,
   * with display fields when the pinned row is available (T1 Sources
   * panel). Counts match `topStoryCount` / `topEventCount`.
   */
  citedSources: CitedSources;
  requestedBy: string | null;
  requestedAt: Date;
  /**
   * Whether the viewer is an analyst for this customer (#457). Gates the
   * model/prompt provenance fields and the Regenerate button on the detail
   * page; a non-analyst viewer keeps everything that carries analytical
   * meaning (tier, TTP, language, scores, sections).
   */
  isViewerAnalyst: boolean;
  /**
   * The language the viewer asked for (their locale, or a pinned `?lang`),
   * as an app-locale code. Equals `reportLanguageToAppLocale(data.lang)` when
   * the requested variant exists; differs when a fallback occurred.
   */
  requestedLocale: AppLocale;
  /**
   * Languages with a stored result for this `(tz, model_name, model)` variant,
   * as app-locale codes, for the language switcher. Always includes the shown
   * language.
   */
  availableLocales: AppLocale[];
  /**
   * Present only when the shown report fell back from the requested language
   * (requested variant not yet generated). Describes the fallback for the
   * notice and carries the phase-2 on-demand job status for the requested
   * language (null when no job applies).
   */
  languageFallback: {
    requestedLocale: AppLocale;
    shownLocale: AppLocale;
    jobStatus: LanguageJobStatus | null;
  } | null;
  /**
   * Analyst-only side-by-side compare column (#458), present only when a
   * compare variant was requested (`?compareModelName=&compareModel=`) AND the
   * viewer is an analyst. Resolved by a read-only EXACT lookup at the primary's
   * shown language + the compare model — it never enqueues a job, so a
   * not-yet-generated compare variant returns `not_generated` (the page shows
   * the regenerate CTA) instead of silently generating work.
   */
  compare?: ReportCompareOutcome;
}

export interface ReportResultPageInput {
  customerId: string;
  period: string;
  bucketDate: string;
  /**
   * The viewer's resolved app locale (the page's `[locale]` route param,
   * already L1-resolved: saved → browser → default). This is the DEFAULT
   * report language when `?lang` is not pinned — converted to the aimer enum
   * via the canonical locale↔language mapper, NOT `ANALYSIS_DEFAULT_LANG`.
   */
  locale: string;
  /**
   * Optional report-variant selectors from the page's search params.
   *   - `lang` is now an **app-locale code** (`en` / `ko`), NOT the raw enum
   *     (#388 reinterpretation). It is validated to `{en, ko}` here; any other
   *     value — including a legacy enum-shaped `KOREAN` — is treated as
   *     unpinned and falls through to the viewer-locale default.
   *   - `tz` defaults to the customer-timezone snapshot; `model_name`/`model`
   *     default to the env-configured variant.
   */
  variant?: {
    tz?: string;
    lang?: string;
    model_name?: string;
    model?: string;
  };
  /**
   * Optional report-generation pin (T2 "Cited by" link, parent #386).
   * When present, the loader resolves the EXACT generation at the
   * requested `(tz, lang, model_name, model)` variant instead of the
   * latest non-superseded one, performs NO language fallback and NO
   * on-demand enqueue (the pin means "show exactly what that report
   * cited"), and reports `pin_unavailable` when the row is missing or
   * superseded. A positive integer; the page validates it before calling.
   */
  generation?: number;
  /**
   * Analyst-only compare variant (#458). The second column's model pair; the
   * loader resolves it at the SAME shown language as the primary via a
   * read-only EXACT lookup (no language fallback, no on-demand enqueue). Only
   * honored on the unpinned path and only for an analyst viewer — a
   * non-analyst's crafted `?compareModel` is ignored.
   */
  compare?: {
    model_name: string;
    model: string;
  };
}

interface StoryRef {
  story_id: string;
  generation: number;
}
interface EventRef {
  aice_id: string;
  event_key: string;
  generation: number;
}

// Wire form of a citation `source` as aimer emits it inside `sections_jsonb`
// (#449): a discriminated union on `type` carrying an opaque leaf identifier.
// `story_id` / `event_ref` are the exact strings aimer-web sent in the input
// bundle; `event_ref` is the packed `"{aice_id}:{event_key}"` token and is
// never split here — the loader resolves it through the input refs instead.
type WireUnitSource =
  | { type: "story"; story_id: string }
  | { type: "event"; event_ref: string };

// Wire form of a render unit before token restoration / source decoding.
interface WireCitationUnit {
  text?: unknown;
  source?: unknown;
}

// Raw `sections_jsonb` as stored from aimer's JSON (tolerant of legacy shapes;
// see `restoreUnits` / `restoreJoined`). Typed loosely because pre-v5 rows
// may still carry plain strings / string arrays for the leaf-derived keys.
interface RawReportSections {
  executive_summary?: unknown;
  story_highlights?: unknown;
  notable_events?: unknown;
  baseline_observations?: unknown;
  period_outlook?: unknown;
}

export async function loadReportResultPage(
  input: ReportResultPageInput,
): Promise<ReportResultPageOutcome> {
  const token = await getAuthCookie("general");
  if (!token) return { kind: "unauthorized" };
  let claims: Awaited<ReturnType<typeof verifyJwtFull>>;
  try {
    claims = await verifyJwtFull(token, "general");
  } catch {
    return { kind: "unauthorized" };
  }

  const authPool = getAuthPool();

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
  const { auth, isViewerAnalyst } = await withTransaction(
    authPool,
    async (client) => {
      const auth = await authorize(
        client,
        "general",
        claims.sub,
        "reports:read",
        {
          customerId: input.customerId,
          operationKind: "read",
          // Bridge sessions cannot read these surfaces (round-15 S3): an
          // in-scope bridge → 403, mirroring the regenerate/summary endpoints.
          allowInBridge: false,
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
  if (!auth.authorized) {
    // Distinguish outcomes so the page can map them to the right status
    // (round-15 S3): bridge denial and member-without-permission → 403;
    // non-membership → 404 (existence-hiding). `authorizeGeneral` returns
    // a `permissions` set for members (even when the required permission is
    // absent) and leaves it undefined for non-members; a `reason` is only
    // set for bridge denials.
    if (auth.reason === "bridge_not_allowed") return { kind: "forbidden" };
    if (auth.permissions !== undefined) return { kind: "forbidden" };
    return { kind: "unauthorized" };
  }

  // Variant resolution: each selector falls back to its default when the
  // caller did not pin it. Default tz = the customer's current timezone
  // snapshot; model_name/model default to the env-configured variant.
  let tz: string;
  if (input.variant?.tz) {
    tz = input.variant.tz;
  } else {
    const tzRow = await authPool.query<{ timezone: string }>(
      `SELECT timezone FROM customers WHERE id = $1`,
      [input.customerId],
    );
    tz = tzRow.rows[0]?.timezone ?? "UTC";
  }
  const modelName = input.variant?.model_name ?? DEFAULT_MODEL_NAME;
  const model = input.variant?.model ?? DEFAULT_MODEL;

  // Requested language = pinned `?lang` (validated to a real app locale) →
  // else the viewer's locale (validated) → else the English baseline. The
  // pinned value MUST be validated to `{en, ko}` BEFORE mapping: a legacy
  // enum-shaped `?lang=KOREAN` is not a supported locale, so it is treated as
  // unpinned and falls through to the viewer default rather than being mapped
  // (#388 — only `en`/`ko` are valid `?lang` values).
  const pinnedLang = input.variant?.lang;
  const requestedLocale: AppLocale = isSupportedLocale(pinnedLang)
    ? pinnedLang
    : isSupportedLocale(input.locale)
      ? input.locale
      : "en";
  const requestedLang = appLocaleToReportLanguage(requestedLocale);

  const stateRows = await authPool.query<{ status: string }>(
    `SELECT status FROM periodic_report_state
      WHERE customer_id = $1 AND period = $2
        AND bucket_date = $3::date AND tz = $4`,
    [input.customerId, input.period, input.bucketDate, tz],
  );
  if (stateRows.rows.length === 0) return { kind: "not_found" };
  if (stateRows.rows[0].status === "archived") return { kind: "not_found" };

  const customerPool = getCustomerRuntimePool(input.customerId);

  // The bucket's available-language set for this `(tz, model_name, model)`
  // variant — drives both the switcher and the fallback chain. Scoped to
  // non-superseded rows so it matches what the result query below can fetch.
  const availLangRows = await customerPool.query<{ lang: string }>(
    `SELECT DISTINCT lang FROM periodic_report_result
      WHERE customer_id = $1 AND period = $2
        AND bucket_date = $3::date AND tz = $4
        AND model_name = $5 AND model = $6
        AND superseded_at IS NULL`,
    [input.customerId, input.period, input.bucketDate, tz, modelName, model],
  );
  const availableLangs = availLangRows.rows.map((r) => r.lang);

  // A generation pin (T2 "Cited by" link) resolves the EXACT requested
  // variant + generation: no language fallback, no on-demand enqueue. A
  // pinned generation that is missing or superseded is surfaced as
  // `pin_unavailable` below (parent #386), never silently replaced.
  const pinnedGeneration = input.generation ?? null;

  // Fallback chain: requested → English (guaranteed baseline) → any available.
  // `null` only when no variant exists at all (the bucket has no result yet).
  // Skipped on the pinned path, which targets the requested language as-is.
  let shownLang: string | null;
  let languageFallback: ReportResultPageData["languageFallback"] = null;
  if (pinnedGeneration !== null) {
    shownLang = requestedLang;
  } else {
    if (availableLangs.includes(requestedLang)) {
      shownLang = requestedLang;
    } else if (availableLangs.includes(ENGLISH_BASELINE)) {
      shownLang = ENGLISH_BASELINE;
    } else {
      // Deterministic pick of "any available" so a shareable link is stable.
      shownLang = [...availableLangs].sort()[0] ?? null;
    }

    if (shownLang === null) {
      // No result for any language yet — the bucket's first generation is
      // still in flight. Surface the existing pending state (state #5): the
      // worker is already producing the English baseline, so do NOT enqueue
      // an on-demand job here (an unavailable language while nothing exists
      // is the pending case, not a spinner tied to a per-language job).
      return { kind: "pending", stateStatus: stateRows.rows[0].status, tz };
    }

    // A fallback occurred when the shown language is not the requested one.
    // In that case (phase 2) enqueue the requested variant on-demand and
    // surface its job status; repeated views coalesce (no generation bump).
    if (shownLang !== requestedLang) {
      const jobStatus = await enqueueRequestedLanguage(authPool, {
        customerId: input.customerId,
        period: input.period,
        bucketDate: input.bucketDate,
        tz,
        lang: requestedLang,
        modelName,
        model,
      });
      languageFallback = {
        requestedLocale,
        shownLocale: reportLanguageToAppLocale(shownLang as ReportLanguage),
        jobStatus,
      };
    }
  }

  const resultRow = await customerPool.query<ReportResultRow>(
    // Pinned path: target the exact generation and read `superseded_at`
    // so a superseded pin degrades to the notice; unpinned path keeps the
    // latest-non-superseded behavior. `superseded_at` is selected
    // uniformly to keep one row shape (it is NULL on the unpinned path by
    // construction). The column list is shared with the compare lookup.
    pinnedGeneration === null
      ? `SELECT ${REPORT_RESULT_COLUMNS}
           FROM periodic_report_result
          WHERE customer_id = $1 AND period = $2
            AND bucket_date = $3::date AND tz = $4
            AND lang = $5 AND model_name = $6 AND model = $7
            AND superseded_at IS NULL
          ORDER BY generation DESC
          LIMIT 1`
      : `SELECT ${REPORT_RESULT_COLUMNS}
           FROM periodic_report_result
          WHERE customer_id = $1 AND period = $2
            AND bucket_date = $3::date AND tz = $4
            AND lang = $5 AND model_name = $6 AND model = $7
            AND generation = $8
          LIMIT 1`,
    pinnedGeneration === null
      ? [
          input.customerId,
          input.period,
          input.bucketDate,
          tz,
          shownLang,
          modelName,
          model,
        ]
      : [
          input.customerId,
          input.period,
          input.bucketDate,
          tz,
          shownLang,
          modelName,
          model,
          pinnedGeneration,
        ],
  );
  if (resultRow.rows.length === 0) {
    // A pinned generation that no longer exists is "evidence no longer
    // available", not a still-generating bucket.
    if (pinnedGeneration !== null) {
      return { kind: "pin_unavailable", generation: pinnedGeneration };
    }
    // `shownLang` came from the available-language set, so a row should
    // exist; treat a vanished row (e.g. just superseded) as still pending.
    return { kind: "pending", stateStatus: stateRows.rows[0].status, tz };
  }
  const row = resultRow.rows[0];
  // A superseded pinned row is treated as unavailable — the page must not
  // present stale evidence as the version the report cited.
  if (pinnedGeneration !== null && row.superseded_at !== null) {
    return { kind: "pin_unavailable", generation: pinnedGeneration };
  }

  const storyRefs = Array.isArray(row.input_story_refs)
    ? row.input_story_refs
    : [];
  const eventRefs = Array.isArray(row.input_event_refs)
    ? row.input_event_refs
    : [];

  // `restoration_lang` pins the language whose cited leaves are replayed to
  // restore the report-scope tokens: NULL replays at the row's own `lang`
  // (native), a non-null enum (e.g. ENGLISH for a translated row) replays
  // the canonical's leaves, which the translated row's copied `input_*_refs`
  // point at (#412 item 5). `model_name` / `model` are the canonical's on a
  // translated row (copied verbatim), so the pinned leaves resolve.
  const replayLang = row.restoration_lang ?? row.lang;
  // `leafVariant` is the variant the cited leaves are pinned to: the replay
  // language (canonical's for a translated row) plus the row's model. Both
  // the token replay AND the Sources display-field fetch / link use it, so
  // a translated report links to the correct leaf instead of the missing
  // `row.lang` variant.
  const leafVariant = {
    lang: replayLang,
    modelName: row.model_name,
    model: row.model,
  };
  const { plaintextByReportToken, storyDisplays, eventDisplays } =
    await buildReportTokenPlaintext(
      customerPool,
      input.customerId,
      storyRefs,
      eventRefs,
      leafVariant,
    );

  // Build the report-level cited sources: each stored ref + the display
  // fields fetched at the pinned variant. A missing or superseded leaf row
  // degrades the card to ID/generation only (display = null).
  const citedSources: CitedSources = {
    stories: storyRefs.map((ref, i) => {
      const d = storyDisplays[i];
      return {
        storyId: ref.story_id,
        variant: {
          generation: ref.generation,
          lang: replayLang,
          modelName: row.model_name,
          model: row.model,
        },
        display:
          d && !d.superseded
            ? {
                priorityTier: d.priorityTier,
                severityScore: d.severityScore,
                likelihoodScore: d.likelihoodScore,
                ttpTags: d.ttpTags.map((id) => ({
                  id,
                  name: lookupTtpName(id),
                })),
              }
            : null,
      };
    }),
    events: eventRefs.map((ref, i) => {
      const d = eventDisplays[i];
      return {
        aiceId: ref.aice_id,
        eventKey: ref.event_key,
        variant: {
          generation: ref.generation,
          lang: replayLang,
          modelName: row.model_name,
          model: row.model,
        },
        display:
          d && !d.superseded
            ? {
                priorityTier: d.priorityTier,
                severityScore: d.severityScore,
                likelihoodScore: d.likelihoodScore,
              }
            : null,
      };
    }),
  };

  const sections = restoreReportSectionsFromRow(
    row,
    replayLang,
    storyRefs,
    eventRefs,
    plaintextByReportToken,
  );

  // Analyst-only compare column (#458): an EXACT, side-effect-free lookup of
  // the compare model at the primary's shown language. It deliberately does
  // NOT reuse the primary resolution above (which enqueues an on-demand job on
  // language fallback) — Scope 3 requires "render stored variants only / never
  // auto-generate". Only honored on the unpinned path and only for analysts.
  let compare: ReportCompareOutcome | undefined;
  if (input.compare && isViewerAnalyst && pinnedGeneration === null) {
    compare = await resolveReportCompareColumn(customerPool, input.customerId, {
      period: input.period,
      bucketDate: input.bucketDate,
      tz,
      lang: row.lang,
      modelName: input.compare.model_name,
      model: input.compare.model,
    });
  }

  return {
    kind: "ok",
    data: {
      customerId: input.customerId,
      period: input.period,
      bucketDate: input.bucketDate,
      tz,
      // Report the row's actual stored variant, not the requested defaults,
      // so the displayed metadata is truthful for non-default reports.
      lang: row.lang,
      modelName: row.model_name,
      model: row.model,
      modelActualVersion: row.model_actual_version,
      promptVersion: row.prompt_version,
      generation: row.generation,
      priorityTier: row.priority_tier,
      aggregateSeverityScore: row.aggregate_severity_score,
      aggregateLikelihoodScore: row.aggregate_likelihood_score,
      ttpTags: (row.aggregate_ttp_tags ?? []).map((id) => ({
        id,
        name: lookupTtpName(id),
      })),
      sections,
      topStoryCount: storyRefs.length,
      topEventCount: eventRefs.length,
      citedSources,
      requestedBy: row.requested_by,
      requestedAt: row.requested_at,
      isViewerAnalyst,
      requestedLocale,
      // Map the stored enums to app-locale codes for the switcher, dropping
      // any unrecognized value defensively (the column is enum-constrained).
      availableLocales: availableLangs
        .filter((l): l is ReportLanguage => l === "ENGLISH" || l === "KOREAN")
        .map(reportLanguageToAppLocale),
      languageFallback,
      compare,
    },
  };
}

/**
 * One stored `periodic_report_result` row in the loader's working shape. The
 * primary and compare lookups select the same column set so they can share
 * `restoreReportSectionsFromRow` and `buildReportTokenPlaintext`.
 */
interface ReportResultRow {
  model_actual_version: string;
  prompt_version: string;
  generation: number;
  lang: string;
  restoration_lang: string | null;
  model_name: string;
  model: string;
  priority_tier: PriorityTier;
  aggregate_severity_score: number;
  aggregate_likelihood_score: number;
  aggregate_ttp_tags: string[];
  sections_jsonb: RawReportSections;
  input_story_refs: StoryRef[];
  input_event_refs: EventRef[];
  superseded_at: Date | null;
  requested_by: string | null;
  requested_at: Date;
}

// Column list shared by the primary (latest non-superseded / pinned) query and
// the compare lookup, kept in one place so the row shape stays consistent.
const REPORT_RESULT_COLUMNS = `model_actual_version, prompt_version, generation,
        lang, restoration_lang, model_name, model,
        priority_tier, aggregate_severity_score,
        aggregate_likelihood_score, aggregate_ttp_tags, sections_jsonb,
        input_story_refs, input_event_refs, superseded_at,
        requested_by::text AS requested_by, requested_at`;

/**
 * Restore a report result row's five display sections from the report→source
 * token map (#449). Pure (no DB): the three leaf-derived sections become
 * arrays of citation units with decoded sources, while
 * `baseline_observations` / `period_outlook` join into display blocks. Shared
 * by the primary render and the read-only compare column (#458).
 */
function restoreReportSectionsFromRow(
  row: Pick<ReportResultRow, "sections_jsonb" | "model_name" | "model">,
  replayLang: string,
  storyRefs: StoryRef[],
  eventRefs: EventRef[],
  plaintextByReportToken: Map<string, string>,
): ReportSections {
  const restoreOne = (s: unknown) =>
    restoreReportAnalysisTokens(
      typeof s === "string" ? s : "",
      plaintextByReportToken,
    );
  // `baseline_observations` (an array of Markdown strings) and `period_outlook`
  // (a plain string) are NOT leaf-derived and carry no citations: restore each
  // entry and join into one display block. Tolerate either shape so a legacy
  // row still renders.
  const restoreJoined = (v: unknown) =>
    Array.isArray(v)
      ? v
          .map(restoreOne)
          .filter((s) => s.length > 0)
          .join("\n\n")
      : restoreOne(v);

  // The cited variant a unit's `source` resolves to is the leaf's pinned
  // entry in the row's input refs — the single source of truth for
  // `generation` (#449). `lang`/`model` mirror the Sources panel's so a
  // citation links to the same leaf variant the report consumed.
  const storyRefByKey = new Map(storyRefs.map((r) => [r.story_id, r]));
  const eventRefByKey = new Map(
    eventRefs.map((r) => [`${r.aice_id}:${r.event_key}`, r]),
  );
  const decodeSource = (raw: unknown): CitedUnitSource | undefined => {
    if (raw === null || typeof raw !== "object") return undefined;
    const wire = raw as Partial<WireUnitSource>;
    if (wire.type === "story" && typeof wire.story_id === "string") {
      const ref = storyRefByKey.get(wire.story_id);
      // Drop a citation whose leaf is not in the input bundle rather than
      // render a dangling link (the worker already rejects fabricated sources
      // before persisting; this is the read-path defensive degrade).
      if (!ref) return undefined;
      return {
        sourceType: "story",
        storyId: ref.story_id,
        variant: {
          generation: ref.generation,
          lang: replayLang,
          modelName: row.model_name,
          model: row.model,
        },
      };
    }
    if (wire.type === "event" && typeof wire.event_ref === "string") {
      // `event_ref` is opaque; resolve it through the input refs by the same
      // packed key the builder emitted instead of splitting on `:` (robust
      // even if an `aice_id` ever contained a colon).
      const ref = eventRefByKey.get(wire.event_ref);
      if (!ref) return undefined;
      return {
        sourceType: "event",
        aiceId: ref.aice_id,
        eventKey: ref.event_key,
        variant: {
          generation: ref.generation,
          lang: replayLang,
          modelName: row.model_name,
          model: row.model,
        },
      };
    }
    return undefined;
  };
  // The three leaf-derived sections are arrays of `{ text, source? }` units
  // (prompt v5). Restore each unit's text and decode its source, preserving
  // per-unit boundaries so a citation can anchor to one. Tolerate a legacy
  // plain-string / string-array section by wrapping each string as an
  // uncited unit, so a pre-v5 row still renders.
  const restoreUnits = (v: unknown): CitationUnit[] => {
    const items = Array.isArray(v) ? v : [v];
    const units: CitationUnit[] = [];
    for (const item of items) {
      if (typeof item === "string") {
        const text = restoreOne(item);
        if (text.length > 0) units.push({ text });
        continue;
      }
      if (item === null || typeof item !== "object") continue;
      const unit = item as WireCitationUnit;
      const text = restoreOne(unit.text);
      if (text.length === 0) continue;
      const source = decodeSource(unit.source);
      units.push(source ? { text, source } : { text });
    }
    return units;
  };
  return {
    executive_summary: restoreUnits(row.sections_jsonb?.executive_summary),
    story_highlights: restoreUnits(row.sections_jsonb?.story_highlights),
    notable_events: restoreUnits(row.sections_jsonb?.notable_events),
    baseline_observations: restoreJoined(
      row.sections_jsonb?.baseline_observations,
    ),
    period_outlook: restoreJoined(row.sections_jsonb?.period_outlook),
  };
}

/**
 * Read-only EXACT lookup of a compare model variant at a fixed language (#458).
 * Resolves the latest non-superseded generation for
 * `(tz, lang, model_name, model)` and restores its sections — with NO language
 * fallback and NO on-demand enqueue (the regression the compare path guards
 * against; the primary loader enqueues on fallback, this must not). Returns
 * `not_generated` when no stored row exists so the page can show the
 * regenerate CTA rather than generating work.
 */
async function resolveReportCompareColumn(
  // biome-ignore lint/suspicious/noExplicitAny: pg Pool minimal surface
  customerPool: any,
  customerId: string,
  params: {
    period: string;
    bucketDate: string;
    tz: string;
    lang: string;
    modelName: string;
    model: string;
  },
): Promise<ReportCompareOutcome> {
  const { period, bucketDate, tz, lang, modelName, model } = params;
  const resultRow = await customerPool.query(
    `SELECT ${REPORT_RESULT_COLUMNS}
       FROM periodic_report_result
      WHERE customer_id = $1 AND period = $2
        AND bucket_date = $3::date AND tz = $4
        AND lang = $5 AND model_name = $6 AND model = $7
        AND superseded_at IS NULL
      ORDER BY generation DESC
      LIMIT 1`,
    [customerId, period, bucketDate, tz, lang, modelName, model],
  );
  if (resultRow.rows.length === 0) {
    return { kind: "not_generated", modelName, model };
  }
  const row = resultRow.rows[0] as ReportResultRow;
  const storyRefs = Array.isArray(row.input_story_refs)
    ? row.input_story_refs
    : [];
  const eventRefs = Array.isArray(row.input_event_refs)
    ? row.input_event_refs
    : [];
  const replayLang = row.restoration_lang ?? row.lang;
  const { plaintextByReportToken } = await buildReportTokenPlaintext(
    customerPool,
    customerId,
    storyRefs,
    eventRefs,
    { lang: replayLang, modelName: row.model_name, model: row.model },
  );
  const sections = restoreReportSectionsFromRow(
    row,
    replayLang,
    storyRefs,
    eventRefs,
    plaintextByReportToken,
  );
  return {
    kind: "ok",
    data: {
      modelName: row.model_name,
      model: row.model,
      modelActualVersion: row.model_actual_version,
      promptVersion: row.prompt_version,
      generation: row.generation,
      lang: row.lang,
      priorityTier: row.priority_tier,
      aggregateSeverityScore: row.aggregate_severity_score,
      aggregateLikelihoodScore: row.aggregate_likelihood_score,
      sections,
    },
  };
}

/**
 * Enqueue an on-demand job for the requested (not-yet-available) language and
 * map the coalescing helper's result to a UI status (#388 phase 2 / #389 Part
 * A). The helper never bumps `generation` and coalesces onto any in-flight or
 * completed job, so calling it on repeated views is safe.
 *
 *   - `seeded` / `requeued` → `queued`
 *   - `coalesced` → the existing job's status (`queued` | `processing` | `done`)
 *   - `source_pending` → the bucket's settle window has not elapsed; no job
 *   - `state_not_found` / `source_unavailable` → no job applies (null)
 *
 * The transient `queued`/`processing` states are then polled to `done`/`failed`
 * by the page's status endpoint; this initial value just seeds the UI.
 */
async function enqueueRequestedLanguage(
  authPool: ReturnType<typeof getAuthPool>,
  variant: {
    customerId: string;
    period: string;
    bucketDate: string;
    tz: string;
    lang: string;
    modelName: string;
    model: string;
  },
): Promise<LanguageJobStatus | null> {
  // Best-effort: the English fallback content is already in hand, so a
  // transient enqueue failure must NOT 500 the page — it degrades to "no job
  // status" (the fallback notice still shows, just without the on-demand
  // progress banner). The read-only status poller retries the next view.
  let result: Awaited<ReturnType<typeof enqueueOnDemandReportJob>>;
  try {
    result = await enqueueOnDemandReportJob(authPool, variant);
  } catch {
    return null;
  }
  switch (result.action) {
    case "seeded":
    case "requeued":
      return "queued";
    case "coalesced":
      return result.status as LanguageJobStatus;
    case "source_pending":
      return "source_pending";
    default:
      return null;
  }
}

/**
 * Display fields fetched from a leaf table at the pinned variant, used to
 * populate Sources cards. `superseded` is read from the same row so a
 * superseded pin degrades to ID/generation only. `null` (not this shape)
 * is used when no row exists at the pinned variant at all.
 */
interface LeafDisplayRow {
  priorityTier: PriorityTier;
  severityScore: number;
  likelihoodScore: number;
  ttpTags: string[];
  superseded: boolean;
}

/**
 * The token map plus the per-leaf display rows, aligned positionally with
 * the input `storyRefs` / `eventRefs` (a `null` entry means no row exists
 * at the pinned variant).
 */
interface ReportLeafData {
  plaintextByReportToken: Map<string, string>;
  storyDisplays: Array<LeafDisplayRow | null>;
  eventDisplays: Array<LeafDisplayRow | null>;
}

/**
 * Re-derive the report token → plaintext map by replaying
 * `buildReportTokenMap` over the cited leaf narratives (pinned by
 * generation), then resolving each leaf's source token through the
 * relevant event redaction map. The result is keyed by the report-scope
 * token string so `restoreReportAnalysisTokens` can substitute directly.
 *
 * The same per-leaf SELECTs also return the Sources-panel display fields
 * (tier / scores / TTP / `superseded_at`) at the pinned variant (T1), so
 * the cited-source display data costs no extra round-trips.
 */
async function buildReportTokenPlaintext(
  // biome-ignore lint/suspicious/noExplicitAny: pg Pool minimal surface
  customerPool: any,
  customerId: string,
  storyRefs: StoryRef[],
  eventRefs: EventRef[],
  variant: { lang: string; modelName: string; model: string },
): Promise<ReportLeafData> {
  const out = new Map<string, string>();
  const storyDisplays: Array<LeafDisplayRow | null> = [];
  const eventDisplays: Array<LeafDisplayRow | null> = [];
  if (storyRefs.length === 0 && eventRefs.length === 0) {
    return { plaintextByReportToken: out, storyDisplays, eventDisplays };
  }

  // Fetch story leaf narratives + their member refs at the pinned
  // generation AND the report variant. `generation` is variant-scoped
  // (the PK includes lang/model_name/model), so an English and a Korean
  // leaf can both be generation 1 for the same story/event; without the
  // variant predicates a LIMIT 1 could replay the wrong variant's text and
  // either mis-restore or leave report tokens visible (#297 review round
  // 1, item 3).
  const storyLeaves: Array<{
    analysis: string;
    severityFactors: string[];
    likelihoodFactors: string[];
  }> = [];
  const storyMemberRefs: Array<
    Array<{ index: number; aiceId: string; eventKey: string }>
  > = [];
  for (const ref of storyRefs) {
    const { rows } = await customerPool.query(
      `SELECT analysis_text, severity_factors, likelihood_factors,
              input_event_refs, priority_tier, severity_score,
              likelihood_score, ttp_tags, superseded_at
         FROM story_analysis_result
        WHERE customer_id = $1 AND story_id = $2::bigint AND generation = $3
          AND lang = $4 AND model_name = $5 AND model = $6
        LIMIT 1`,
      [
        customerId,
        ref.story_id,
        ref.generation,
        variant.lang,
        variant.modelName,
        variant.model,
      ],
    );
    storyLeaves.push({
      analysis: rows[0]?.analysis_text ?? "",
      severityFactors: Array.isArray(rows[0]?.severity_factors)
        ? rows[0].severity_factors
        : [],
      likelihoodFactors: Array.isArray(rows[0]?.likelihood_factors)
        ? rows[0].likelihood_factors
        : [],
    });
    storyMemberRefs.push(
      Array.isArray(rows[0]?.input_event_refs) ? rows[0].input_event_refs : [],
    );
    storyDisplays.push(toLeafDisplay(rows[0]));
  }

  // Fetch event leaf narratives + factors at the pinned generation AND
  // variant.
  const eventLeaves: Array<{
    analysis: string;
    severityFactors: string[];
    likelihoodFactors: string[];
  }> = [];
  for (const ref of eventRefs) {
    const { rows } = await customerPool.query(
      `SELECT analysis_text, severity_factors, likelihood_factors,
              priority_tier, severity_score, likelihood_score, ttp_tags,
              superseded_at
         FROM event_analysis_result
        WHERE aice_id = $1 AND event_key = $2::numeric AND generation = $3
          AND lang = $4 AND model_name = $5 AND model = $6
        LIMIT 1`,
      [
        ref.aice_id,
        ref.event_key,
        ref.generation,
        variant.lang,
        variant.modelName,
        variant.model,
      ],
    );
    eventLeaves.push({
      analysis: rows[0]?.analysis_text ?? "",
      severityFactors: Array.isArray(rows[0]?.severity_factors)
        ? rows[0].severity_factors
        : [],
      likelihoodFactors: Array.isArray(rows[0]?.likelihood_factors)
        ? rows[0].likelihood_factors
        : [],
    });
    eventDisplays.push(toLeafDisplay(rows[0]));
  }

  // Replay the rewrite to recover the report→source token map per leaf.
  // The analysis AND the factor arrays are replayed in the SAME order the
  // builder fed them (analysis first, then severity, then likelihood —
  // see `report-input-builder.ts` and `rewriteLeafFields`), so the
  // per-leaf `R{j}_SEQ` numbering matches exactly. Factors must be
  // replayed too: aimer is allowed to quote a leaf factor verbatim, so a
  // factor-only report token can land in the stored sections and would be
  // left undecoded if only the narratives were replayed (#297 review
  // round 2, item 1).
  const { refs } = buildReportTokenMap(storyLeaves, eventLeaves);

  // Decrypt every referenced event redaction map once, keyed by
  // (aice_id, event_key).
  const wanted = new Set<string>();
  for (const memberRefs of storyMemberRefs) {
    for (const m of memberRefs) wanted.add(`${m.aiceId}:${m.eventKey}`);
  }
  for (const ref of eventRefs) wanted.add(`${ref.aice_id}:${ref.event_key}`);
  const mapByKey = await decryptMaps(customerPool, customerId, wanted);

  for (const leaf of refs) {
    const memberRefs =
      leaf.kind === "story" ? storyMemberRefs[leaf.index - 1] : null;
    const eventRef =
      leaf.kind === "event"
        ? eventRefs[leaf.index - storyRefs.length - 1]
        : null;
    for (const { reportToken, sourceToken } of leaf.tokens) {
      let plaintext: string | undefined;
      if (leaf.kind === "story" && memberRefs) {
        const m = STORY_SOURCE_RE.exec(sourceToken);
        if (m) {
          const kind = m[1];
          const memberIdx = Number(m[2]);
          const nnn = m[3];
          const member = memberRefs.find((r) => r.index === memberIdx);
          if (member) {
            const map = mapByKey.get(`${member.aiceId}:${member.eventKey}`);
            plaintext = map?.[`<<REDACTED_${kind}_${nnn}>>`]?.value;
          }
        }
      } else if (leaf.kind === "event" && eventRef) {
        const m = EVENT_SOURCE_RE.exec(sourceToken);
        if (m) {
          const map = mapByKey.get(`${eventRef.aice_id}:${eventRef.event_key}`);
          plaintext = map?.[sourceToken]?.value;
        }
      }
      if (plaintext !== undefined) out.set(reportToken, plaintext);
    }
  }
  return { plaintextByReportToken: out, storyDisplays, eventDisplays };
}

/**
 * Map a leaf result row (or `undefined` when no row exists at the pinned
 * variant) to the Sources-card display fields. A present row carries its
 * `superseded_at` so the caller can degrade a superseded pin; a missing
 * row maps to `null`.
 */
function toLeafDisplay(
  // biome-ignore lint/suspicious/noExplicitAny: pg row minimal surface
  row: any,
): LeafDisplayRow | null {
  if (!row) return null;
  return {
    priorityTier: row.priority_tier as PriorityTier,
    severityScore: row.severity_score,
    likelihoodScore: row.likelihood_score,
    ttpTags: Array.isArray(row.ttp_tags) ? row.ttp_tags : [],
    superseded: row.superseded_at != null,
  };
}

async function decryptMaps(
  // biome-ignore lint/suspicious/noExplicitAny: pg Pool minimal surface
  customerPool: any,
  customerId: string,
  wanted: ReadonlySet<string>,
): Promise<Map<string, RedactionMap>> {
  const result = new Map<string, RedactionMap>();
  if (wanted.size === 0) return result;
  const pairs = Array.from(wanted).map((k) => {
    const [aiceId, eventKey] = k.split(":");
    return { aiceId, eventKey };
  });
  const { rows } = await customerPool.query(
    `SELECT aice_id::text AS aice_id, event_key::text AS event_key,
            ciphertext, wrapped_dek
       FROM event_redaction_map
      WHERE (aice_id, event_key) IN (${pairs
        .map((_, i) => `($${i * 2 + 1}::text, $${i * 2 + 2}::numeric)`)
        .join(", ")})`,
    pairs.flatMap((p) => [p.aiceId, p.eventKey]),
  );
  for (const r of rows as Array<{
    aice_id: string;
    event_key: string;
    ciphertext: Buffer;
    wrapped_dek: string;
  }>) {
    try {
      const map = await decryptRedactionMap(
        customerId,
        r.ciphertext,
        r.wrapped_dek,
      );
      result.set(`${r.aice_id}:${r.event_key}`, map);
    } catch {
      // Decrypt failure — leave those tokens unresolved (passed through).
    }
  }
  return result;
}
