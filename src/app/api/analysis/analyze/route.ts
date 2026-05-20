import { createHash } from "node:crypto";
import { ClientError } from "graphql-request";
import type { NextRequest } from "next/server";
import { z } from "zod";
import {
  type AnalyzeErrorCode,
  analyzeErrorResponse,
  type EventAnalysisResultRow,
} from "@/lib/analysis/analyze-types";
import { auditLog } from "@/lib/audit";
import { authorize } from "@/lib/auth/authorization";
import { getCustomerByExternalKey } from "@/lib/auth/customers";
import { verifyCsrf, verifyOrigin, withAuth } from "@/lib/auth/guards";
import { getAuthPool, withTransaction } from "@/lib/db/client";
import { getCustomerRuntimePool } from "@/lib/db/customer-runtime-pool";
import { eventKeyString } from "@/lib/event-key";
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

// ---------------------------------------------------------------------------
// Constants + helpers
// ---------------------------------------------------------------------------

const DEFAULT_MAX_PAYLOAD_BYTES = 50 * 1024 * 1024; // 50 MB
const SCHEMA_VERSION_DEFAULT = "0.0-stub";

function getMaxPayloadBytes(): number {
  const envVal = process.env.BRIDGE_MAX_PAYLOAD_BYTES;
  if (envVal) {
    const parsed = Number(envVal);
    if (Number.isFinite(parsed) && parsed > 0) return parsed;
  }
  return DEFAULT_MAX_PAYLOAD_BYTES;
}

const LANG_VALUES = ["KOREAN", "ENGLISH"] as const;
type SupportedLang = (typeof LANG_VALUES)[number];

function isSupportedLang(value: string): value is SupportedLang {
  return (LANG_VALUES as readonly string[]).includes(value);
}

// Single canonical message body for every `authorization_failed` path
// (missing customer, denied authorize, database_status≠active). The
// reason must be indistinguishable to callers so they cannot tell a
// provisioning/failed customer apart from a denied access decision.
const AUTHORIZATION_FAILED_MESSAGE = "not authorized";

// Same UUID shape the ingest route accepts (RFC 4122 layout only —
// no version digit enforcement). aimer-web's internal customer_id
// uses gen_random_uuid() which produces v4, but the route layer keeps
// the check format-only so test fixtures can use arbitrary-version
// UUIDs.
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const requestSchema = z
  .object({
    event_data: z.record(z.string(), z.unknown()),
    event_key: eventKeyString,
    customer_id: z.string().regex(UUID_RE).optional(),
    external_key: z.string().min(1).optional(),
    aice_id: z.string().min(1),
    // `lang` is accepted as a free-form string at this layer so the
    // explicit `lang_unsupported` branch below can surface the
    // dedicated error code from RFC 0001. The set of accepted values
    // is enforced against `LANG_VALUES` after parsing.
    lang: z.string().min(1),
    model_name: z.string().min(1),
    model: z.string().min(1),
    force: z.boolean(),
  })
  .refine(
    (v) => (v.customer_id == null) !== (v.external_key == null),
    "exactly one of customer_id or external_key must be provided",
  );

type AnalyzeRequest = z.infer<typeof requestSchema>;

interface ResolvedCustomer {
  id: string;
  databaseStatus: string;
  status: string;
}

/**
 * Look up the customer row this request targets. Resolves both the
 * `customer_id` direct-UUID path and the `external_key` lookup path
 * to the same `{ id, databaseStatus, status }` shape so the rest of
 * the route is path-agnostic. Returns `null` when no row matches the
 * external_key — the route surfaces this as `authorization_failed`
 * to prevent enumeration of registered customers.
 */
async function resolveCustomer(
  authPool: import("pg").Pool,
  body: AnalyzeRequest,
): Promise<ResolvedCustomer | null> {
  if (body.customer_id) {
    const res = await authPool.query<{
      id: string;
      database_status: string;
      status: string;
    }>(`SELECT id, database_status, status FROM customers WHERE id = $1`, [
      body.customer_id,
    ]);
    if (res.rows.length === 0) return null;
    return {
      id: res.rows[0].id,
      databaseStatus: res.rows[0].database_status,
      status: res.rows[0].status,
    };
  }
  const row = await getCustomerByExternalKey(authPool, body.external_key ?? "");
  if (!row) return null;
  return { id: row.id, databaseStatus: row.databaseStatus, status: row.status };
}

interface EventDataParseResult {
  eventKey: string | null;
  schemaVersion: string;
}

