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
  loadCustomerRanges,
  readMapWithLock,
  redact,
  scanHallucinations,
  writeMap,
} from "@/lib/redaction";
import type { AnalyzeErrorCode } from "./analyze-types";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export const LANG_VALUES = ["KOREAN", "ENGLISH"] as const;
export type SupportedLang = (typeof LANG_VALUES)[number];

export function isSupportedLang(value: string): value is SupportedLang {
  return (LANG_VALUES as readonly string[]).includes(value);
}

const SCHEMA_VERSION_DEFAULT = "0.0-stub";

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
   * i128 nanoseconds since the Unix epoch as a canonical decimal
   * string. `null` means the field was missing or did not parse as
   * a valid i128 decimal. Sourced from `event_data.event_time_nanos`
   * (see {@link EVENT_TIME_NANOS_RE}). Aimer's `analyzeEvent` SDL
   * argument `timestamp: StringNumber!` is documented as nanoseconds
   * since epoch; the BFF surfaces a dedicated wire field rather than
   * reusing `event_key` because `event_key` is this codebase's
   * NUMERIC(39, 0) row identifier and carries no timestamp semantics
   * (no upstream contract guarantees event_key == nanoseconds; see
   * `src/lib/event-key.ts`).
   */
  eventTimeNanos: string | null;
  schemaVersion: string;
}

/**
 * i128 decimal (signed) — aimer's `StringNumber` carries `i128`, which
 * spans roughly ±1.7×10^38. `jiff::Timestamp::from_nanosecond` on the
 * aimer side rejects values outside its valid timestamp range, but the
 * BFF only enforces the lexical i128 shape here; a negative value
 * (pre-1970) parses cleanly and is forwarded for aimer to accept or
 * reject. Leading zeros are rejected for the same canonical-form
 * reasons {@link eventKeyString} rejects them: cache-key consistency.
 */
const EVENT_TIME_NANOS_RE = /^(-?(0|[1-9][0-9]{0,38}))$/;

