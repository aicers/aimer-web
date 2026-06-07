import "server-only";

import { createHash } from "node:crypto";
import { ClientError } from "graphql-request";
import type { Pool } from "pg";
import { auditLog } from "@/lib/audit";
import { authorize } from "@/lib/auth/authorization";
import { getCustomerByExternalKey } from "@/lib/auth/customers";
import { getAuthPool, withTransaction } from "@/lib/db/client";
import { getCustomerRuntimePool } from "@/lib/db/customer-runtime-pool";
import { AnalyzeEventDocument } from "@/lib/graphql/__generated__/analyze-event";
import { graphqlRequest } from "@/lib/graphql/client";
import {
  ENGINE_VERSION,
  loadCustomerOwnedDomains,
  loadCustomerRanges,
  readMapWithLock,
  redact,
  scanHallucinations,
  writeMap,
} from "@/lib/redaction";
import type { AnalyzeErrorCode } from "./analyze-types";
import { parseEventTime } from "./event-time";
import {
  type FactorAxis,
  type FilterFactorsResult,
  filterFactors,
} from "./factor-filter";
import { MITRE_VENDOR_VERSION, validateTtpTags } from "./mitre-ttp";
import { computePriorityTier } from "./priority-tier";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export const LANG_VALUES = ["KOREAN", "ENGLISH"] as const;
export type SupportedLang = (typeof LANG_VALUES)[number];

export function isSupportedLang(value: string): value is SupportedLang {
  return (LANG_VALUES as readonly string[]).includes(value);
}

const SCHEMA_VERSION_DEFAULT = "0.0-stub";

// Advisory-lock namespace for the event-analysis generation sequence.
// Paired with `eventVariantLockKey` so the (read MAX → supersede →
// insert) section is serialized per event variant (#297 review round 1,
// item 4).
const EVENT_GENERATION_LOCK_NAMESPACE = 0x2978;

/**
 * Stable positive int4 advisory-lock key derived from an event variant,
 * so concurrent analyzes of the *same* `(aice_id, event_key, lang,
 * model_name, model)` serialize while different variants run freely.
 */
function eventVariantLockKey(
  aiceId: string,
  eventKey: string,
  lang: string,
  modelName: string,
  model: string,
): number {
  const digest = createHash("sha256")
    .update([aiceId, eventKey, lang, modelName, model].join("\0"))
    .digest();
  // Fold the first 4 bytes into a signed int4 (advisory-lock arg range).
  return digest.readInt32BE(0);
}

export const AUTHORIZATION_FAILED_MESSAGE = "not authorized";

export type CustomerLookup =
  | { kind: "id"; customerId: string }
  | { kind: "externalKey"; externalKey: string };

/**
 * Aimer's `Language` enum is nullable on the SDL side; when the caller
 * omits `lang`, aimer applies its server-side default (ENGLISH per the
 * SDL doc on `Mutation.generateReport`'s `lang` argument; the
 * `analyzeEvent` resolver follows the same convention). The BFF
 * mirrors that contract: `lang` is optional at the request layer, the
 * GraphQL variable is omitted when absent, and downstream paths that
 * need a concrete value (the (aice_id, event_key, lang, ...) cache
 * primary key, the result-page URL, audit details) fall back to the
 * documented upstream default so user-supplied ENGLISH and omitted-then-
 * defaulted ENGLISH collapse to one row rather than splitting the
 * cache.
 */
export const DEFAULT_LANG: SupportedLang = "ENGLISH";

export interface RunAnalyzeFlowParams {
  customer: CustomerLookup;
  aiceId: string;
  eventKey: string;
  eventData: Record<string, unknown>;
  /**
   * SDL maps to `Language` (nullable). `undefined` means "let aimer
   * apply its default"; the BFF omits the variable from the GraphQL
   * mutation in that case. See {@link DEFAULT_LANG} for the cache /
   * view-url fallback.
   */
  lang: SupportedLang | undefined;
  modelName: string;
  model: string;
  force: boolean;
  accountId: string;
  sessionId: string;
  ipAddress: string | undefined;
  bridgeScope: { aiceId: string; customerIds: string[] } | null;
  /** Origin used to build the view_url permalink. */
  origin: string;
}