/**
 * Pull the canonical `event_key` (and optional `schema_version`) out
 * of the caller's `event_data`. The check is best-effort — a missing
 * `event_key` field is returned as `null` so the route surfaces
 * `event_key_mismatch`, never throws.
 */
function inspectEventData(
  eventData: Record<string, unknown>,
): EventDataParseResult {
  const rawKey = eventData.event_key;
  let eventKey: string | null = null;
  if (typeof rawKey === "string") {
    eventKey = rawKey;
  } else if (typeof rawKey === "number" && Number.isFinite(rawKey)) {
    // Numeric event_key in JSON loses precision for large i128 values,
    // but the request wire format already requires a string. We only
    // accept a numeric field here to ease early caller experiments.
    eventKey = String(rawKey);
  } else if (typeof rawKey === "bigint") {
    eventKey = rawKey.toString();
  }
  const rawSchema = eventData.schema_version;
  const schemaVersion =
    typeof rawSchema === "string" && rawSchema.length > 0
      ? rawSchema
      : SCHEMA_VERSION_DEFAULT;
  return { eventKey, schemaVersion };
}

// ---------------------------------------------------------------------------
// Route handler
// ---------------------------------------------------------------------------

export const POST = withAuth(async (req: NextRequest, auth) => {
  const originErr = verifyOrigin(req);
  if (originErr) return originErr;

  const csrfErr = verifyCsrf(req, {
    ctx: "general",
    sid: auth.sessionId,
    iat: auth.iat,
  });
  if (csrfErr) return csrfErr;

  // Size cap before parsing — `BRIDGE_MAX_PAYLOAD_BYTES` per RFC 0001.
  const rawText = await req.text();
  const maxBytes = getMaxPayloadBytes();
  if (Buffer.byteLength(rawText, "utf8") > maxBytes) {
    return analyzeErrorResponse(
      "event_data_too_large",
      `payload exceeds ${maxBytes} bytes`,
    );
  }

  let parsed: AnalyzeRequest;
  try {
    const raw: unknown = JSON.parse(rawText);
    const result = requestSchema.safeParse(raw);
    if (!result.success) {
      return analyzeErrorResponse(
        "invalid_event_data",
        result.error.issues
          .map((i) => `${i.path.join(".")}: ${i.message}`)
          .join("; "),
      );
    }
    parsed = result.data;
  } catch (err) {
    return analyzeErrorResponse(
      "invalid_event_data",
      err instanceof Error ? err.message : "could not parse request body",
    );
  }

  // The `lang_unsupported` error code is part of the public contract
  // (RFC 0001's 12-code error table). The Zod layer accepts `lang` as
  // a free-form string so unsupported values reach this branch and
  // surface the dedicated code instead of collapsing into the generic
  // `invalid_event_data`.
  if (!isSupportedLang(parsed.lang)) {
    return analyzeErrorResponse(
      "lang_unsupported",
      `lang must be one of ${LANG_VALUES.join(", ")}`,
    );
  }
  const lang: SupportedLang = parsed.lang;

  // event_key_mismatch: the explicit cache key MUST agree with
  // event_data's internal event_key, so a caller cannot supply event
  // X's payload under cache key Y.
  const { eventKey: payloadEventKey, schemaVersion } = inspectEventData(
    parsed.event_data,
  );
  if (payloadEventKey === null || payloadEventKey !== parsed.event_key) {
    return analyzeErrorResponse(
      "event_key_mismatch",
      "event_data.event_key does not equal the explicit event_key field",
    );
  }

  const authPool = getAuthPool();
  const customer = await resolveCustomer(authPool, parsed);
  if (!customer) {
    // external_key lookup denies probing: a missing row is
    // indistinguishable from "not allowed" so callers cannot
    // enumerate registered customers.
    return analyzeErrorResponse(
      "authorization_failed",
      AUTHORIZATION_FAILED_MESSAGE,
    );
  }

  // Run authorize() first. `customers.status='active'` is enforced
  // inside `authorize()`; only callers who clear that gate can reach
  // the subsequent `database_status` check. This ordering, combined
  // with the shared `AUTHORIZATION_FAILED_MESSAGE`, keeps the
  // externally visible response body indistinguishable across the
  // four failure modes (missing row, denied authorize, non-active
  // customers.status, non-active database_status) so probing callers
  // cannot use this endpoint to enumerate customer state.
  const authResult = await withTransaction(authPool, (client) =>
    authorize(client, "general", auth.accountId, "analyses:create", {
      customerId: customer.id,
      aiceId: parsed.aice_id,
      requiresAiceId: true,
      operationKind: "process",
      bridgeScope: auth.bridgeCustomerIds
        ? {
            aiceId: auth.bridgeAiceId ?? "",
            customerIds: auth.bridgeCustomerIds,
          }
        : null,
    }),
  );

  const auditBase = {
    actorId: auth.accountId,
    authContext: "general" as const,
    targetType: "event_analysis_result",
    ipAddress: auth.meta.ipAddress,
    sid: auth.sessionId,
    customerId: customer.id,
    aiceId: parsed.aice_id,
  };

  if (!authResult.authorized) {
    return analyzeErrorResponse(
      "authorization_failed",
      AUTHORIZATION_FAILED_MESSAGE,
    );
  }

  // `database_status` gate — checked AFTER `authorize()` so the
  // distinguishable state is gated behind a legitimate authorization
  // decision. Still applies before the customer DB pool is opened so
  // a `provisioning` / `failed` customer's DB is never touched. Both
  // `customers.status` and `customers.database_status` must be
  // `'active'` for the happy path.
  if (customer.databaseStatus !== "active") {
    return analyzeErrorResponse(
      "authorization_failed",
      AUTHORIZATION_FAILED_MESSAGE,
    );
  }

  // Resolve customer DB + redaction ranges once. Both are reused by
  // the cache lookup and the synthetic-ingest / aimer-call paths.
  const customerPool = getCustomerRuntimePool(customer.id);
  const ranges = await loadCustomerRanges(authPool, customer.id);

  const viewUrl = buildViewUrl(
    req,
    customer.id,
    parsed.aice_id,
    parsed.event_key,
    lang,
    parsed.model_name,
    parsed.model,
  );

  // ---- Cache lookup -------------------------------------------------------
  // Behaviour matrix step (RFC 0001):
  //   - event exists + result exists + !force → return cached view_url
  //   - event exists + result missing       → analyze + store
  //   - event missing                       → redact+ingest + analyze + store
  //   - force=true (any case)               → analyze + UPSERT result
  let cached = false;
  if (!parsed.force) {
    const cachedRow = await customerPool.query<{ requested_at: Date }>(
      `SELECT requested_at FROM event_analysis_result
       WHERE aice_id = $1 AND event_key = $2::numeric
         AND lang = $3 AND model_name = $4 AND model = $5`,
      [parsed.aice_id, parsed.event_key, lang, parsed.model_name, parsed.model],
    );
    if (cachedRow.rows.length > 0) cached = true;
  }

  void auditLog({
    ...auditBase,
    action: "ai_analysis.request_issued",
    targetId: `${parsed.aice_id}/${parsed.event_key}`,
    details: {
      lang,
      modelName: parsed.model_name,
      model: parsed.model,
      force: parsed.force,
      cached,
    },
  });

  if (cached) {
    return Response.json({ view_url: viewUrl, cached: true });
  }

  // ---- Resolve redacted event + (maybe) synthetic ingest -----------------
  // When `detection_events` has no row for this `(aice_id, event_key)`
  // we redact the caller-supplied `event_data`, persist the resulting
  // map, and INSERT a synthetic row. When the row already exists we
  // MUST use the stored `redacted_event` for the aimer call AND scan
  // hallucinations against the persisted map without touching it —
  // otherwise a caller could replay the same canonical `event_key`
  // with crafted `event_data` and (a) have aimer analyse text that
  // does not match the persisted event or (b) inject attacker-
  // controlled entities into the redaction map, which the
  // hallucination scan would then treat as legitimate re-leaks and
  // the result page would restore as plaintext.
  let redactedEvent: unknown;
  let mergedMap: import("@/lib/redaction").RedactionMap;
  try {
    const ingest = await ingestAndRedact({
      customerPool,
      authPool,
      customerId: customer.id,
      aiceId: parsed.aice_id,
      eventKey: parsed.event_key,
      eventData: parsed.event_data,
      schemaVersion,
      ranges,
      accountId: auth.accountId,
    });
    redactedEvent = ingest.redacted;
    mergedMap = ingest.mergedMap;
  } catch (err) {
    void auditLog({
      ...auditBase,
      action: "ai_analysis.aimer_call_failed",
      targetId: `${parsed.aice_id}/${parsed.event_key}`,
      details: {
        stage: "redact_and_ingest",
        error: err instanceof Error ? err.message : String(err),
      },
    });
    return analyzeErrorResponse(
      err instanceof StorageError ? "storage_failed" : "redaction_failed",
      err instanceof Error ? err.message : "redaction failed",
    );
  }

  // ---- aimer GraphQL call ------------------------------------------------
  let aimerResponse: { threatScore: number; analysis: string };
  try {
    const result = await graphqlRequest(
      AnalyzeEventDocument,
      {
        eventData: redactedEvent as Record<string, unknown>,
        name: parsed.model_name,
        model: parsed.model,
        lang,
      },
      { accountId: auth.accountId, aiceId: parsed.aice_id },
    );
    aimerResponse = result.analyzeEvent;
  } catch (err) {
    const code = mapAimerError(err);
    void auditLog({
      ...auditBase,
      action: "ai_analysis.aimer_call_failed",
      targetId: `${parsed.aice_id}/${parsed.event_key}`,
      details: {
        stage: "graphql_call",
        code,
        error: err instanceof Error ? err.message : String(err),
      },
    });
    return analyzeErrorResponse(
      code,
      err instanceof Error ? err.message : "aimer call failed",
    );
  }

  // ---- Hallucination scan + storage --------------------------------------
  const scan = scanHallucinations(aimerResponse.analysis, mergedMap, ranges);
  if (scan.counts.ip + scan.counts.email + scan.counts.mac > 0) {
    void auditLog({
      ...auditBase,
      action: "ai_analysis.hallucination_detected",
      targetId: `${parsed.aice_id}/${parsed.event_key}`,
      details: {
        lang,
        modelName: parsed.model_name,
        model: parsed.model,
        counts: scan.counts,
      },
    });
  }

  const analysisPolicyVersion = computeAnalysisPolicyVersion(
    customer.id,
    ranges,
  );
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
        parsed.aice_id,
        parsed.event_key,
        lang,
        parsed.model_name,
        parsed.model,
        aimerResponse.threatScore,
        scan.scanned,
        analysisPolicyVersion,
        auth.accountId,
      ],
    );
  } catch (err) {
    return analyzeErrorResponse(
      "storage_failed",
      err instanceof Error ? err.message : "storage failed",
    );
  }

  void auditLog({
    ...auditBase,
    action: "ai_analysis.result_stored",
    targetId: `${parsed.aice_id}/${parsed.event_key}`,
    details: {
      lang,
      modelName: parsed.model_name,
      model: parsed.model,
      force: parsed.force,
    },
  });

  return Response.json({ view_url: viewUrl, cached: false });
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

class StorageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StorageError";
  }
}

interface IngestAndRedactParams {
  customerPool: import("pg").Pool;
  authPool: import("pg").Pool;
  customerId: string;
  aiceId: string;
  eventKey: string;
  eventData: Record<string, unknown>;
  schemaVersion: string;
  ranges: import("@/lib/redaction").RangeSet;
  accountId: string;
}

/**
 * Resolve the redacted event content the aimer call will analyse, and
 * INSERT a synthetic `detection_events` row when none exists.
 *
 * RFC 0001 §"Behaviour matrix" + §"API contract — Request" rules:
 *
 * - When `detection_events` HAS a row for `(aice_id, event_key)`, the
 *   stored `redacted_event` is authoritative; the caller-supplied
 *   `event_data` is ignored. The persisted `event_redaction_map` is
 *   left untouched so an attacker cannot append entities to the map
 *   by replaying a known `event_key` with crafted `event_data`. The
 *   hallucination scan therefore runs against the stored map, not a
 *   merge of the request body — re-leak detection only honours
 *   entities that originated from the persisted event.
 * - When NO row exists, we redact the caller-supplied `event_data`,
 *   write the resulting map, and INSERT a synthetic row
 *   (`source='manual'`, `connection_id=NULL`,
 *   `ingested_by=accountId`).
 *
 * Concurrency is handled by the per-`(aice_id, event_key)` Postgres
 * advisory lock taken inside `readMapWithLock`. Every other writer
 * for the same event (`storeApprovedEvents`, Phase 2 paths) takes the
 * same lock, so the SELECT-then-INSERT below cannot race past a
 * concurrent insert.
 */