function parseEventTimeNanos(raw: unknown): string | null {
  let candidate: string | null = null;
  if (typeof raw === "string") {
    candidate = raw;
  } else if (typeof raw === "number") {
    // JS numbers cannot losslessly carry nanosecond i128 values:
    // nanosecond epoch values are already ~1.7×10^18, well above
    // `Number.MAX_SAFE_INTEGER` (2^53 − 1 ≈ 9×10^15), so a number
    // received over the wire has typically already been rounded
    // before this code runs. Reject anything that is not a safe
    // integer so the BFF never silently forwards a rounded value
    // as a `StringNumber`. Safe integers are still accepted to keep
    // test fixtures and low-resolution timestamps ergonomic — for
    // those, `String(raw)` is exact. The string form remains the
    // contract for any value above 2^53.
    if (!Number.isSafeInteger(raw)) return null;
    candidate = String(raw);
  } else if (typeof raw === "bigint") {
    candidate = raw.toString();
  }
  if (candidate === null) return null;
  return EVENT_TIME_NANOS_RE.test(candidate) ? candidate : null;
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
  const eventTimeNanos = parseEventTimeNanos(eventData.event_time_nanos);
  const rawSchema = eventData.schema_version;
  const schemaVersion =
    typeof rawSchema === "string" && rawSchema.length > 0
      ? rawSchema
      : SCHEMA_VERSION_DEFAULT;
  return { eventKey, eventTimeNanos, schemaVersion };
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

function computeAnalysisPolicyVersion(
  ranges: import("@/lib/redaction").RangeSet,
): string {
  const json = JSON.stringify(ranges.normalisedCidrs);
  const short =
    ranges.normalisedCidrs.length === 0
      ? "empty"
      : createHash("sha256").update(json).digest("hex").slice(0, 12);
  return `engine:${ENGINE_VERSION}|ranges:${short}`;
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
    eventTimeNanos: requestEventTimeNanos,
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
  // not need a request-side `event_time_nanos`. For every path that
  // does call aimer (event_missing or event_exists+result_missing),
  // reject up-front so the route does not write a `detection_events`
  // row, ingest into the redaction map, and burn aimer call budget
  // before discovering the call would have failed `StringNumber`
  // validation upstream. The aimer call itself prefers the STORED
  // `event_time_nanos` (cache-poisoning guard) and falls back to this
  // request value only when the stored row pre-dates the field.
  if (requestEventTimeNanos === null) {
    return {
      kind: "error",
      errorCode: "event_time_invalid",
      message:
        "event_data.event_time_nanos is missing or not a canonical i128 decimal string",
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

  let aimerResponse: { threatScore: number; analysis: string };
  try {
    // `event: String!` — aimer's auth-mtls resolver consumes a string
    // payload that its redact-and-LLM pipeline parses on the other side.
    // We serialize the BFF's structured redacted event with `JSON.stringify`
    // (default key order; aimer's downstream stages do not require any
    // canonical ordering, only valid JSON).
    //
    // `timestamp: StringNumber!` — sourced from
    // `event_data.event_time_nanos`, an i128 nanoseconds-since-epoch
    // decimal string. We do NOT reuse `event_key`: this codebase
    // treats `event_key` as a NUMERIC(39, 0) row identifier with no
    // timestamp semantics (see `src/lib/event-key.ts`), and aimer
    // turns this value into a `jiff::Timestamp` it renders into the
    // analysis markdown — using the row identifier would either
    // display the wrong time or fall outside the timestamp range
    // aimer accepts.
    //
    // When the event already exists in `detection_events`, the call
    // uses the STORED `redacted_event` (cache-poisoning guard) and
    // re-extracts `event_time_nanos` from it; if the stored row pre-
    // dates this field, we fall back to the caller's value (already
    // validated above), since the caller has supplied a canonical
    // i128 and the alternative is failing the whole call.
    //
    // `lang: Language` — nullable on the SDL side. When the BFF
    // caller omits `lang` we omit the variable entirely so aimer
    // applies its server default; the stored cache row uses
    // {@link DEFAULT_LANG} so a follow-up explicit ENGLISH call
    // collapses to the same row.
    const storedEventTimeNanos =
      typeof redactedEvent === "object" && redactedEvent !== null
        ? parseEventTimeNanos(
            (redactedEvent as Record<string, unknown>).event_time_nanos,
          )
        : null;
    const timestampForAimer = storedEventTimeNanos ?? requestEventTimeNanos;
    const result = await graphqlRequest(
      AnalyzeEventDocument,
      {
        event: JSON.stringify(redactedEvent),
        timestamp: timestampForAimer,
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

  const scan = scanHallucinations(aimerResponse.analysis, mergedMap, ranges);
  if (scan.counts.ip + scan.counts.email + scan.counts.mac > 0) {
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

  const analysisPolicyVersion = computeAnalysisPolicyVersion(ranges);
  try {
    await customerPool.query(
      `INSERT INTO event_analysis_result
         (aice_id, event_key, lang, model_name, model,
          threat_score, analysis_text, redaction_policy_version, requested_by)
       VALUES ($1, $2::numeric, $3, $4, $5, $6, $7, $8, $9::uuid)
       ON CONFLICT (aice_id, event_key, lang, model_name, model)
       DO UPDATE SET
         threat_score = EXCLUDED.threat_score,
         analysis_text = EXCLUDED.analysis_text,
         redaction_policy_version = EXCLUDED.redaction_policy_version,
         requested_by = EXCLUDED.requested_by,
         requested_at = NOW()`,
      [
        params.aiceId,
        params.eventKey,
        langForStorage,
        params.modelName,
        params.model,
        aimerResponse.threatScore,
        scan.scanned,
        analysisPolicyVersion,
        params.accountId,
      ],
    );
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

  return { kind: "success", viewUrl, cached: false, customerId: customer.id };
}