export type RunAnalyzeFlowResult =
  | {
      kind: "success";
      viewUrl: string;
      cached: boolean;
      customerId: string;
    }
  | {
      kind: "error";
      errorCode: AnalyzeErrorCode;
      message: string;
    };

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

interface ResolvedCustomer {
  id: string;
  databaseStatus: string;
  status: string;
}

async function resolveCustomer(
  authPool: Pool,
  lookup: CustomerLookup,
): Promise<ResolvedCustomer | null> {
  if (lookup.kind === "id") {
    const res = await authPool.query<{
      id: string;
      database_status: string;
      status: string;
    }>(`SELECT id, database_status, status FROM customers WHERE id = $1`, [
      lookup.customerId,
    ]);
    if (res.rows.length === 0) return null;
    return {
      id: res.rows[0].id,
      databaseStatus: res.rows[0].database_status,
      status: res.rows[0].status,
    };
  }
  const row = await getCustomerByExternalKey(authPool, lookup.externalKey);
  if (!row) return null;
  return { id: row.id, databaseStatus: row.databaseStatus, status: row.status };
}

interface EventDataParseResult {
  eventKey: string | null;
  /**
   * RFC 3339 / ISO 8601 date-time string, or `null` when the field is
   * absent or fails {@link parseEventTime}. Sourced from
   * `event_data.event_time` and forwarded verbatim to aimer's
   * `analyzeEvent` mutation as the `eventTime: DateTime!` variable,
   * where aimer parses it with `jiff::Timestamp`. The BFF does NOT
   * reuse `event_key`: that column is a `NUMERIC(39, 0)` row
   * identifier with no timestamp semantics (see `src/lib/event-key.ts`).
   */
  eventTime: string | null;
  schemaVersion: string;
}

function inspectEventData(
  eventData: Record<string, unknown>,
): EventDataParseResult {
  const rawKey = eventData.event_key;
  let eventKey: string | null = null;
  if (typeof rawKey === "string") {
    eventKey = rawKey;
  } else if (typeof rawKey === "number" && Number.isFinite(rawKey)) {
    eventKey = String(rawKey);
  } else if (typeof rawKey === "bigint") {
    eventKey = rawKey.toString();
  }
  const eventTime = parseEventTime(eventData.event_time);
  const rawSchema = eventData.schema_version;
  const schemaVersion =
    typeof rawSchema === "string" && rawSchema.length > 0
      ? rawSchema
      : SCHEMA_VERSION_DEFAULT;
  return { eventKey, eventTime, schemaVersion };
}

class StorageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StorageError";
  }
}

interface IngestAndRedactParams {
  customerPool: Pool;
  authPool: Pool;
  customerId: string;
  aiceId: string;
  eventKey: string;
  eventData: Record<string, unknown>;
  schemaVersion: string;
  ranges: import("@/lib/redaction").RangeSet;
  ownedDomains: import("@/lib/redaction").OwnedDomainSet;
  accountId: string;
}

async function ingestAndRedact(params: IngestAndRedactParams): Promise<{
  redacted: unknown;
  mergedMap: import("@/lib/redaction").RedactionMap;
  insertedEventId: string | null;
}> {
  return withTransaction(params.customerPool, async (client) => {
    const existing = await readMapWithLock(
      client,
      params.customerId,
      params.aiceId,
      params.eventKey,
    );

    const existingEvent = await client.query<{ redacted_event: unknown }>(
      `SELECT redacted_event FROM detection_events
       WHERE aice_id = $1 AND event_key = $2::numeric`,
      [params.aiceId, params.eventKey],
    );
    if (existingEvent.rows.length > 0) {
      return {
        redacted: existingEvent.rows[0].redacted_event,
        mergedMap: existing ?? {},
        insertedEventId: null,
      };
    }

    const out = redact({
      payload: params.eventData,
      existingMap: existing ?? {},
      ranges: params.ranges,
      ownedDomains: params.ownedDomains,
      engineVersion: ENGINE_VERSION,
    });
    if (existing === null || out.mapChanged) {
      try {
        await writeMap(
          client,
          params.customerId,
          params.aiceId,
          params.eventKey,
          out.mergedMap,
        );
      } catch (err) {
        throw new StorageError(
          err instanceof Error ? err.message : String(err),
        );
      }
    }
    const redactedJson = JSON.stringify(out.redacted);
    const payloadHash = createHash("sha256").update(redactedJson).digest("hex");
    let insertedEventId: string | null = null;
    try {
      const insertRes = await client.query<{ id: string }>(
        `INSERT INTO detection_events
           (aice_id, event_key, redacted_event, redaction_policy_version,
            schema_version, payload_hash, source, connection_id, ingested_by)
         VALUES ($1, $2::numeric, $3::jsonb, $4, $5, $6, 'manual', NULL, $7::uuid)
         ON CONFLICT (aice_id, event_key) DO NOTHING
         RETURNING id`,
        [
          params.aiceId,
          params.eventKey,
          redactedJson,
          out.policyVersion,
          params.schemaVersion,
          payloadHash,
          params.accountId,
        ],
      );
      if (insertRes.rows.length > 0) {
        insertedEventId = insertRes.rows[0].id;
      }
    } catch (err) {
      throw new StorageError(err instanceof Error ? err.message : String(err));
    }

    return {
      redacted: out.redacted,
      mergedMap: out.mergedMap,
      insertedEventId,
    };
  });
}

