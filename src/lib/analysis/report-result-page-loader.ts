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

import { authorize } from "@/lib/auth/authorization";
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

const DEFAULT_LANG = process.env.ANALYSIS_DEFAULT_LANG ?? "ENGLISH";
const DEFAULT_MODEL_NAME = process.env.ANALYSIS_DEFAULT_MODEL_NAME ?? "openai";
const DEFAULT_MODEL = process.env.ANALYSIS_DEFAULT_MODEL ?? "gpt-4o";

const STORY_SOURCE_RE = /<<REDACTED_(IP|EMAIL|MAC)_E(\d+)_(\d+)>>/;
const EVENT_SOURCE_RE = /<<REDACTED_(IP|EMAIL|MAC)_(\d+)>>/;

// Display-ready report sections, keyed by aimer's real
// `PERIODIC_SECURITY_REPORT` output schema (schemas/aimer.graphql @ f04caba):
// `executive_summary` / `period_outlook` are single Markdown strings, while
// `story_highlights` / `notable_events` / `baseline_observations` are arrays
// of Markdown strings (one entry per surfaced leaf / observation). The loader
// joins each array into a single block for display; the persisted
// `sections_jsonb` keeps aimer's original array structure verbatim.
export interface ReportSections {
  executive_summary: string;
  story_highlights: string;
  notable_events: string;
  baseline_observations: string;
  period_outlook: string;
}

export type ReportResultPageOutcome =
  | { kind: "unauthorized" }
  | { kind: "forbidden" }
  | { kind: "not_found" }
  // `tz` is the resolved report timezone (pinned variant → customer
  // default → UTC). The detail page anchors the LIVE period tab on
  // "today" in this tz, so the pending outcome must surface it too — the
  // `ok` outcome already exposes it via `data.tz`.
  | { kind: "pending"; stateStatus: string; tz: string }
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
  requestedBy: string | null;
  requestedAt: Date;
}

export interface ReportResultPageInput {
  customerId: string;
  period: string;
  bucketDate: string;
  /**
   * Optional report-variant selectors from the page's search params. When
   * omitted, each falls back to its default (customer-timezone snapshot
   * for `tz`; env defaults for `lang`/`model_name`/`model`), preserving the
   * original default-variant behavior.
   */
  variant?: {
    tz?: string;
    lang?: string;
    model_name?: string;
    model?: string;
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

  const auth = await withTransaction(authPool, (client) =>
    authorize(client, "general", claims.sub, "reports:read", {
      customerId: input.customerId,
      operationKind: "read",
      // Bridge sessions cannot read these surfaces (round-15 S3): an
      // in-scope bridge → 403, mirroring the regenerate/summary endpoints.
      allowInBridge: false,
      bridgeScope: bridgeCustomerIds
        ? { aiceId: bridgeAiceId ?? "", customerIds: bridgeCustomerIds }
        : null,
    }),
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
  // snapshot; lang/model_name/model default to the env-configured variant.
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
  const lang = input.variant?.lang ?? DEFAULT_LANG;
  const modelName = input.variant?.model_name ?? DEFAULT_MODEL_NAME;
  const model = input.variant?.model ?? DEFAULT_MODEL;

  const stateRows = await authPool.query<{ status: string }>(
    `SELECT status FROM periodic_report_state
      WHERE customer_id = $1 AND period = $2
        AND bucket_date = $3::date AND tz = $4`,
    [input.customerId, input.period, input.bucketDate, tz],
  );
  if (stateRows.rows.length === 0) return { kind: "not_found" };
  if (stateRows.rows[0].status === "archived") return { kind: "not_found" };

  const customerPool = getCustomerRuntimePool(input.customerId);
  const resultRow = await customerPool.query<{
    model_actual_version: string;
    prompt_version: string;
    generation: number;
    lang: string;
    model_name: string;
    model: string;
    priority_tier: PriorityTier;
    aggregate_severity_score: number;
    aggregate_likelihood_score: number;
    aggregate_ttp_tags: string[];
    sections_jsonb: ReportSections;
    input_story_refs: StoryRef[];
    input_event_refs: EventRef[];
    requested_by: string | null;
    requested_at: Date;
  }>(
    `SELECT model_actual_version, prompt_version, generation,
            lang, model_name, model,
            priority_tier, aggregate_severity_score, aggregate_likelihood_score,
            aggregate_ttp_tags, sections_jsonb,
            input_story_refs, input_event_refs,
            requested_by::text AS requested_by, requested_at
       FROM periodic_report_result
      WHERE customer_id = $1 AND period = $2
        AND bucket_date = $3::date AND tz = $4
        AND lang = $5 AND model_name = $6 AND model = $7
        AND superseded_at IS NULL
      ORDER BY generation DESC
      LIMIT 1`,
    [
      input.customerId,
      input.period,
      input.bucketDate,
      tz,
      lang,
      modelName,
      model,
    ],
  );
  if (resultRow.rows.length === 0) {
    return { kind: "pending", stateStatus: stateRows.rows[0].status, tz };
  }
  const row = resultRow.rows[0];

  const storyRefs = Array.isArray(row.input_story_refs)
    ? row.input_story_refs
    : [];
  const eventRefs = Array.isArray(row.input_event_refs)
    ? row.input_event_refs
    : [];

  const plaintextByReportToken = await buildReportTokenPlaintext(
    customerPool,
    input.customerId,
    storyRefs,
    eventRefs,
    { lang: row.lang, modelName: row.model_name, model: row.model },
  );

  const restoreOne = (s: unknown) =>
    restoreReportAnalysisTokens(
      typeof s === "string" ? s : "",
      plaintextByReportToken,
    );
  // aimer emits `story_highlights` / `notable_events` /
  // `baseline_observations` as arrays of Markdown strings; restore each entry
  // and join into one display block. `executive_summary` / `period_outlook`
  // are plain strings. Tolerate either shape so a legacy row still renders.
  const restoreSection = (v: unknown) =>
    Array.isArray(v)
      ? v
          .map(restoreOne)
          .filter((s) => s.length > 0)
          .join("\n\n")
      : restoreOne(v);
  const sections: ReportSections = {
    executive_summary: restoreSection(row.sections_jsonb?.executive_summary),
    story_highlights: restoreSection(row.sections_jsonb?.story_highlights),
    notable_events: restoreSection(row.sections_jsonb?.notable_events),
    baseline_observations: restoreSection(
      row.sections_jsonb?.baseline_observations,
    ),
    period_outlook: restoreSection(row.sections_jsonb?.period_outlook),
  };

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
      requestedBy: row.requested_by,
      requestedAt: row.requested_at,
    },
  };
}

/**
 * Re-derive the report token → plaintext map by replaying
 * `buildReportTokenMap` over the cited leaf narratives (pinned by
 * generation), then resolving each leaf's source token through the
 * relevant event redaction map. The result is keyed by the report-scope
 * token string so `restoreReportAnalysisTokens` can substitute directly.
 */
async function buildReportTokenPlaintext(
  // biome-ignore lint/suspicious/noExplicitAny: pg Pool minimal surface
  customerPool: any,
  customerId: string,
  storyRefs: StoryRef[],
  eventRefs: EventRef[],
  variant: { lang: string; modelName: string; model: string },
): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  if (storyRefs.length === 0 && eventRefs.length === 0) return out;

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
              input_event_refs
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
      `SELECT analysis_text, severity_factors, likelihood_factors
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
  return out;
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