async function ingestAndRedact(params: IngestAndRedactParams): Promise<{
  redacted: unknown;
  mergedMap: import("@/lib/redaction").RedactionMap;
}> {
  return withTransaction(params.customerPool, async (client) => {
    const existing = await readMapWithLock(
      client,
      params.customerId,
      params.aiceId,
      params.eventKey,
    );

    // Inside the advisory lock, this SELECT observes any earlier
    // insert (by this route OR `storeApprovedEvents`). If we find one,
    // we MUST NOT redact the request body or touch the persisted map
    // — otherwise a caller replaying a known `event_key` with crafted
    // `event_data` could append attacker-controlled entities to the
    // map, which the hallucination scan would then treat as a
    // legitimate re-leak and the result page would restore as
    // plaintext.
    const existingEvent = await client.query<{ redacted_event: unknown }>(
      `SELECT redacted_event FROM detection_events
       WHERE aice_id = $1 AND event_key = $2::numeric`,
      [params.aiceId, params.eventKey],
    );
    if (existingEvent.rows.length > 0) {
      return {
        redacted: existingEvent.rows[0].redacted_event,
        mergedMap: existing ?? {},
      };
    }

    // No row exists — this is the synthetic-ingest path. Redact the
    // caller-supplied `event_data`, persist the resulting map, and
    // INSERT the detection_events row. The advisory lock guarantees
    // no concurrent writer can race past us, so a plain INSERT is
    // sufficient; we still use `ON CONFLICT DO NOTHING` defensively
    // against any future writer that does not take the lock.
    const out = redact({
      payload: params.eventData,
      existingMap: existing ?? {},
      ranges: params.ranges,
      engineVersion: ENGINE_VERSION,
    });
    if (existing === null || out.mapChanged) {
      await writeMap(
        client,
        params.customerId,
        params.aiceId,
        params.eventKey,
        out.mergedMap,
      );
    }
    const redactedJson = JSON.stringify(out.redacted);
    const payloadHash = createHash("sha256").update(redactedJson).digest("hex");
    try {
      await client.query(
        `INSERT INTO detection_events
           (aice_id, event_key, redacted_event, redaction_policy_version,
            schema_version, payload_hash, source, connection_id, ingested_by)
         VALUES ($1, $2::numeric, $3::jsonb, $4, $5, $6, 'manual', NULL, $7::uuid)
         ON CONFLICT (aice_id, event_key) DO NOTHING`,
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
    } catch (err) {
      throw new StorageError(err instanceof Error ? err.message : String(err));
    }

    return { redacted: out.redacted, mergedMap: out.mergedMap };
  });
}

/**
 * Map any error thrown by the GraphQL transport to the matching
 * `AnalyzeErrorCode`. The categorisation follows RFC 0001's error
 * table — 401 from aimer is `aimer_auth_failed`, GraphQL validation
 * is `aimer_invalid_request`, 5xx is `aimer_call_failed`, transport
 * issues are `aimer_unavailable`.
 */
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
  // Network / mTLS errors surface as plain TypeError / undici-shaped
  // exceptions — they all mean the pipe is unhealthy.
  return "aimer_unavailable";
}