function mapAimerError(err: unknown): AnalyzeErrorCode {
  if (err instanceof ClientError) {
    const status = err.response?.status;
    if (status === 401 || status === 403) return "aimer_auth_failed";
    if (
      Array.isArray(err.response?.errors) &&
      err.response.errors.length > 0 &&
      status !== undefined &&
      status < 500
    ) {
      return "aimer_invalid_request";
    }
    if (status !== undefined && status >= 500) return "aimer_call_failed";
    return "aimer_call_failed";
  }
  return "aimer_unavailable";
}

function buildViewUrl(
  origin: string,
  customerId: string,
  aiceId: string,
  eventKey: string,
  lang: SupportedLang,
  modelName: string,
  model: string,
): string {
  // `lang` here is the post-fallback concrete value (caller-supplied or
  // {@link DEFAULT_LANG}) so the URL always carries a `lang` parameter
  // that matches the row written to `event_analysis_result`. The result
  // page picks the variant by `(aice_id, event_key, lang, model_name,
  // model)`, and an absent `lang=` would not resolve to the row
  // that aimer just produced under its default.
  const locale = "en";
  const params = new URLSearchParams({
    lang,
    model_name: modelName,
    model,
  });
  return (
    `${origin}/${locale}/customers/${encodeURIComponent(customerId)}` +
    `/aice/${encodeURIComponent(aiceId)}` +
    `/events/${encodeURIComponent(eventKey)}` +
    `/analysis?${params.toString()}`
  );
}

export interface AuditEmissionBase {
  actorId: string;
  authContext: "general";
  targetType: string;
  ipAddress: string | undefined;
  sid: string;
  customerId: string;
  aiceId: string;
}

function groupBy<K extends string, V>(
  items: readonly V[],
  key: (v: V) => K,
): Map<K, V[]> {
  const map = new Map<K, V[]>();
  for (const item of items) {
    const k = key(item);
    const bucket = map.get(k);
    if (bucket) bucket.push(item);
    else map.set(k, [item]);
  }
  return map;
}

function emitFactorAuditRows(args: {
  auditBase: AuditEmissionBase;
  eventKey: string;
  axis: FactorAxis;
  rawInput: readonly string[];
  filter: FilterFactorsResult;
}): void {
  const { auditBase, eventKey, axis, rawInput, filter } = args;
  const targetId = `${auditBase.aiceId}/${eventKey}`;
  // RFC 0001:756 locks the payload to include the event-level target
  // identifiers (`customer_id`, `aice_id`, `event_key`, `story_id: null`)
  // alongside the axis/reason/items fields so consumers do not need to
  // parse `targetId` to recover the event.
  const targetFields = {
    customer_id: auditBase.customerId,
    aice_id: auditBase.aiceId,
    event_key: eventKey,
    story_id: null,
  } as const;
  // Per-`(row, axis, reason)` rows describing which shape rule each
  // dropped item violated. Cap-truncated items deliberately do not
  // appear here — RFC 0001:756's `reason` enum has no cap value.
  const byReason = groupBy(filter.dropped, (d) => d.reason);
  for (const [reason, items] of byReason) {
    void auditLog({
      ...auditBase,
      action: "ai_analysis.factor_dropped",
      targetId,
      details: {
        ...targetFields,
        axis,
        dropped_items: items.map((d) => d.item),
        reason,
        replaced_with_sentinel: false,
      },
    });
  }
  // Sentinel recovery — a separate row whose `dropped_items` carries the
  // full pre-filter input so the audit reader can attribute the
  // recovery without re-joining against the per-reason rows above.
  if (filter.usedSentinel) {
    void auditLog({
      ...auditBase,
      action: "ai_analysis.factor_dropped",
      targetId,
      details: {
        ...targetFields,
        axis,
        dropped_items: [...rawInput],
        reason: "all_items_filtered",
        replaced_with_sentinel: true,
      },
    });
  }
}

