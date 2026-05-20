import { createHash } from "node:crypto";
import { type NextRequest, NextResponse } from "next/server";
import { renderAnalyzeBridgeErrorPage } from "@/lib/analysis/analyze-bridge-error-page";
import type { AnalyzeBridgeErrorCode } from "@/lib/analysis/analyze-bridge-types";
import {
  isSupportedLang,
  LANG_VALUES,
  runAnalyzeFlow,
  type SupportedLang,
} from "@/lib/analysis/run-analyze-flow";
import { auditLog, UNKNOWN_ACTOR_ID } from "@/lib/audit";
import { withCorrelationId } from "@/lib/audit/correlation";
import { createPendingAnalysisRequestWithClient } from "@/lib/auth/analyze-bridge";
import { verifyAnalyzeParamsToken } from "@/lib/auth/analyze-params-token";
import { authorize } from "@/lib/auth/authorization";
import { createPendingConnectionWithClient } from "@/lib/auth/bridge";
import {
  type ContextTokenClaims,
  verifyContextToken,
} from "@/lib/auth/context-token";
import {
  clearInvitationTokenCookie,
  setConnectionIdCookie,
} from "@/lib/auth/cookies";
import { getCustomerByExternalKey } from "@/lib/auth/customers";
import {
  PayloadTooLargeError,
  TrustRegistryKeyExpiredError,
} from "@/lib/auth/errors";
import {
  type EventsEnvelopeClaims,
  verifyEventsEnvelope,
} from "@/lib/auth/events-envelope";
import {
  type OptionalGeneralSession,
  tryLoadGeneralSession,
} from "@/lib/auth/guards";
import { extractRequestMeta } from "@/lib/auth/request-meta";
import { getAuthPool, withTransaction } from "@/lib/db/client";
import { eventKeyString } from "@/lib/event-key";

interface ParsedMultipart {
  contextToken: string;
  envelopeJws: string;
  eventsData: Uint8Array;
  analyzeParamsToken: string;
}

/**
 * Parse the multipart body once, extracting all four fields needed by
 * the JWS verifiers — including the raw `events_envelope` JWS string
 * (which `verifyMultipartTokens` discards on the way to returning
 * parsed claims). `verifyAnalyzeParamsToken` needs those raw bytes to
 * compute `envelope_hash = base64url(sha256(events_envelope))`.
 */
async function parseMultipart(
  request: NextRequest,
): Promise<ParsedMultipart | null> {
  let formData: FormData;
  try {
    formData = await request.formData();
  } catch {
    return null;
  }
  const ctx = formData.get("context_token");
  const env = formData.get("events_envelope");
  const events = formData.get("events_data");
  const params = formData.get("analyze_params_token");

  if (typeof ctx !== "string" || ctx.length === 0) return null;
  if (typeof env !== "string" || env.length === 0) return null;
  if (typeof params !== "string" || params.length === 0) return null;

  let eventsBytes: Uint8Array;
  if (events instanceof File) {
    eventsBytes = new Uint8Array(await events.arrayBuffer());
  } else if (typeof events === "string" && events.length > 0) {
    eventsBytes = new TextEncoder().encode(events);
  } else {
    return null;
  }

  return {
    contextToken: ctx,
    envelopeJws: env,
    eventsData: eventsBytes,
    analyzeParamsToken: params,
  };
}

interface VerifiedBridgePayload {
  contextClaims: ContextTokenClaims;
  envelopeClaims: EventsEnvelopeClaims;
  eventsData: Uint8Array;
  eventData: Record<string, unknown>;
  eventKey: string;
  lang: SupportedLang;
  modelName: string;
  model: string;
  force: boolean;
  externalKey: string;
}

type VerificationFailure =
  | {
      kind: "invalid_context_token";
      detail: string;
      contextClaims?: undefined;
    }
  | {
      kind: "invalid_events_envelope";
      detail: string;
      contextClaims?: ContextTokenClaims;
    }
  | {
      kind: "event_data_too_large";
      detail: string;
      contextClaims?: ContextTokenClaims;
    }
  | {
      kind: "invalid_analyze_params_token";
      detail: string;
      contextClaims?: ContextTokenClaims;
    }
  | {
      kind: "malformed_payload";
      detail: string;
      contextClaims?: ContextTokenClaims;
    };