/**
 * Build the permalink URL the caller's "Send to aimer" flow opens.
 * Same shape as the result page route under `/[locale]/customers/...`.
 */
function buildViewUrl(
  req: NextRequest,
  customerId: string,
  aiceId: string,
  eventKey: string,
  lang: SupportedLang,
  modelName: string,
  model: string,
): string {
  // Locale is not part of the cache key — the result page reads it
  // from the URL only for UI strings. The caller's preferred locale
  // is conveyed by the lang param plus the URL segment; we default
  // to `en` so a server-issued link still resolves a real page when
  // pasted into a clean tab.
  const locale = "en";
  const base = req.nextUrl.origin;
  const params = new URLSearchParams({
    lang,
    model_name: modelName,
    model,
  });
  return (
    `${base}/${locale}/customers/${encodeURIComponent(customerId)}` +
    `/aice/${encodeURIComponent(aiceId)}` +
    `/events/${encodeURIComponent(eventKey)}` +
    `/analysis?${params.toString()}`
  );
}

/**
 * Composite policy version stamped on the analysis row. Reuses the
 * engine's format (`engine:<semver>|ranges:<sha256-short>`) without
 * importing the engine's internal helper — `computePolicyVersion` is
 * already exported but takes a `RangeSet`, which we already have.
 */
function computeAnalysisPolicyVersion(
  _customerId: string,
  ranges: import("@/lib/redaction").RangeSet,
): string {
  // The retroactive re-redact job (#253) re-stamps analysis_text in
  // place when policy changes; this initial value records the policy
  // in force at first write.
  const json = JSON.stringify(ranges.normalisedCidrs);
  const short =
    ranges.normalisedCidrs.length === 0
      ? "empty"
      : createHash("sha256").update(json).digest("hex").slice(0, 12);
  return `engine:${ENGINE_VERSION}|ranges:${short}`;
}

// Re-export the row type so tests / page loader can share it without
// reaching into `@/lib/analysis/analyze-types`.
export type { EventAnalysisResultRow };