function emitTtpDropAuditRows(args: {
  auditBase: AuditEmissionBase;
  eventKey: string;
  dropped: readonly { id: string; reason: string }[];
}): void {
  const { auditBase, eventKey, dropped } = args;
  const targetId = `${auditBase.aiceId}/${eventKey}`;
  // RFC 0001:755 locks the payload to include `customer_id`, `aice_id`,
  // `event_key`, and `story_id: null` so consumers can read the
  // event-level scope directly from the JSON without parsing `targetId`.
  const targetFields = {
    customer_id: auditBase.customerId,
    aice_id: auditBase.aiceId,
    event_key: eventKey,
    story_id: null,
  } as const;
  // One audit row per `reason` group. RFC 0001:755's payload `reason` is
  // single-valued, so mixed-reason drops split into separate rows.
  const byReason = groupBy(dropped, (d) => d.reason);
  for (const [reason, items] of byReason) {
    void auditLog({
      ...auditBase,
      action: "ai_analysis.ttp_tag_dropped",
      targetId,
      details: {
        ...targetFields,
        dropped_ids: items.map((d) => d.id),
        reason,
        mitre_vendor_version: MITRE_VENDOR_VERSION,
      },
    });
  }
}

function computeAnalysisPolicyVersion(
  ranges: import("@/lib/redaction").RangeSet,
  ownedDomains: import("@/lib/redaction").OwnedDomainSet,
): string {
  const json = JSON.stringify(ranges.normalisedCidrs);
  const short =
    ranges.normalisedCidrs.length === 0
      ? "empty"
      : createHash("sha256").update(json).digest("hex").slice(0, 12);
  const domainsJson = JSON.stringify(ownedDomains.normalisedSuffixes);
  const domainsShort =
    ownedDomains.normalisedSuffixes.length === 0
      ? "empty"
      : createHash("sha256").update(domainsJson).digest("hex").slice(0, 12);
  return `engine:${ENGINE_VERSION}|ranges:${short}|domains:${domainsShort}`;
}

// ---------------------------------------------------------------------------
// Shared aimer-call + result-write core
// ---------------------------------------------------------------------------

export interface AnalyzeAndStoreEventParams {
  customerPool: Pool;
  aiceId: string;
  eventKey: string;
  /**
   * The redacted event object that gets serialized into the `event`
   * argument. Both callers source this from `detection_events.
   * redacted_event` (the initial analyze flow via {@link ingestAndRedact},
   * which returns the stored row when one already exists; the regenerate
   * endpoint by reading it directly) so aimer never sees raw payload.
   */
  redactedEvent: unknown;
  /**
   * RFC 3339 `event_time` for the `analyzeEvent` call, already recovered
   * (preferring the stored `redacted_event.event_time`).
   */
  eventTimeForAimer: string;
  /**
   * SDL `Language` variable (nullable). `undefined` omits it so aimer
   * applies its server default; {@link langForStorage} is the concrete
   * value written to the cache PK.
   */
  lang: SupportedLang | undefined;
  langForStorage: SupportedLang;
  modelName: string;
  model: string;
  accountId: string;
  /** Redaction map used by the hallucination scan over the LLM output. */
  mergedMap: import("@/lib/redaction").RedactionMap;
  ranges: import("@/lib/redaction").RangeSet;
  ownedDomains: import("@/lib/redaction").OwnedDomainSet;
  /**
   * Value stamped into `event_analysis_result.redaction_policy_version`.
   * The initial analyze path passes the freshly computed analysis policy
   * version; the in-app regenerate path passes the STORED
   * `detection_events.redaction_policy_version`, because it holds redaction
   * constant rather than re-redacting under current policy (#463).
   */
  redactionPolicyVersion: string;
  auditBase: AuditEmissionBase;
  /** Audit-only flag distinguishing a forced (re)generation. */
  force: boolean;
}