async function verifyAll(
  parsed: ParsedMultipart,
): Promise<VerifiedBridgePayload | VerificationFailure> {
  const pool = getAuthPool();

  let contextClaims: ContextTokenClaims;
  try {
    contextClaims = await verifyContextToken(pool, parsed.contextToken);
  } catch (err) {
    return {
      kind: "invalid_context_token",
      detail: err instanceof Error ? err.message : "invalid context token",
    };
  }

  let envelopeClaims: EventsEnvelopeClaims;
  try {
    envelopeClaims = await verifyEventsEnvelope(
      pool,
      parsed.envelopeJws,
      parsed.eventsData,
      contextClaims,
    );
  } catch (err) {
    // `event_data` exceeded the configured size cap. The JSON
    // `/api/analysis/analyze` route maps this to its dedicated
    // `event_data_too_large` (413); the bridge endpoint surfaces the
    // matching styled page rather than collapsing it into the generic
    // `invalid_events_envelope` (400) branch.
    if (err instanceof PayloadTooLargeError) {
      return {
        kind: "event_data_too_large",
        detail: err.message,
        contextClaims,
      };
    }
    if (err instanceof TrustRegistryKeyExpiredError) {
      return {
        kind: "invalid_events_envelope",
        detail: err.message,
        contextClaims,
      };
    }
    return {
      kind: "invalid_events_envelope",
      detail: err instanceof Error ? err.message : "invalid events envelope",
      contextClaims,
    };
  }

  let paramsClaims: Awaited<ReturnType<typeof verifyAnalyzeParamsToken>>;
  try {
    paramsClaims = await verifyAnalyzeParamsToken(
      pool,
      parsed.analyzeParamsToken,
      parsed.envelopeJws,
      contextClaims,
      envelopeClaims,
    );
  } catch (err) {
    return {
      kind: "invalid_analyze_params_token",
      detail:
        err instanceof Error ? err.message : "invalid analyze_params_token",
      contextClaims,
    };
  }

  // Per-parameter checks (Q2).
  if (!isSupportedLang(paramsClaims.lang)) {
    return {
      kind: "invalid_analyze_params_token",
      detail: `lang must be one of ${LANG_VALUES.join(", ")}`,
      contextClaims,
    };
  }
  // The JSON `/api/analysis/analyze` route validates `event_key`
  // against the canonical NUMERIC(39,0) string shape via Zod
  // (`eventKeyString`). The bridge token verifier only enforces
  // non-empty string, so apply the same canonical check here before
  // anything writes a PAR or runs the flow — otherwise a signed but
  // non-canonical value (`"01"`, `"abc"`, 40 digits, …) would only
  // surface as a `$2::numeric` cast error deep inside
  // `runAnalyzeFlow`, after a PAR row has already been persisted and
  // (post-OIDC) potentially claimed `processing`.
  const eventKeyCheck = eventKeyString.safeParse(paramsClaims.eventKey);
  if (!eventKeyCheck.success) {
    return {
      kind: "invalid_analyze_params_token",
      detail: "event_key is not a canonical NUMERIC(39,0) string",
      contextClaims,
    };
  }
  if (!contextClaims.customerIds.includes(paramsClaims.externalKey)) {
    return {
      kind: "invalid_analyze_params_token",
      detail: "external_key is not in context token customer_ids",
      contextClaims,
    };
  }

  // Parse events_data as JSON — the analyze flow consumes a structured
  // object, not raw bytes. envelope_verify already enforces a JSON
  // shape on Phase 2; here we do the same for the analyze flow.
  let eventData: Record<string, unknown>;
  try {
    const parsedJson: unknown = JSON.parse(
      new TextDecoder().decode(parsed.eventsData),
    );
    if (
      typeof parsedJson !== "object" ||
      parsedJson === null ||
      Array.isArray(parsedJson)
    ) {
      return {
        kind: "malformed_payload",
        detail: "events_data must be a JSON object",
        contextClaims,
      };
    }
    eventData = parsedJson as Record<string, unknown>;
  } catch (err) {
    return {
      kind: "malformed_payload",
      detail: err instanceof Error ? err.message : "events_data not JSON",
      contextClaims,
    };
  }

  // Bind event_key field to event_data's internal event_key. Mirrors
  // the analyze route's check at runAnalyzeFlow's entry — duplicated
  // here so the post-JWS-verify reject path stays inside this handler
  // and the failure mode reads as `invalid_analyze_params_token` (the
  // params token is what claimed the event_key value).
  const internalKey = eventData.event_key;
  let internalKeyStr: string | null = null;
  if (typeof internalKey === "string") internalKeyStr = internalKey;
  else if (typeof internalKey === "number" && Number.isFinite(internalKey)) {
    internalKeyStr = String(internalKey);
  } else if (typeof internalKey === "bigint") {
    internalKeyStr = internalKey.toString();
  }
  if (internalKeyStr === null || internalKeyStr !== paramsClaims.eventKey) {
    return {
      kind: "invalid_analyze_params_token",
      detail:
        "event_data.event_key does not equal the analyze_params_token event_key",
      contextClaims,
    };
  }

  return {
    contextClaims,
    envelopeClaims,
    eventsData: parsed.eventsData,
    eventData,
    eventKey: paramsClaims.eventKey,
    lang: paramsClaims.lang,
    modelName: paramsClaims.modelName,
    model: paramsClaims.model,
    force: paramsClaims.force,
    externalKey: paramsClaims.externalKey,
  };
}

