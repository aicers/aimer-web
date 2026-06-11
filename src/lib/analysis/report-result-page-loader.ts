// Server-side loader for the periodic report detail page
// (`/[locale]/subjects/{customerId}/analysis/reports/{period}/{bucketDate}`).
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

import type { Pool } from "pg";
import {
  type AppLocale,
  appLocaleToReportLanguage,
  isSupportedLocale,
  type ReportLanguage,
  reportLanguageToAppLocale,
} from "@/i18n/locale";
import { authorize, isAnalystForCustomer } from "@/lib/auth/authorization";
import { getAuthCookie } from "@/lib/auth/cookies";
import { resolveGroupReadOutcome } from "@/lib/auth/group-authorization";
import { verifyJwtFull } from "@/lib/auth/jwt";
import { getSessionPolicy } from "@/lib/auth/session-policy";
import { validateSession } from "@/lib/auth/session-validator";
import { getAuthPool, withTransaction } from "@/lib/db/client";
import { getCustomerRuntimePool } from "@/lib/db/customer-runtime-pool";
import {
  type MemberPool,
  resolveSubjectPools,
  type SubjectKind,
} from "@/lib/db/subject-runtime-pool";
import { decryptRedactionMap, type RedactionMap } from "@/lib/redaction";
import {
  resolveDefaultModel,
  resolveGlobalDefaultModel,
} from "./default-model";
import { lookupTtpName } from "./mitre-ttp";
import type { PriorityTier } from "./priority-tier";
import { wireCustomerId } from "./report-input-builder";
import { buildReportTokenMap } from "./report-token";
import { restoreReportAnalysisTokens } from "./report-token-restore";
import { enqueueOnDemandReportJob } from "./report-worker";

// English is the guaranteed baseline language (parent #386): the worker
// always seeds it, so it is the second link in the fallback chain
// (requested → English → any available). This is NOT `ANALYSIS_DEFAULT_LANG`:
// L2 defaults the report language to the *viewer's* locale, not the
// deployment's configured generation default (#388 scope).
const ENGLISH_BASELINE: ReportLanguage = "ENGLISH";

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

// The factor sentinel the score-factor filter emits when nothing survives.
// MUST match `report-input-builder.ts` so the loader's exemplar `factor`
// replay folds to the identical report-scope token numbering (#495).
const INSUFFICIENT_EVIDENCE_SENTINEL = "insufficient evidence";

/** The single `factor` an exemplar leaf surfaced: `severity_factors[0]`,
 *  falling back to `likelihood_factors[0]` on the "insufficient evidence"
 *  sentinel (or absence). Mirrors the builder's `chooseExemplarFactor`. */