export type AnalyzeAndStoreEventResult =
  | { kind: "success"; generation: number }
  | { kind: "error"; errorCode: AnalyzeErrorCode; message: string };

/**
 * Call aimer's `analyzeEvent` with an already-redacted event, run the
 * output through the hallucination scan + factor/TTP shape filters, then
 * supersede the prior latest generation and INSERT a fresh
 * `generation = N+1` row for the `(aice_id, event_key, lang, model_name,
 * model)` variant. Returns the new generation.
 *
 * Shared by {@link runAnalyzeFlow} (the ingest-then-analyze path) and the
 * in-app event regenerate endpoint (which skips ingest/redact and sources
 * the redacted event from storage, #463). The supersede + insert run in a
 * single customer-DB transaction under a per-variant advisory lock so a
 * concurrent reader never sees two live rows and concurrent writers do not
 * collide on the generation sequence.
 */
export async function analyzeAndStoreEventResult(
  params: AnalyzeAndStoreEventParams,
): Promise<AnalyzeAndStoreEventResult> {
  const { auditBase } = params;
  let aimerResponse: {
    severityScore: number;
    likelihoodScore: number;
    severityFactors: string[];
    likelihoodFactors: string[];
    ttpTags: string[];
    analysis: string;
  };
  try {
    // `event: String!` — aimer's auth-mtls resolver consumes a string
    // payload that its redact-and-LLM pipeline parses on the other side.
    // We serialize the BFF's structured redacted event with
    // `JSON.stringify` (default key order; aimer's downstream stages do not
    // require any canonical ordering, only valid JSON).
    //
    // `eventTime: DateTime!` — an RFC 3339 date-time string that aimer
    // parses with `jiff::Timestamp`, recovered by the caller from the
    // stored `redacted_event.event_time` (cache-poisoning guard).
    //
    // `lang: Language` — nullable on the SDL side. When the caller omits
    // `lang` we omit the variable entirely so aimer applies its server
    // default; the stored cache row uses {@link langForStorage}.
    const result = await graphqlRequest(
      AnalyzeEventDocument,
      {
        event: JSON.stringify(params.redactedEvent),
        eventTime: params.eventTimeForAimer,
        name: params.modelName,
        model: params.model,
        ...(params.lang !== undefined ? { lang: params.lang } : {}),
      },
      { accountId: params.accountId, aiceId: params.aiceId },
    );
    aimerResponse = result.analyzeEvent;
  } catch (err) {
    const code = mapAimerError(err);
    void auditLog({
      ...auditBase,
      action: "ai_analysis.aimer_call_failed",
      targetId: `${params.aiceId}/${params.eventKey}`,
      details: {
        stage: "graphql_call",
        code,
        error: err instanceof Error ? err.message : String(err),
      },
    });
    return {
      kind: "error",
      errorCode: code,
      message: err instanceof Error ? err.message : "aimer call failed",
    };
  }

  const scan = scanHallucinations(
    aimerResponse.analysis,
    params.mergedMap,
    params.ranges,
    params.ownedDomains,
  );
  if (
    scan.counts.ip + scan.counts.email + scan.counts.mac + scan.counts.domain >
    0
  ) {
    void auditLog({
      ...auditBase,
      action: "ai_analysis.hallucination_detected",
      targetId: `${params.aiceId}/${params.eventKey}`,
      details: {
        lang: params.lang ?? null,
        modelName: params.modelName,
        model: params.model,
        counts: scan.counts,
      },
    });
  }

  const priorityTier = computePriorityTier(
    aimerResponse.severityScore,
    aimerResponse.likelihoodScore,
  );

  // ---- Score factor + TTP tag shape filters ----------------------------
  // RFC 0002 §"Score factor articulation" + §"MITRE ATT&CK TTP tagging":
  // run LLM-returned arrays through their respective filters before
  // storage, and emit per-`(row, reason)` audit rows.
  const severityFilter = filterFactors(
    aimerResponse.severityFactors,
    "severity",
  );
  const likelihoodFilter = filterFactors(
    aimerResponse.likelihoodFactors,
    "likelihood",
  );
  const ttpResult = validateTtpTags(aimerResponse.ttpTags);

  emitFactorAuditRows({
    auditBase,
    eventKey: params.eventKey,
    axis: "severity",
    rawInput: aimerResponse.severityFactors,
    filter: severityFilter,
  });
  emitFactorAuditRows({
    auditBase,
    eventKey: params.eventKey,
    axis: "likelihood",
    rawInput: aimerResponse.likelihoodFactors,
    filter: likelihoodFilter,
  });
  emitTtpDropAuditRows({
    auditBase,
    eventKey: params.eventKey,
    dropped: ttpResult.dropped,
  });

  let nextGeneration: number;
  try {
    // RFC 0002 #297 round-14 item 1: re-analysis no longer overwrites.
    // Stamp `superseded_at` on the prior latest generation and INSERT a
    // fresh `generation = N+1` row, so periodic-report citations
    // (`input_event_refs[].generation`) always point at a durable row.
    // Wrapped in a single customer-DB tx so the supersede + insert are
    // atomic and a concurrent reader never sees two live rows.
    const writeClient = await params.customerPool.connect();
    try {
      await writeClient.query("BEGIN");
      // Serialize the read-MAX/supersede/insert sequence per event variant.
      // Without this, two concurrent analyzes for the same
      // (aice_id, event_key, lang, model_name, model) both read the same
      // MAX(generation), both compute N+1, and the second loses the INSERT
      // race on the extended PK (#297 review round 1, item 4). The lock is
      // transaction-scoped, so it releases on COMMIT/ROLLBACK below.
      await writeClient.query("SELECT pg_advisory_xact_lock($1, $2)", [
        EVENT_GENERATION_LOCK_NAMESPACE,
        eventVariantLockKey(
          params.aiceId,
          params.eventKey,
          params.langForStorage,
          params.modelName,
          params.model,
        ),
      ]);
      const { rows: genRows } = await writeClient.query<{
        next_generation: number;
      }>(
        `SELECT COALESCE(MAX(generation), 0) + 1 AS next_generation
           FROM event_analysis_result
          WHERE aice_id = $1 AND event_key = $2::numeric
            AND lang = $3 AND model_name = $4 AND model = $5`,
        [
          params.aiceId,
          params.eventKey,
          params.langForStorage,
          params.modelName,
          params.model,
        ],
      );
      nextGeneration = genRows[0]?.next_generation ?? 1;
      await writeClient.query(
        `UPDATE event_analysis_result
            SET superseded_at = NOW()
          WHERE aice_id = $1 AND event_key = $2::numeric
            AND lang = $3 AND model_name = $4 AND model = $5
            AND generation < $6
            AND superseded_at IS NULL`,
        [
          params.aiceId,
          params.eventKey,
          params.langForStorage,
          params.modelName,
          params.model,
          nextGeneration,
        ],
      );
      await writeClient.query(
        `INSERT INTO event_analysis_result
           (aice_id, event_key, lang, model_name, model, generation,
            severity_score, likelihood_score,
            severity_factors, likelihood_factors, ttp_tags,
            priority_tier,
            analysis_text, redaction_policy_version, requested_by)
         VALUES ($1, $2::numeric, $3, $4, $5, $6,
                 $7, $8,
                 $9::jsonb, $10::jsonb, $11::jsonb,
                 $12,
                 $13, $14, $15::uuid)`,
        [
          params.aiceId,
          params.eventKey,
          params.langForStorage,
          params.modelName,
          params.model,
          nextGeneration,
          aimerResponse.severityScore,
          aimerResponse.likelihoodScore,
          JSON.stringify(severityFilter.kept),
          JSON.stringify(likelihoodFilter.kept),
          JSON.stringify(ttpResult.valid),
          priorityTier,
          scan.scanned,
          params.redactionPolicyVersion,
          params.accountId,
        ],
      );
      await writeClient.query("COMMIT");
    } catch (err) {
      await writeClient.query("ROLLBACK").catch(() => {});
      throw err;
    } finally {
      writeClient.release();
    }
  } catch (err) {
    return {
      kind: "error",
      errorCode: "storage_failed",
      message: err instanceof Error ? err.message : "storage failed",
    };
  }

  void auditLog({
    ...auditBase,
    action: "ai_analysis.result_stored",
    targetId: `${params.aiceId}/${params.eventKey}`,
    details: {
      lang: params.lang ?? null,
      modelName: params.modelName,
      model: params.model,
      force: params.force,
    },
  });

  return { kind: "success", generation: nextGeneration };
}

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------