function bridgeErrorCode(
  kind: VerificationFailure["kind"],
): AnalyzeBridgeErrorCode {
  switch (kind) {
    case "invalid_context_token":
      return "invalid_context_token";
    case "invalid_events_envelope":
      return "invalid_events_envelope";
    case "event_data_too_large":
      return "event_data_too_large";
    case "invalid_analyze_params_token":
      return "invalid_analyze_params_token";
    case "malformed_payload":
      return "invalid_event_data";
  }
}

/**
 * Pre-authorize the live general session against the verified bridge
 * payload's `(customerId, aiceId)`. Used as a gate on the short-circuit
 * path so an authenticated-but-unrelated session cannot block the
 * bridge — when this returns `false`, the handler must take the
 * cross-site PAR/OIDC path so the IdP can establish the correct
 * bridge session. Any error (unknown external_key, transient DB issue,
 * etc.) is treated as "not authorized" — pessimistic denial here is
 * safe because the cross-site path will surface the real reason after
 * sign-in.
 */
async function isLiveSessionAuthorized(
  session: OptionalGeneralSession,
  verified: VerifiedBridgePayload,
): Promise<boolean> {
  try {
    const authPool = getAuthPool();
    const customer = await getCustomerByExternalKey(
      authPool,
      verified.externalKey,
    );
    if (!customer) return false;
    const bridgeScope = session.bridgeCustomerIds
      ? {
          aiceId: session.bridgeAiceId ?? "",
          customerIds: session.bridgeCustomerIds,
        }
      : null;
    const result = await withTransaction(authPool, (client) =>
      authorize(client, "general", session.accountId, "analyses:create", {
        customerId: customer.id,
        aiceId: verified.contextClaims.aiceId,
        requiresAiceId: true,
        operationKind: "process",
        bridgeScope,
      }),
    );
    return result.authorized;
  } catch {
    return false;
  }
}

