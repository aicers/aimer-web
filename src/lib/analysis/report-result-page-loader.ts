// Server-side loader for the periodic report detail page
// (`/[locale]/customers/{customerId}/analysis/reports/{period}/{bucketDate}`).
//
// Mirrors `story-result-page-loader.ts` but operates on
// `periodic_report_result` and the customer's default
// `(tz, lang, model_name, model)` variant. Report-scope
// `<<REDACTED_*_R{j}_*>>` tokens are restored to plaintext by replaying
// `buildReportTokenMap` over the cited leaf narratives (pinned by
// generation in `input_story_refs` / `input_event_refs`), then resolving
// each leaf's source token through the relevant event redaction map.

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

export interface ReportSections {
  executive_summary: string;
  story_highlights: string;
  baseline_drift: string;
  notable_events: string;
  recommendations: string;
}

export type ReportResultPageOutcome =
  | { kind: "unauthorized" }
  | { kind: "not_found" }
  | { kind: "pending"; stateStatus: string }
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
      bridgeScope: bridgeCustomerIds
        ? { aiceId: bridgeAiceId ?? "", customerIds: bridgeCustomerIds }
        : null,
    }),
  );
  if (!auth.authorized) return { kind: "unauthorized" };

  // Default tz = the customer's current timezone snapshot.
  const tzRow = await authPool.query<{ timezone: string }>(
    `SELECT timezone FROM customers WHERE id = $1`,
    [input.customerId],
  );
  const tz = tzRow.rows[0]?.timezone ?? "UTC";

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
      DEFAULT_LANG,
      DEFAULT_MODEL_NAME,
      DEFAULT_MODEL,
    ],
  );
  if (resultRow.rows.length === 0) {
    return { kind: "pending", stateStatus: stateRows.rows[0].status };
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
  );

  const restoreSection = (s: string) =>
    restoreReportAnalysisTokens(s ?? "", plaintextByReportToken);
  const sections: ReportSections = {
    executive_summary: restoreSection(row.sections_jsonb?.executive_summary),
    story_highlights: restoreSection(row.sections_jsonb?.story_highlights),
    baseline_drift: restoreSection(row.sections_jsonb?.baseline_drift),
    notable_events: restoreSection(row.sections_jsonb?.notable_events),
    recommendations: restoreSection(row.sections_jsonb?.recommendations),
  };

  return {
    kind: "ok",
    data: {
      customerId: input.customerId,
      period: input.period,
      bucketDate: input.bucketDate,
      tz,
      lang: DEFAULT_LANG,
      modelName: DEFAULT_MODEL_NAME,
      model: DEFAULT_MODEL,
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
): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  if (storyRefs.length === 0 && eventRefs.length === 0) return out;

  // Fetch story leaf narratives + their member refs at pinned generation.
  const storyTexts: string[] = [];
  const storyMemberRefs: Array<
    Array<{ index: number; aiceId: string; eventKey: string }>
  > = [];
  for (const ref of storyRefs) {
    const { rows } = await customerPool.query(
      `SELECT analysis_text, input_event_refs
         FROM story_analysis_result
        WHERE customer_id = $1 AND story_id = $2::bigint AND generation = $3
        LIMIT 1`,
      [customerId, ref.story_id, ref.generation],
    );
    storyTexts.push(rows[0]?.analysis_text ?? "");
    storyMemberRefs.push(
      Array.isArray(rows[0]?.input_event_refs) ? rows[0].input_event_refs : [],
    );
  }

  // Fetch event leaf narratives at pinned generation.
  const eventTexts: string[] = [];
  for (const ref of eventRefs) {
    const { rows } = await customerPool.query(
      `SELECT analysis_text
         FROM event_analysis_result
        WHERE aice_id = $1 AND event_key = $2::numeric AND generation = $3
        LIMIT 1`,
      [ref.aice_id, ref.event_key, ref.generation],
    );
    eventTexts.push(rows[0]?.analysis_text ?? "");
  }

  // Replay the rewrite to recover the report→source token map per leaf.
  const { refs } = buildReportTokenMap(storyTexts, eventTexts);

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