/**
 * Shared "post-validation core" of the analyze flow. Called by:
 *
 *   - `/api/analysis/analyze` POST handler (JSON response surface)
 *   - `/api/analysis/analyze-bridge` POST short-circuit path (302 redirect)
 *   - `/api/analysis/analyze-bridge/continue` GET (302 redirect)
 *
 * All three callers run their own transport-layer checks (origin, CSRF,
 * JWS verification, multipart parsing) before invoking this helper.
 * Inputs are assumed already validated against the wire format; this
 * function performs the cross-table policy / cache / aimer-call work.
 */
export async function runAnalyzeFlow(
  params: RunAnalyzeFlowParams,
): Promise<RunAnalyzeFlowResult> {
  // event_key_mismatch — the explicit cache key MUST agree with
  // event_data's internal event_key.
  const {
    eventKey: payloadEventKey,
    eventTime: requestEventTime,
    schemaVersion,
  } = inspectEventData(params.eventData);
  if (payloadEventKey === null || payloadEventKey !== params.eventKey) {
    return {
      kind: "error",
      errorCode: "event_key_mismatch",
      message:
        "event_data.event_key does not equal the explicit event_key field",
    };
  }

  const authPool = getAuthPool();
  const customer = await resolveCustomer(authPool, params.customer);
  if (!customer) {
    return {
      kind: "error",
      errorCode: "authorization_failed",
      message: AUTHORIZATION_FAILED_MESSAGE,
    };
  }

  const authResult = await withTransaction(authPool, (client) =>
    authorize(client, "general", params.accountId, "analyses:create", {
      customerId: customer.id,
      aiceId: params.aiceId,
      requiresAiceId: true,
      operationKind: "process",
      bridgeScope: params.bridgeScope,
    }),
  );

  const auditBase = {
    actorId: params.accountId,
    authContext: "general" as const,
    targetType: "event_analysis_result",
    ipAddress: params.ipAddress,
    sid: params.sessionId,
    customerId: customer.id,
    aiceId: params.aiceId,
  };

  if (!authResult.authorized) {
    return {
      kind: "error",
      errorCode: "authorization_failed",
      message: AUTHORIZATION_FAILED_MESSAGE,
    };
  }

  if (customer.databaseStatus !== "active") {
    return {
      kind: "error",
      errorCode: "authorization_failed",
      message: AUTHORIZATION_FAILED_MESSAGE,
    };
  }

  const customerPool = getCustomerRuntimePool(customer.id);
  const ranges = await loadCustomerRanges(authPool, customer.id);
  const ownedDomains = await loadCustomerOwnedDomains(authPool, customer.id);

  // Single concrete `lang` value used wherever the BFF needs to write
  // or look up a row keyed on `lang`. Absent caller `lang` collapses
  // to {@link DEFAULT_LANG} so the cache PK is satisfied and a later
  // caller who explicitly passes the same default reads the same row.
  const langForStorage: SupportedLang = params.lang ?? DEFAULT_LANG;

  const viewUrl = buildViewUrl(
    params.origin,
    customer.id,
    params.aiceId,
    params.eventKey,
    langForStorage,
    params.modelName,
    params.model,
  );

  let cached = false;
  if (!params.force) {
    const cachedRow = await customerPool.query<{ requested_at: Date }>(
      `SELECT requested_at FROM event_analysis_result r
       WHERE r.aice_id = $1 AND r.event_key = $2::numeric
         AND r.lang = $3 AND r.model_name = $4 AND r.model = $5
         AND r.superseded_at IS NULL
         AND EXISTS (
           SELECT 1 FROM detection_events d
           WHERE d.aice_id = $1 AND d.event_key = $2::numeric
         )`,
      [
        params.aiceId,
        params.eventKey,
        langForStorage,
        params.modelName,
        params.model,
      ],
    );
    if (cachedRow.rows.length > 0) cached = true;
  }

  void auditLog({
    ...auditBase,
    action: "ai_analysis.request_issued",
    targetId: `${params.aiceId}/${params.eventKey}`,
    details: {
      lang: params.lang ?? null,
      modelName: params.modelName,
      model: params.model,
      force: params.force,
      cached,
    },
  });

  if (cached) {
    return { kind: "success", viewUrl, cached: true, customerId: customer.id };
  }

  // Deferred until after the cache lookup: the cache-hit branch above
  // short-circuits without an `analyzeEvent` call and therefore does
  // not need a request-side `event_time`. For every path that does
  // call aimer (event_missing or event_exists+result_missing), reject
  // up-front so the route does not write a `detection_events` row,
  // ingest into the redaction map, and burn aimer call budget before
  // discovering the call would have failed `DateTime` parsing upstream.
  // The aimer call itself prefers the STORED `event_time` (cache-
  // poisoning guard) and falls back to this request value otherwise.
  if (requestEventTime === null) {
    return {
      kind: "error",
      errorCode: "event_time_invalid",
      message:
        "event_data.event_time is missing or not a valid RFC 3339 date-time",
    };
  }

  let redactedEvent: unknown;
  let mergedMap: import("@/lib/redaction").RedactionMap;
  let insertedEventId: string | null = null;
  try {
    const ingest = await ingestAndRedact({
      customerPool,
      authPool,
      customerId: customer.id,
      aiceId: params.aiceId,
      eventKey: params.eventKey,
      eventData: params.eventData,
      schemaVersion,
      ranges,
      ownedDomains,
      accountId: params.accountId,
    });
    redactedEvent = ingest.redacted;
    mergedMap = ingest.mergedMap;
    insertedEventId = ingest.insertedEventId;
  } catch (err) {
    if (!(err instanceof StorageError)) {
      void auditLog({
        ...auditBase,
        action: "redaction.engine_error",
        targetId: `${params.aiceId}/${params.eventKey}`,
        details: {
          stage: "analyze_redact",
          error: err instanceof Error ? err.message : String(err),
        },
      });
    }
    return {
      kind: "error",
      errorCode:
        err instanceof StorageError ? "storage_failed" : "redaction_failed",
      message: err instanceof Error ? err.message : "redaction failed",
    };
  }

  if (insertedEventId !== null) {
    void auditLog({
      ...auditBase,
      targetType: "detection_events",
      action: "detection_events.transfer_approved",
      targetId: insertedEventId,
      details: { customerId: customer.id, eventIds: [insertedEventId] },
    });
  }

  // Prefer the STORED `redacted_event.event_time` (cache-poisoning guard)
  // and fall back to the caller's already-validated request value. We do
  // NOT reuse `event_key`: this codebase treats it as a NUMERIC(39, 0) row
  // identifier with no timestamp semantics (see `src/lib/event-key.ts`).
  const storedEventTime =
    typeof redactedEvent === "object" && redactedEvent !== null
      ? parseEventTime((redactedEvent as Record<string, unknown>).event_time)
      : null;
  const eventTimeForAimer = storedEventTime ?? requestEventTime;

  // The initial analyze path stamps the freshly computed analysis policy
  // version onto the result row.
  const analysisPolicyVersion = computeAnalysisPolicyVersion(
    ranges,
    ownedDomains,
  );

  const stored = await analyzeAndStoreEventResult({
    customerPool,
    aiceId: params.aiceId,
    eventKey: params.eventKey,
    redactedEvent,
    eventTimeForAimer,
    lang: params.lang,
    langForStorage,
    modelName: params.modelName,
    model: params.model,
    accountId: params.accountId,
    mergedMap,
    ranges,
    ownedDomains,
    redactionPolicyVersion: analysisPolicyVersion,
    auditBase,
    force: params.force,
  });
  if (stored.kind === "error") {
    return stored;
  }

  return { kind: "success", viewUrl, cached: false, customerId: customer.id };
}