function chooseExemplarFactor(
  // biome-ignore lint/suspicious/noExplicitAny: pg row minimal surface
  row: any,
): string {
  const sev: string[] = Array.isArray(row?.severity_factors)
    ? row.severity_factors
    : [];
  const lik: string[] = Array.isArray(row?.likelihood_factors)
    ? row.likelihood_factors
    : [];
  const s = sev[0];
  if (s !== undefined && s !== INSUFFICIENT_EVIDENCE_SENTINEL) return s;
  if (lik[0] !== undefined) return lik[0];
  return s ?? "";
}

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
  | {
      sourceType: "story";
      storyId: string;
      /**
       * The owning member's customer id (#513): for a group report a cited
       * leaf lives in a MEMBER customer DB, and its detail page is the
       * member-customer detail, not the group subject. Provenance links are
       * built against this id. For a single-customer report it is the report's
       * own customer id, so links are unchanged.
       */
      customerId: string;
      variant: CitedLeafVariant;
    }
  | {
      sourceType: "event";
      aiceId: string;
      eventKey: string;
      /** Owning member customer id — see the story variant. */
      customerId: string;
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
  /**
   * The owning member's customer id (#513): for a group report the cited leaf
   * lives in a MEMBER customer DB, so its Sources-card link targets the
   * member-customer detail, not the group subject. For a single-customer report
   * it is the report's own customer id, so the link is byte-identical to the
   * pre-#513 behavior.
   */
  customerId: string;
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
  /** Owning member customer id — see {@link CitedStorySource.customerId}. */
  customerId: string;
  variant: CitedLeafVariant;
  /**
   * Event-level fields (#552) used to title the card `{event time} · {kind
   * display name}`. Read off the resolved leaf row even when superseded since
   * they are variant-independent; `eventTime` null (no row at all) falls back
   * to the static label. NOT inside `display` (which is null when the pinned
   * row is superseded) — the title should survive that case.
   */
  eventTime: Date | null;
  kind: string | null;
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
   * Hybrid-scoring coverage indicator (#465 Scope 6): how many of the cited
   * leaves are on the report's own model (`reportModel`) versus the total
   * selected (`total`). Under the never-drop fallback a default report can cite
   * leaves from other models, but the aggregate scores are calibrated from the
   * report-model subset only — this surfaces the gap honestly ("scores from N
   * of M leaves"). Derived read-time from `input_*_refs` by comparing each
   * ref's model against the row's, so no DB column is added and audit rows stay
   * immutable. Exposes COUNTS only, never the score-combination method (#386).
   */
  leafCoverage: { reportModel: number; total: number };
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
  /**
   * The report subject (kind + id) (#525). A `customer` subject keeps the
   * single-customer behavior end to end; a `group` subject reads the result
   * row from the group's dedicated DB (via the #523 subject resolver) and
   * fans de-redaction out across the member customer DBs. Optional for
   * backward compatibility: when omitted the subject is `customerId` as a
   * `customer` (the single-customer default the route passes today). When
   * present for a `customer`, `id` MUST equal `customerId`; for a `group`,
   * `id` is the group subject id and `customerId` is ignored by the group
   * path (the route that reaches the loader for a group is #513).
   */
  subject?: { kind: SubjectKind; id: string };
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

// Stored `input_*_refs` shapes. `model_name`/`model` are the leaf's OWN model
// (#465) — under the never-drop fallback it can differ from the report row's.
interface StoryRef {
  story_id: string;
  generation: number;
  model_name: string;
  model: string;
  // Member subject id of the customer DB this leaf lives in (#523). A group
  // report cites leaves from MEMBER DBs and the same `story_id` can exist in
  // more than one, so de-redaction routes by it. On a single-customer report
  // it equals the report's own subject id.
  customer_id: string;
}
interface EventRef {
  aice_id: string;
  event_key: string;
  generation: number;
  model_name: string;
  model: string;
  // Member subject id, same contract as `StoryRef` (#523).
  customer_id: string;
}
// Long-tail exemplar leaf ref (#495). There is no `lang` — exemplar leaves are
// always replayed at the English canonical language regardless of the row's
// `lang` / `restoration_lang`.
interface ExemplarRef {
  aice_id: string;
  event_key: string;
  generation: number;
  model_name: string;
  model: string;
  // Member subject id, same contract as `StoryRef` (#523).
  customer_id: string;
}

// Wire form of a citation `source` as aimer emits it inside `sections_jsonb`
// (#449): a discriminated union on `type` carrying an opaque leaf identifier.
// `story_id` / `event_ref` are the exact strings aimer-web sent in the input
// bundle; `event_ref` is the packed `"{aice_id}:{event_key}"` token and is
// never split here — the loader resolves it through the input refs instead.
//
// `customer_id` is the optional member identity of a group citation (#525):
// the same `story_id` / `(aice_id, event_key)` can exist in more than one
// member DB, so the input-ref lookup is keyed by `(customer_id, …)`. The
// single-customer wire shape omits it by design, resolving to the report's own
// subject id (`wireCustomerId`) — byte-identical to the pre-#525 single-key
// behavior.
type WireUnitSource =
  | { type: "story"; story_id: string; customer_id?: string }
  | { type: "event"; event_ref: string; customer_id?: string };

// Wire form of a render unit before token restoration / source decoding.
interface WireCitationUnit {
  text?: unknown;
  source?: unknown;
}

// Raw `sections_jsonb` as stored from aimer's JSON. Typed loosely because the
// column is untyped JSON and the native path persists `parseReportSections`
// output after a top-level-object check only — per-section shapes are guarded
// at read time (see `restoreUnits` / `restoreJoined`).
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

  // The report subject (#525): a `customer` subject keeps the single-customer
  // path end to end; a `group` subject reads the result row from the group's
  // dedicated DB and fans de-redaction out across the member DBs below. When
  // the caller omits `subject`, the subject is `customerId` as a customer (the
  // single-customer default the route passes today).
  const subjectKind: SubjectKind = input.subject?.kind ?? "customer";
  const subjectId = input.subject?.id ?? input.customerId;

  // Resolve the subject's pools up front: the RESULT DB (the customer DB for a
  // `customer` subject, the group DB for a `group` subject) and, for a group,
  // the ordered MEMBER pools the display fans de-redaction out over. The group
  // result-DB selection is routed through the #523 subject resolver (the single
  // subject-kind seam), not a raw `getGroupRuntimePool` branch. The customer
  // path keeps the existing direct `getCustomerRuntimePool` — behavior-
  // identical, and with no extra `subjects` round-trip on the hot path — with
  // the subject modeled as its own sole "member" so the fan-out collapses to a
  // single pool unchanged.
  let resultPool: Pool;
  let memberPools: MemberPool[];
  if (subjectKind === "customer") {
    resultPool = getCustomerRuntimePool(subjectId);
    memberPools = [{ customerId: subjectId, pool: resultPool }];
  } else {
    try {
      const resolved = await resolveSubjectPools(authPool, subjectId);
      resultPool = resolved.resultPool;
      memberPools = resolved.memberPools;
    } catch {
      // An unknown subject (or a group with no row) is an integrity miss;
      // surface it as existence-hiding 404 rather than a 500.
      return { kind: "not_found" };
    }
  }
  const memberIds = memberPools.map((m) => m.customerId);

  // Resolve authorization AND the analyst-assignment signal in one
  // transaction so the analyst predicate reuses the already-acquired
  // connection (#457): no extra checkout, no extra auth handshake. The
  // flag is only meaningful when authorized, so it is computed only then.
  let isViewerAnalyst = false;
  if (subjectKind === "customer") {
    const { auth, analyst } = await withTransaction(
      authPool,
      async (client) => {
        const auth = await authorize(
          client,
          "general",
          claims.sub,
          "reports:read",
          {
            customerId: subjectId,
            operationKind: "read",
            // Bridge sessions cannot read these surfaces (round-15 S3): an
            // in-scope bridge → 403, mirroring the regenerate/summary endpoints.
            allowInBridge: false,
            bridgeScope: bridgeCustomerIds
              ? { aiceId: bridgeAiceId ?? "", customerIds: bridgeCustomerIds }
              : null,
          },
        );
        const analyst = auth.authorized
          ? await isAnalystForCustomer(client, claims.sub, subjectId)
          : false;
        return { auth, analyst };
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
    isViewerAnalyst = analyst;
  } else {
    // Group: require `reports:read` on EVERY member, preserving the same
    // existence-hiding mapping (non-member of any → 404, member-without-
    // permission → 403). A bridge session is denied outright — `allowInBridge:
    // false` is NOT loosened for groups, so an in-scope bridge → 403 exactly as
    // on the customer path.
    if (bridgeCustomerIds !== null) return { kind: "forbidden" };
    const outcome = await withTransaction(authPool, (client) =>
      resolveGroupReadOutcome(client, claims.sub, memberIds, "reports:read"),
    );
    if (outcome === "not_found") return { kind: "not_found" };
    if (outcome === "forbidden") return { kind: "forbidden" };
    // The analyst-only compare column / provenance gate is OFF for a group in
    // v1 (no single-customer analyst signal applies to a group subject; the
    // compare column is disabled below), so the flag stays false.
    isViewerAnalyst = false;
  }

  // Variant resolution: each selector falls back to its default when the
  // caller did not pin it. Default tz = the subject's current timezone
  // snapshot (`customers.timezone` for a customer, `customer_groups.tz` for a
  // group — B1, #506); model_name/model default to the subject's resolved
  // default so the page and the coverage indicator below agree on which
  // variant is "the default". A customer uses the three-tier resolution (#473:
  // per-customer override → admin global → env); a group uses the global/env-
  // only policy (#524 — the per-customer `customer_default_model` join does not
  // match a group subject), so display and generation agree on "the default".
  let tz: string;
  if (input.variant?.tz) {
    tz = input.variant.tz;
  } else if (subjectKind === "customer") {
    const tzRow = await authPool.query<{ timezone: string }>(
      `SELECT timezone FROM customers WHERE id = $1`,
      [subjectId],
    );
    tz = tzRow.rows[0]?.timezone ?? "UTC";
  } else {
    const tzRow = await authPool.query<{ tz: string }>(
      `SELECT tz FROM customer_groups WHERE id = $1`,
      [subjectId],
    );
    tz = tzRow.rows[0]?.tz ?? "UTC";
  }
  const defaultPair =
    subjectKind === "customer"
      ? await resolveDefaultModel(subjectId, authPool)
      : await resolveGlobalDefaultModel(authPool, subjectId);
  const modelName = input.variant?.model_name ?? defaultPair.modelName;
  const model = input.variant?.model ?? defaultPair.model;

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
      WHERE subject_id = $1 AND period = $2
        AND bucket_date = $3::date AND tz = $4`,
    [subjectId, input.period, input.bucketDate, tz],
  );
  if (stateRows.rows.length === 0) return { kind: "not_found" };
  if (stateRows.rows[0].status === "archived") return { kind: "not_found" };

  // The bucket's available-language set for this `(tz, model_name, model)`
  // variant — drives both the switcher and the fallback chain. Scoped to
  // non-superseded rows so it matches what the result query below can fetch.
  // Read from the RESULT DB (the group DB for a group subject), keyed by the
  // subject id.
  const availLangRows = await resultPool.query<{ lang: string }>(
    `SELECT DISTINCT lang FROM periodic_report_result
      WHERE subject_id = $1 AND period = $2
        AND bucket_date = $3::date AND tz = $4
        AND model_name = $5 AND model = $6
        AND superseded_at IS NULL`,
    [subjectId, input.period, input.bucketDate, tz, modelName, model],
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
    // In that case (phase 2) the customer path enqueues the requested variant
    // on-demand and surfaces its job status; repeated views coalesce (no
    // generation bump). For a GROUP subject the policy is stored-variants-only
    // (#525 default (a)): the customer-keyed `enqueueOnDemandReportJob` does
    // not apply to a group subject and #524's subject-aware enqueue is not yet
    // available, so the switcher offers only already-generated languages and
    // no on-demand job is created (`jobStatus` stays null). The fallback notice
    // still renders, just without an on-demand progress banner.
    if (shownLang !== requestedLang) {
      const jobStatus =
        subjectKind === "customer"
          ? await enqueueRequestedLanguage(authPool, {
              customerId: subjectId,
              period: input.period,
              bucketDate: input.bucketDate,
              tz,
              lang: requestedLang,
              modelName,
              model,
            })
          : null;
      languageFallback = {
        requestedLocale,
        shownLocale: reportLanguageToAppLocale(shownLang as ReportLanguage),
        jobStatus,
      };
    }
  }

  const resultRow = await resultPool.query<ReportResultRow>(
    // Pinned path: target the exact generation and read `superseded_at`
    // so a superseded pin degrades to the notice; unpinned path keeps the
    // latest-non-superseded behavior. `superseded_at` is selected
    // uniformly to keep one row shape (it is NULL on the unpinned path by
    // construction). The column list is shared with the compare lookup.
    pinnedGeneration === null
      ? `SELECT ${REPORT_RESULT_COLUMNS}
           FROM periodic_report_result
          WHERE subject_id = $1 AND period = $2
            AND bucket_date = $3::date AND tz = $4
            AND lang = $5 AND model_name = $6 AND model = $7
            AND superseded_at IS NULL
          ORDER BY generation DESC
          LIMIT 1`
      : `SELECT ${REPORT_RESULT_COLUMNS}
           FROM periodic_report_result
          WHERE subject_id = $1 AND period = $2
            AND bucket_date = $3::date AND tz = $4
            AND lang = $5 AND model_name = $6 AND model = $7
            AND generation = $8
          LIMIT 1`,
    pinnedGeneration === null
      ? [
          subjectId,
          input.period,
          input.bucketDate,
          tz,
          shownLang,
          modelName,
          model,
        ]
      : [
          subjectId,
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
  const exemplarRefs = Array.isArray(row.input_exemplar_refs)
    ? row.input_exemplar_refs
    : [];

  // `restoration_lang` pins the language whose cited leaves are replayed to
  // restore the report-scope tokens: NULL replays at the row's own `lang`
  // (native), a non-null enum (e.g. ENGLISH for a translated row) replays
  // the canonical's leaves, which the translated row's copied `input_*_refs`
  // point at (#412 item 5). `model_name` / `model` are the canonical's on a
  // translated row (copied verbatim), so the pinned leaves resolve.
  const replayLang = row.restoration_lang ?? row.lang;
  // Member fan-out routing: map each ref's owning `customer_id` to the member
  // pool that holds its leaf + redaction maps. For a customer subject this is
  // the single result pool (every ref carries `subjectId`); for a group, the
  // per-member pools resolved above. A ref naming a non-member id resolves to
  // `undefined` and degrades (its tokens stay tokenized rather than 500ing).
  const memberPoolById = new Map(
    memberPools.map((m) => [m.customerId, m.pool]),
  );
  const poolFor = (cid: string): Pool | undefined => memberPoolById.get(cid);
  const { plaintextByReportToken, storyDisplays, eventDisplays } =
    await buildReportTokenPlaintext(
      poolFor,
      storyRefs,
      eventRefs,
      exemplarRefs,
      replayLang,
    );

  // Build the report-level cited sources: each stored ref + the display
  // fields fetched at the pinned variant. A missing or superseded leaf row
  // degrades the card to ID/generation only (display = null).
  const citedSources: CitedSources = {
    stories: storyRefs.map((ref, i) => {
      const d = storyDisplays[i];
      return {
        storyId: ref.story_id,
        // The owning member customer id (#513): equals `subjectId` for a
        // single-customer ref, so the link is unchanged there.
        customerId: ref.customer_id,
        variant: {
          generation: ref.generation,
          lang: replayLang,
          // Each citation resolves to its ref's OWN model (#465 Scope 4): a
          // fallback leaf lives under a different model than the report row.
          modelName: ref.model_name,
          model: ref.model,
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
        customerId: ref.customer_id,
        variant: {
          generation: ref.generation,
          lang: replayLang,
          modelName: ref.model_name,
          model: ref.model,
        },
        // Event-level (#552): surfaced off the resolved row even when
        // superseded; `null` only when no row exists at the pinned variant.
        eventTime: d?.eventTime ?? null,
        kind: d?.kind ?? null,
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
    subjectId,
  );

  // Coverage indicator (#465 Scope 6): count cited leaves on the report's own
  // model vs the total. Counts only — never the score-combination method
  // (#386).
  const allRefs: Array<{ model_name: string; model: string }> = [
    ...storyRefs,
    ...eventRefs,
  ];
  const leafCoverage = {
    reportModel: allRefs.filter(
      (r) => r.model_name === row.model_name && r.model === row.model,
    ).length,
    total: allRefs.length,
  };

  // Analyst-only compare column (#458): an EXACT, side-effect-free lookup of
  // the compare model at the primary's shown language. It deliberately does
  // NOT reuse the primary resolution above (which enqueues an on-demand job on
  // language fallback) — Scope 3 requires "render stored variants only / never
  // auto-generate". Only honored on the unpinned path and only for analysts.
  //
  // DISABLED for a `group` subject in v1 (#525): the compare replay would need
  // the same per-member de-redaction fan-out as the primary column, and the
  // group analyst-provenance gate is off (`isViewerAnalyst` is false for a
  // group), so the gate below never opens for a group. The `subjectKind` guard
  // makes that explicit and robust against a future analyst signal.
  let compare: ReportCompareOutcome | undefined;
  if (
    subjectKind === "customer" &&
    input.compare &&
    isViewerAnalyst &&
    pinnedGeneration === null
  ) {
    compare = await resolveReportCompareColumn(resultPool, subjectId, {
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
      // The report subject id — the customer id for a customer subject, the
      // group id for a group subject (#525).
      customerId: subjectId,
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
      leafCoverage,
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
  input_exemplar_refs: ExemplarRef[] | null;
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
        input_story_refs, input_event_refs, input_exemplar_refs, superseded_at,
        requested_by::text AS requested_by, requested_at`;

/**
 * Compose a member-qualified map key (#525): `(customer_id, rest)` joined by a
 * NUL separator. Neither a customer UUID nor a `story_id` / packed
 * `"{aice_id}:{event_key}"` ref contains a NUL, so the boundary is
 * unambiguous and same-`rest`-across-members keys never collide.
 */
function memberKey(customerId: string, rest: string): string {
  return `${customerId}\u0000${rest}`;
}

/**
 * Restore a report result row's five display sections from the report→source
 * token map (#449). Pure (no DB): the three leaf-derived sections become
 * arrays of citation units with decoded sources, while
 * `baseline_observations` / `period_outlook` join into display blocks. Shared
 * by the primary render and the read-only compare column (#458).
 */
function restoreReportSectionsFromRow(
  row: Pick<ReportResultRow, "sections_jsonb">,
  replayLang: string,
  storyRefs: StoryRef[],
  eventRefs: EventRef[],
  plaintextByReportToken: Map<string, string>,
  subjectId: string,
): ReportSections {
  const restoreOne = (s: unknown) =>
    restoreReportAnalysisTokens(
      typeof s === "string" ? s : "",
      plaintextByReportToken,
    );
  // `baseline_observations` (canonically an array of Markdown strings) and
  // `period_outlook` (canonically a plain string) are NOT leaf-derived and
  // carry no citations: restore each entry and join into one display block.
  // The write path validates neither field (both sit outside
  // `LEAF_DERIVED_SECTION_KEYS` and `parseReportSections` checks only the top
  // level), so a minimal type guard handles either shape rather than trusting
  // the canonical one.
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
  //
  // Keyed by `(customer_id, …)` (#525): the same `story_id` / `(aice_id,
  // event_key)` can exist in more than one member DB for a group report, so a
  // bare key collides and mis-routes. The member id is the input ref's own
  // `customer_id`, and `wireCustomerId(wire, subjectId)` for the citation —
  // the single-customer wire shape omits `customer_id` by design and resolves
  // to `subjectId`, so a single-customer report keys identically to the
  // pre-#525 bare-key behavior.
  const storyRefByKey = new Map(
    storyRefs.map((r) => [memberKey(r.customer_id, r.story_id), r]),
  );
  const eventRefByKey = new Map(
    eventRefs.map((r) => [
      memberKey(r.customer_id, `${r.aice_id}:${r.event_key}`),
      r,
    ]),
  );
  const decodeSource = (raw: unknown): CitedUnitSource | undefined => {
    if (raw === null || typeof raw !== "object") return undefined;
    const wire = raw as Partial<WireUnitSource>;
    const sourceCustomerId = wireCustomerId(wire, subjectId);
    if (wire.type === "story" && typeof wire.story_id === "string") {
      const ref = storyRefByKey.get(memberKey(sourceCustomerId, wire.story_id));
      // Drop a citation whose leaf is not in the input bundle rather than
      // render a dangling link (the worker already rejects fabricated sources
      // before persisting; this is the read-path defensive degrade).
      if (!ref) return undefined;
      return {
        sourceType: "story",
        storyId: ref.story_id,
        // Owning member customer id (#513) — the source key's resolved member,
        // `subjectId` for a single-customer source.
        customerId: sourceCustomerId,
        variant: {
          generation: ref.generation,
          lang: replayLang,
          // Per-ref model (#465 Scope 4).
          modelName: ref.model_name,
          model: ref.model,
        },
      };
    }
    if (wire.type === "event" && typeof wire.event_ref === "string") {
      // `event_ref` is opaque; resolve it through the input refs by the same
      // packed key the builder emitted (member-qualified, #525) instead of
      // splitting on `:` (robust even if an `aice_id` ever contained a colon).
      const ref = eventRefByKey.get(
        memberKey(sourceCustomerId, wire.event_ref),
      );
      if (!ref) return undefined;
      return {
        sourceType: "event",
        aiceId: ref.aice_id,
        eventKey: ref.event_key,
        customerId: sourceCustomerId,
        variant: {
          generation: ref.generation,
          lang: replayLang,
          modelName: ref.model_name,
          model: ref.model,
        },
      };
    }
    return undefined;
  };
  // The three leaf-derived sections are arrays of `{ text, source? }` units
  // (prompt v5). Restore each unit's text and decode its source, preserving
  // per-unit boundaries so a citation can anchor to one. `sections_jsonb` is
  // untyped JSON and the native path enforces no per-section shape, so a
  // minimal type guard remains: a non-array section (or a non-object entry)
  // yields no units rather than throwing.
  const restoreUnits = (v: unknown): CitationUnit[] => {
    if (!Array.isArray(v)) return [];
    const units: CitationUnit[] = [];
    for (const item of v) {
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
      WHERE subject_id = $1 AND period = $2
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
  const exemplarRefs = Array.isArray(row.input_exemplar_refs)
    ? row.input_exemplar_refs
    : [];
  const replayLang = row.restoration_lang ?? row.lang;
  // The compare column is customer-only (disabled for groups in v1, #525), so
  // the member fan-out collapses to the single customer pool: every ref
  // carries the customer's own id. Enforce that the same way the primary
  // path does — any other id resolves no pool and the ref degrades to an
  // empty leaf — rather than routing every key to `customerPool`, which
  // would let a malformed ref reach the event/exemplar leaf queries (they
  // carry no customer_id predicate; the member identity IS the pool).
  const poolFor = (cid: string): Pool | undefined =>
    cid === customerId ? (customerPool as Pool) : undefined;
  const { plaintextByReportToken } = await buildReportTokenPlaintext(
    poolFor,
    storyRefs,
    eventRefs,
    exemplarRefs,
    replayLang,
  );
  const sections = restoreReportSectionsFromRow(
    row,
    replayLang,
    storyRefs,
    eventRefs,
    plaintextByReportToken,
    customerId,
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
  /**
   * Event-level fields (#552), populated for event leaves only (story leaf
   * SELECTs do not select them, so they stay `null`). Read off the resolved
   * row regardless of `superseded` since they are variant-independent.
   */
  eventTime: Date | null;
  kind: string | null;
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
 * Member fan-out (#525): each cited story / event / exemplar ref names the
 * owning member `customer_id` (the subject's own id on the single-customer
 * path). The leaf and its `event_redaction_map` live in that member's DB, so
 * refs are GROUPED by owning member and BOTH the
 * leaf reads AND the redaction-map decrypt run ONE batched query per member
 * pool — the leaf reads via a row-value `IN (...)` over each member's pinned
 * `(story_id|aice_id+event_key, generation, model_name, model)` tuples, the
 * maps via `decryptMaps`. Never an open-and-query per ref: a group report with
 * many refs in one member DB costs a single leaf round-trip there, not O(refs).
 * The decrypted maps are keyed by `(customer_id, aice_id:event_key)` so the
 * same `(aice_id, event_key)` in two member DBs routes to the right member's
 * plaintext. A story ref's member-event redaction lookups use the SAME member
 * DB as the story leaf (the story leaf and its member-event maps co-reside).
 * For a `customer` subject every ref carries the subject's own id and
 * `poolFor` returns the single result pool, so this collapses to one batched
 * leaf read plus one decrypt against that pool.
 *
 * The same batched leaf SELECTs also return the Sources-panel display fields
 * (tier / scores / TTP / `superseded_at`) at the pinned variant (T1), so
 * the cited-source display data costs no extra round-trips. Each returned row
 * is re-associated with its positional ref by `leafKey`, leaving
 * `storyDisplays` / `eventDisplays` aligned with the input ref arrays.
 */
async function buildReportTokenPlaintext(
  poolFor: (customerId: string) => Pool | undefined,
  storyRefs: StoryRef[],
  eventRefs: EventRef[],
  exemplarRefs: ExemplarRef[],
  replayLang: string,
): Promise<ReportLeafData> {
  const out = new Map<string, string>();
  const storyDisplays: Array<LeafDisplayRow | null> = storyRefs.map(() => null);
  const eventDisplays: Array<LeafDisplayRow | null> = eventRefs.map(() => null);
  if (
    storyRefs.length === 0 &&
    eventRefs.length === 0 &&
    exemplarRefs.length === 0
  ) {
    return { plaintextByReportToken: out, storyDisplays, eventDisplays };
  }

  // Per-leaf owning member customer id (#523/#525), aligned positionally with
  // each ref array. A single-customer ref carries the subject's own id.
  const storyCustomerIds = storyRefs.map((r) => r.customer_id);
  const eventCustomerIds = eventRefs.map((r) => r.customer_id);
  const exemplarCustomerIds = exemplarRefs.map((r) => r.customer_id);

  // Group ref positions by owning member so each member pool's leaf rows are
  // read with ONE batched query (#525) — the same per-member batching as the
  // `event_redaction_map` decrypt below, so a group report with many refs in
  // one member DB costs a single round-trip there, not O(refs). `poolFor`
  // resolves each member pool once; a ref naming a non-member id (no pool) is
  // skipped and degrades to an empty leaf, preserving positional alignment.
  const groupByCustomer = (
    ids: ReadonlyArray<string>,
  ): Map<string, number[]> => {
    const m = new Map<string, number[]>();
    for (let i = 0; i < ids.length; i++) {
      const list = m.get(ids[i]);
      if (list) list.push(i);
      else m.set(ids[i], [i]);
    }
    return m;
  };
  // Composite key re-associating a batched row with its positional ref. The
  // leaf PKs (story_id|aice_id+event_key, generation, model_name, model) are
  // unique within a (member, lang), so each ref tuple matches at most one row.
  const leafKey = (...parts: Array<string | number>): string =>
    parts.join("\u0000");

  // Fetch story leaf narratives + their member refs at the pinned
  // generation AND the report variant, from the OWNING member's DB.
  // `generation` is variant-scoped (the PK includes lang/model_name/model),
  // so an English and a Korean leaf can both be generation 1 for the same
  // story/event; without the variant predicates a LIMIT 1 could replay the
  // wrong variant's text and either mis-restore or leave report tokens visible
  // (#297 review round 1, item 3).
  const storyLeaves: Array<{
    analysis: string;
    severityFactors: string[];
    likelihoodFactors: string[];
  }> = storyRefs.map(() => ({
    analysis: "",
    severityFactors: [],
    likelihoodFactors: [],
  }));
  const storyMemberRefs: Array<
    Array<{ index: number; aiceId: string; eventKey: string }>
  > = storyRefs.map(() => []);
  for (const [cid, idxs] of groupByCustomer(storyCustomerIds)) {
    const pool = poolFor(cid);
    // A ref naming a non-member id (no pool) degrades to an empty leaf,
    // keeping `storyLeaves` / `storyDisplays` aligned with `storyRefs`.
    if (!pool) continue;
    // Pin each leaf by ITS OWN ref model (#465 Scope 4): a fallback leaf lives
    // under a different model than the report row, so a row-model pin would
    // return no row and leave report tokens unrestored / visible. All refs
    // owned by this member are batched into ONE row-value `IN (...)` keyed by
    // `(story_id, generation, model_name, model)` (`customer_id` / `lang` are
    // constant per member query) — no per-ref round-trip.
    const params: unknown[] = [cid, replayLang];
    const tuples = idxs.map((i) => {
      const ref = storyRefs[i];
      const base = params.length;
      params.push(ref.story_id, ref.generation, ref.model_name, ref.model);
      return `($${base + 1}::bigint, $${base + 2}::int, $${base + 3}::text, $${base + 4}::text)`;
    });
    const { rows } = await pool.query(
      `SELECT analysis_text, severity_factors, likelihood_factors,
              input_event_refs, priority_tier, severity_score,
              likelihood_score, ttp_tags, superseded_at,
              story_id::text AS story_id, generation, model_name, model
         FROM story_analysis_result
        WHERE customer_id = $1 AND lang = $2
          AND (story_id, generation, model_name, model) IN (${tuples.join(", ")})`,
      params,
    );
    const byKey = new Map<string, (typeof rows)[number]>();
    for (const r of rows) {
      byKey.set(leafKey(r.story_id, r.generation, r.model_name, r.model), r);
    }
    for (const i of idxs) {
      const ref = storyRefs[i];
      const row = byKey.get(
        leafKey(ref.story_id, ref.generation, ref.model_name, ref.model),
      );
      storyLeaves[i] = {
        analysis: row?.analysis_text ?? "",
        severityFactors: Array.isArray(row?.severity_factors)
          ? row.severity_factors
          : [],
        likelihoodFactors: Array.isArray(row?.likelihood_factors)
          ? row.likelihood_factors
          : [],
      };
      storyMemberRefs[i] = Array.isArray(row?.input_event_refs)
        ? row.input_event_refs
        : [];
      storyDisplays[i] = toLeafDisplay(row);
    }
  }

  // Fetch event leaf narratives + factors at the pinned generation AND
  // variant, from the owning member's DB.
  const eventLeaves: Array<{
    analysis: string;
    severityFactors: string[];
    likelihoodFactors: string[];
  }> = eventRefs.map(() => ({
    analysis: "",
    severityFactors: [],
    likelihoodFactors: [],
  }));
  for (const [cid, idxs] of groupByCustomer(eventCustomerIds)) {
    const pool = poolFor(cid);
    if (!pool) continue;
    // Per-ref model pin (#465 Scope 4), batched per member exactly like the
    // story leaves above. `event_analysis_result` is keyed by `aice_id` (not
    // `customer_id`), so the member identity is the pool; `lang` is constant.
    const params: unknown[] = [replayLang];
    const tuples = idxs.map((i) => {
      const ref = eventRefs[i];
      const base = params.length;
      params.push(
        ref.aice_id,
        ref.event_key,
        ref.generation,
        ref.model_name,
        ref.model,
      );
      return `($${base + 1}::text, $${base + 2}::numeric, $${base + 3}::int, $${base + 4}::text, $${base + 5}::text)`;
    });
    const { rows } = await pool.query(
      `SELECT analysis_text, severity_factors, likelihood_factors,
              priority_tier, severity_score, likelihood_score, ttp_tags,
              event_time, kind,
              superseded_at, aice_id, event_key::text AS event_key,
              generation, model_name, model
         FROM event_analysis_result
        WHERE lang = $1
          AND (aice_id, event_key, generation, model_name, model) IN (${tuples.join(", ")})`,
      params,
    );
    const byKey = new Map<string, (typeof rows)[number]>();
    for (const r of rows) {
      byKey.set(
        leafKey(r.aice_id, r.event_key, r.generation, r.model_name, r.model),
        r,
      );
    }
    for (const i of idxs) {
      const ref = eventRefs[i];
      const row = byKey.get(
        leafKey(
          ref.aice_id,
          ref.event_key,
          ref.generation,
          ref.model_name,
          ref.model,
        ),
      );
      eventLeaves[i] = {
        analysis: row?.analysis_text ?? "",
        severityFactors: Array.isArray(row?.severity_factors)
          ? row.severity_factors
          : [],
        likelihoodFactors: Array.isArray(row?.likelihood_factors)
          ? row.likelihood_factors
          : [],
      };
      eventDisplays[i] = toLeafDisplay(row);
    }
  }

  // Fetch the long-tail exemplar leaves (#495), reduced to the single chosen
  // `factor` the builder fed to `buildReportTokenMap`. Exemplar refs are
  // ALWAYS replayed at the English canonical language (`ENGLISH_BASELINE`),
  // independent of `replayLang` — the canonical owns the exemplar set + the
  // `R{j}` numbering, so even a Korean native-pinned row's exemplar tokens
  // were minted from the English leaves.
  const exemplarLeaves: Array<{ analysis: string }> = exemplarRefs.map(() => ({
    analysis: chooseExemplarFactor(undefined),
  }));
  for (const [cid, idxs] of groupByCustomer(exemplarCustomerIds)) {
    const pool = poolFor(cid);
    if (!pool) continue;
    // Batched per member like the cited leaves, but always pinned to the
    // English canonical `lang` (`ENGLISH_BASELINE`); `model_name` / `model`
    // are required on an exemplar ref so there is no variant fallback.
    const params: unknown[] = [ENGLISH_BASELINE];
    const tuples = idxs.map((i) => {
      const ref = exemplarRefs[i];
      const base = params.length;
      params.push(
        ref.aice_id,
        ref.event_key,
        ref.generation,
        ref.model_name,
        ref.model,
      );
      return `($${base + 1}::text, $${base + 2}::numeric, $${base + 3}::int, $${base + 4}::text, $${base + 5}::text)`;
    });
    const { rows } = await pool.query(
      `SELECT severity_factors, likelihood_factors,
              aice_id, event_key::text AS event_key, generation,
              model_name, model
         FROM event_analysis_result
        WHERE lang = $1
          AND (aice_id, event_key, generation, model_name, model) IN (${tuples.join(", ")})`,
      params,
    );
    const byKey = new Map<string, (typeof rows)[number]>();
    for (const r of rows) {
      byKey.set(
        leafKey(r.aice_id, r.event_key, r.generation, r.model_name, r.model),
        r,
      );
    }
    for (const i of idxs) {
      const ref = exemplarRefs[i];
      const row = byKey.get(
        leafKey(
          ref.aice_id,
          ref.event_key,
          ref.generation,
          ref.model_name,
          ref.model,
        ),
      );
      exemplarLeaves[i] = { analysis: chooseExemplarFactor(row) };
    }
  }

  // Replay the rewrite to recover the report→source token map per leaf.
  // The analysis AND the factor arrays are replayed in the SAME order the
  // builder fed them (analysis first, then severity, then likelihood —
  // see `report-input-builder.ts` and `rewriteLeafFields`), so the
  // per-leaf `R{j}_SEQ` numbering matches exactly. Factors must be
  // replayed too: aimer is allowed to quote a leaf factor verbatim, so a
  // factor-only report token can land in the stored sections and would be
  // left undecoded if only the narratives were replayed (#297 review
  // round 2, item 1). The exemplar leaves are appended last so their `R{j}`
  // numbering matches the builder's combined leaf set, and the resulting
  // exemplar token map is unioned into the cited one below.
  const { refs } = buildReportTokenMap(
    storyLeaves,
    eventLeaves,
    exemplarLeaves,
  );

  // Group every referenced event redaction map by its OWNING member customer
  // id (#525), then decrypt with ONE batched query per member pool — cited
  // events, story members, AND exemplar leaves. A story's member-event maps
  // belong to the SAME member DB as the story leaf, so they inherit the story
  // ref's customer id. Deduped per member by `aice_id:event_key`. The result
  // is a per-member map (`mapsByCustomer[cid]` → `aice_id:event_key` →
  // `RedactionMap`) so a same-`(aice_id, event_key)` key in two members never
  // collides.
  const wantedByCustomer = new Map<string, Map<string, EventKeyPair>>();
  const addWanted = (cid: string, aiceId: string, eventKey: string) => {
    let inner = wantedByCustomer.get(cid);
    if (!inner) {
      inner = new Map();
      wantedByCustomer.set(cid, inner);
    }
    inner.set(`${aiceId}:${eventKey}`, { aiceId, eventKey });
  };
  for (let i = 0; i < storyMemberRefs.length; i++) {
    const cid = storyCustomerIds[i];
    for (const m of storyMemberRefs[i]) addWanted(cid, m.aiceId, m.eventKey);
  }
  for (let i = 0; i < eventRefs.length; i++) {
    addWanted(
      eventCustomerIds[i],
      eventRefs[i].aice_id,
      eventRefs[i].event_key,
    );
  }
  for (let i = 0; i < exemplarRefs.length; i++) {
    addWanted(
      exemplarCustomerIds[i],
      exemplarRefs[i].aice_id,
      exemplarRefs[i].event_key,
    );
  }
  const mapsByCustomer = new Map<string, Map<string, RedactionMap>>();
  for (const [cid, inner] of wantedByCustomer) {
    const pool = poolFor(cid);
    if (!pool) continue;
    mapsByCustomer.set(
      cid,
      await decryptMaps(pool, cid, Array.from(inner.values())),
    );
  }

  for (const leaf of refs) {
    const storyIdx = leaf.kind === "story" ? leaf.index - 1 : -1;
    const eventIdx =
      leaf.kind === "event" ? leaf.index - storyRefs.length - 1 : -1;
    // Exemplar leaves follow all cited story+event leaves in the combined
    // order, so their 1-based `index` maps to `exemplarRefs` after both.
    const exemplarIdx =
      leaf.kind === "exemplar"
        ? leaf.index - storyRefs.length - eventRefs.length - 1
        : -1;
    const memberRefs = storyIdx >= 0 ? storyMemberRefs[storyIdx] : null;
    const eventRef = eventIdx >= 0 ? eventRefs[eventIdx] : null;
    const exemplarRef = exemplarIdx >= 0 ? exemplarRefs[exemplarIdx] : null;
    // The member map for this leaf's owning customer — story member events,
    // the cited event, and the exemplar event all live in the leaf's own DB.
    const memberMap =
      storyIdx >= 0
        ? mapsByCustomer.get(storyCustomerIds[storyIdx])
        : eventIdx >= 0
          ? mapsByCustomer.get(eventCustomerIds[eventIdx])
          : exemplarIdx >= 0
            ? mapsByCustomer.get(exemplarCustomerIds[exemplarIdx])
            : undefined;
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
            const map = memberMap?.get(`${member.aiceId}:${member.eventKey}`);
            plaintext = map?.[`<<REDACTED_${kind}_${nnn}>>`]?.value;
          }
        }
      } else if (leaf.kind === "event" && eventRef) {
        const m = EVENT_SOURCE_RE.exec(sourceToken);
        if (m) {
          const map = memberMap?.get(
            `${eventRef.aice_id}:${eventRef.event_key}`,
          );
          plaintext = map?.[sourceToken]?.value;
        }
      } else if (leaf.kind === "exemplar" && exemplarRef) {
        // Exemplars are event leaves → event-scope source tokens, resolved
        // through the exemplar leaf's own (aice_id, event_key) redaction map.
        const m = EVENT_SOURCE_RE.exec(sourceToken);
        if (m) {
          const map = memberMap?.get(
            `${exemplarRef.aice_id}:${exemplarRef.event_key}`,
          );
          plaintext = map?.[sourceToken]?.value;
        }
      }
      if (plaintext !== undefined) out.set(reportToken, plaintext);
    }
  }
  return { plaintextByReportToken: out, storyDisplays, eventDisplays };
}

/** A decomposed `(aice_id, event_key)` redaction-map key (#525). */
interface EventKeyPair {
  aiceId: string;
  eventKey: string;
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
    eventTime: row.event_time ?? null,
    kind: row.kind ?? null,
  };
}

// Internal helpers surfaced for unit tests only (#495): the exemplar-token
// display restoration is otherwise reachable only through the heavyweight
// `loadReportResultPage` path.
export const __testables = { buildReportTokenPlaintext };

/**
 * Decrypt one member's `event_redaction_map` rows in a SINGLE batched query
 * (#525): `wanted` is the already-decomposed `(aice_id, event_key)` pairs for
 * THIS member only, so the member identity is the `customerId` parameter and
 * the `customerPool` it runs on — never encoded into a `:`-joined key the
 * function has to split back apart. The returned map is keyed by
 * `aice_id:event_key`, scoped to this member; the caller stores it under the
 * member's customer id so a same-key collision across members cannot occur.
 */
async function decryptMaps(
  customerPool: Pool,
  customerId: string,
  wanted: ReadonlyArray<EventKeyPair>,
): Promise<Map<string, RedactionMap>> {
  const result = new Map<string, RedactionMap>();
  if (wanted.length === 0) return result;
  const pairs = wanted;
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