export async function POST(request: NextRequest): Promise<Response> {
  return withCorrelationId(async () => {
    const meta = extractRequestMeta(request);
    const parsed = await parseMultipart(request);
    if (!parsed) {
      return renderAnalyzeBridgeErrorPage(
        "invalid_event_data",
        "Multipart body is missing required fields.",
      );
    }

    const verified = await verifyAll(parsed);
    if ("kind" in verified) {
      const code = bridgeErrorCode(verified.kind);
      void auditLog({
        actorId: verified.contextClaims?.sub ?? UNKNOWN_ACTOR_ID,
        action: "bridge.connection_denied",
        targetType: "bridge",
        details: {
          reason: verified.kind,
          error: verified.detail,
          ...(verified.contextClaims
            ? { jti: verified.contextClaims.jti }
            : {}),
        },
        ipAddress: meta.ipAddress,
        ...(verified.contextClaims
          ? { aiceId: verified.contextClaims.aiceId }
          : {}),
      });
      return renderAnalyzeBridgeErrorPage(code, verified.detail);
    }

    const origin = request.nextUrl.origin;
    const session = await tryLoadGeneralSession();

    // Live-session short-circuit. The full JWS verification above
    // already ran — we don't bypass payload-verify just because a
    // session cookie is present. Skipping only the OIDC dance and the
    // PAR insert.
    //
    // Per #274 §1: short-circuit ONLY when a valid general session is
    // present AND `authorize(...)` would pass for the verified
    // (customer, aiceId). If the live session lacks the required
    // privilege, fall through to the cross-site PAR/OIDC path instead
    // of rendering a styled `authorization_failed` page — otherwise a
    // browser carrying an unrelated existing aimer-web session would
    // block the bridge flow before OIDC has a chance to establish the
    // intended bridge session.
    const shortCircuitAllowed = session
      ? await isLiveSessionAuthorized(session, verified)
      : false;

    if (session && shortCircuitAllowed) {
      const result = await runAnalyzeFlow({
        customer: {
          kind: "externalKey",
          externalKey: verified.externalKey,
        },
        aiceId: verified.contextClaims.aiceId,
        eventKey: verified.eventKey,
        eventData: verified.eventData,
        lang: verified.lang,
        modelName: verified.modelName,
        model: verified.model,
        force: verified.force,
        accountId: session.accountId,
        sessionId: session.sessionId,
        ipAddress: meta.ipAddress,
        bridgeScope: session.bridgeCustomerIds
          ? {
              aiceId: session.bridgeAiceId ?? "",
              customerIds: session.bridgeCustomerIds,
            }
          : null,
        origin,
      });
      if (result.kind === "error") {
        void auditLog({
          actorId: session.accountId,
          authContext: "general",
          action: "ai_analysis.short_circuit_executed",
          targetType: "event_analysis_result",
          details: {
            outcome: "failure",
            errorCode: result.errorCode,
            jti: verified.contextClaims.jti,
            externalKey: verified.externalKey,
          },
          ipAddress: meta.ipAddress,
          sid: session.sessionId,
          aiceId: verified.contextClaims.aiceId,
        });
        return renderAnalyzeBridgeErrorPage(result.errorCode, result.message);
      }
      void auditLog({
        actorId: session.accountId,
        authContext: "general",
        action: "ai_analysis.short_circuit_executed",
        targetType: "event_analysis_result",
        details: {
          outcome: "success",
          cached: result.cached,
          jti: verified.contextClaims.jti,
          externalKey: verified.externalKey,
        },
        ipAddress: meta.ipAddress,
        sid: session.sessionId,
        customerId: result.customerId,
        aiceId: verified.contextClaims.aiceId,
      });
      return NextResponse.redirect(result.viewUrl, 302);
    }

    // Cross-site path — INSERT pending_connections and PAR atomically.
    const payloadBuffer = Buffer.from(verified.eventsData);
    const payloadHash = createHash("sha256")
      .update(verified.eventsData)
      .digest("base64url");
    const pool = getAuthPool();
    let connectionId: string;
    let analyzeRequestId: string;
    try {
      const out = await withTransaction(pool, async (client) => {
        const cid = await createPendingConnectionWithClient(client, {
          jti: verified.contextClaims.jti,
          issuer: verified.contextClaims.iss,
          aiceId: verified.contextClaims.aiceId,
          customerIds: verified.contextClaims.customerIds,
          sub: verified.contextClaims.sub,
        });
        const parId = await createPendingAnalysisRequestWithClient(client, {
          connectionId: cid,
          aiceId: verified.contextClaims.aiceId,
          externalKey: verified.externalKey,
          eventKey: verified.eventKey,
          lang: verified.lang,
          modelName: verified.modelName,
          model: verified.model,
          force: verified.force,
          payload: payloadBuffer,
          payloadHash,
        });
        return { cid, parId };
      });
      connectionId = out.cid;
      analyzeRequestId = out.parId;
    } catch (err) {
      // `pending_connections_jti_key` violation → replay attempt;
      // `pending_analysis_requests_connection_id_key` cannot fire on
      // the same connection since the parent INSERT just produced a
      // fresh UUID, but the rejection reason is identical.
      if (
        err instanceof Error &&
        err.message.includes("pending_connections_jti_key")
      ) {
        void auditLog({
          actorId: verified.contextClaims.sub,
          action: "bridge.connection_denied",
          targetType: "bridge",
          details: {
            reason: "jti_replay",
            jti: verified.contextClaims.jti,
          },
          ipAddress: meta.ipAddress,
          aiceId: verified.contextClaims.aiceId,
        });
        return renderAnalyzeBridgeErrorPage(
          "invalid_context_token",
          "Context token already used",
        );
      }
      throw err;
    }

    await setConnectionIdCookie(connectionId);
    await clearInvitationTokenCookie();

    void auditLog({
      actorId: verified.contextClaims.sub,
      action: "ai_analysis.bridge_initiated",
      targetType: "pending_analysis_request",
      targetId: analyzeRequestId,
      details: {
        connectionId,
        jti: verified.contextClaims.jti,
        externalKey: verified.externalKey,
      },
      ipAddress: meta.ipAddress,
      aiceId: verified.contextClaims.aiceId,
    });

    return NextResponse.redirect(
      new URL("/api/auth/sign-in?flow=bridge", origin),
      302,
    );
  });
}
