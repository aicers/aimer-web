import { createHash } from "node:crypto";
import { type NextRequest, NextResponse } from "next/server";
import {
  renderAnalyzeBridgeErrorPage,
  renderAnalyzeBridgeNotFoundPage,
  renderSessionExpiredPage,
} from "@/lib/analysis/analyze-bridge-error-page";
import type { AnalyzeBridgeErrorCode } from "@/lib/analysis/analyze-bridge-types";
import {
  isSupportedLang,
  runAnalyzeFlow,
} from "@/lib/analysis/run-analyze-flow";
import { auditLog } from "@/lib/audit";
import { withCorrelationId } from "@/lib/audit/correlation";
import {
  loadPendingAnalysisRequest,
  markPARConsumed,
  markPARFailed,
} from "@/lib/auth/analyze-bridge";
import { withAuth } from "@/lib/auth/guards";
import { decryptPayload } from "@/lib/crypto/envelope";
import { getAuthPool } from "@/lib/db/client";

export const GET = withAuth(async (request: NextRequest, auth) => {
  return withCorrelationId(async () => {
    const id = request.nextUrl.searchParams.get("id");
    if (!id) {
      return renderAnalyzeBridgeNotFoundPage();
    }

    const par = await loadPendingAnalysisRequest(getAuthPool(), id);
    if (!par) {
      return renderAnalyzeBridgeNotFoundPage();
    }

    const origin = request.nextUrl.origin;

    switch (par.status) {
      case "consumed":
        if (par.viewUrl) {
          void auditLog({
            actorId: auth.accountId,
            authContext: "general",
            action: "ai_analysis.continue_replayed",
            targetType: "pending_analysis_request",
            targetId: par.id,
            details: { externalKey: par.externalKey },
            ipAddress: auth.meta.ipAddress,
            sid: auth.sessionId,
            aiceId: par.aiceId,
          });
          return NextResponse.redirect(par.viewUrl, 302);
        }
        return renderAnalyzeBridgeErrorPage(
          "internal_error",
          "Consumed analyze request is missing its view_url.",
        );
      case "failed": {
        const code = isBridgeErrorCode(par.failureCode)
          ? par.failureCode
          : ("internal_error" as const);
        void auditLog({
          actorId: auth.accountId,
          authContext: "general",
          action: "ai_analysis.continue_replayed",
          targetType: "pending_analysis_request",
          targetId: par.id,
          details: {
            outcome: "failed",
            errorCode: code,
            externalKey: par.externalKey,
          },
          ipAddress: auth.meta.ipAddress,
          sid: auth.sessionId,
          aiceId: par.aiceId,
        });
        return renderAnalyzeBridgeErrorPage(
          code,
          "This analyze request previously failed.",
        );
      }
      case "expired":
        void auditLog({
          actorId: auth.accountId,
          authContext: "general",
          action: "ai_analysis.continue_replayed",
          targetType: "pending_analysis_request",
          targetId: par.id,
          details: {
            outcome: "expired",
            externalKey: par.externalKey,
          },
          ipAddress: auth.meta.ipAddress,
          sid: auth.sessionId,
          aiceId: par.aiceId,
        });
        return renderSessionExpiredPage();
      case "pending":
        break;
    }

    if (!isSupportedLang(par.lang)) {
      await markPARFailed(getAuthPool(), par.id, "lang_unsupported");
      return renderAnalyzeBridgeErrorPage(
        "lang_unsupported",
        `lang must be one of KOREAN, ENGLISH`,
      );
    }

    // Decrypt and run the flow.
    let eventData: Record<string, unknown>;
    try {
      const plaintext = await decryptPayload(par.payload, par.wrappedDek);
      const computedHash = createHash("sha256")
        .update(plaintext)
        .digest("base64url");
      if (computedHash !== par.payloadHash) {
        throw new Error("decrypted payload hash does not match payload_hash");
      }
      const parsed: unknown = JSON.parse(plaintext.toString("utf8"));
      if (
        typeof parsed !== "object" ||
        parsed === null ||
        Array.isArray(parsed)
      ) {
        throw new Error("event_data is not a JSON object");
      }
      eventData = parsed as Record<string, unknown>;
    } catch (err) {
      await markPARFailed(getAuthPool(), par.id, "internal_error");
      void auditLog({
        actorId: auth.accountId,
        authContext: "general",
        action: "ai_analysis.continue_failed",
        targetType: "pending_analysis_request",
        targetId: par.id,
        details: {
          errorCode: "internal_error",
          stage: "decrypt",
          error: err instanceof Error ? err.message : String(err),
          externalKey: par.externalKey,
        },
        ipAddress: auth.meta.ipAddress,
        sid: auth.sessionId,
        aiceId: par.aiceId,
      });
      return renderAnalyzeBridgeErrorPage(
        "internal_error",
        err instanceof Error ? err.message : "decryption failed",
      );
    }

    const result = await runAnalyzeFlow({
      customer: { kind: "externalKey", externalKey: par.externalKey },
      aiceId: par.aiceId,
      eventKey: par.eventKey,
      eventData,
      lang: par.lang,
      modelName: par.modelName,
      model: par.model,
      force: par.force,
      accountId: auth.accountId,
      sessionId: auth.sessionId,
      ipAddress: auth.meta.ipAddress,
      bridgeScope: auth.bridgeCustomerIds
        ? {
            aiceId: auth.bridgeAiceId ?? "",
            customerIds: auth.bridgeCustomerIds,
          }
        : null,
      origin,
    });

    const authPool = getAuthPool();
    if (result.kind === "error") {
      await markPARFailed(authPool, par.id, result.errorCode);
      void auditLog({
        actorId: auth.accountId,
        authContext: "general",
        action: "ai_analysis.continue_failed",
        targetType: "pending_analysis_request",
        targetId: par.id,
        details: {
          errorCode: result.errorCode,
          externalKey: par.externalKey,
        },
        ipAddress: auth.meta.ipAddress,
        sid: auth.sessionId,
        aiceId: par.aiceId,
      });
      return renderAnalyzeBridgeErrorPage(result.errorCode, result.message);
    }

    await markPARConsumed(authPool, par.id, result.viewUrl);
    void auditLog({
      actorId: auth.accountId,
      authContext: "general",
      action: "ai_analysis.continue_executed",
      targetType: "pending_analysis_request",
      targetId: par.id,
      details: {
        cached: result.cached,
        externalKey: par.externalKey,
      },
      ipAddress: auth.meta.ipAddress,
      sid: auth.sessionId,
      customerId: result.customerId,
      aiceId: par.aiceId,
    });
    return NextResponse.redirect(result.viewUrl, 302);
  });
});

const BRIDGE_ERROR_CODES: ReadonlySet<string> = new Set<AnalyzeBridgeErrorCode>(
  [
    "invalid_event_data",
    "event_key_mismatch",
    "lang_unsupported",
    "event_data_too_large",
    "authorization_failed",
    "aimer_auth_failed",
    "aimer_invalid_request",
    "aimer_call_failed",
    "aimer_unavailable",
    "redaction_failed",
    "storage_failed",
    "internal_error",
    "invalid_context_token",
    "invalid_events_envelope",
    "invalid_analyze_params_token",
  ],
);

function isBridgeErrorCode(
  value: string | null,
): value is AnalyzeBridgeErrorCode {
  return typeof value === "string" && BRIDGE_ERROR_CODES.has(value);
}
