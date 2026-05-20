import { createHash } from "node:crypto";
import { type NextRequest, NextResponse } from "next/server";
import {
  renderAnalyzeBridgeErrorPage,
  renderAnalyzeBridgeInProgressPage,
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
  claimPAR,
  loadPendingAnalysisRequest,
  markPARConsumed,
  markPARFailed,
  type PendingAnalysisRequest,
} from "@/lib/auth/analyze-bridge";
import { authorize } from "@/lib/auth/authorization";
import { getCustomerByExternalKey } from "@/lib/auth/customers";
import { type AuthenticatedRequest, withAuth } from "@/lib/auth/guards";
import { decryptPayload } from "@/lib/crypto/envelope";
import { getAuthPool, withTransaction } from "@/lib/db/client";

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

    // Re-authorize against the PAR's (customer, aiceId) BEFORE any
    // status-dependent branch. `withAuth` only proves the request
    // carries a valid general-context session — it does not prove this
    // account is permitted to view the PAR's analysis. Without this
    // check, any authenticated account that obtains or guesses a PAR
    // UUID could observe the stored `view_url` (consumed) or probe
    // terminal `failed`/`expired` state. The check matches the
    // `authorize(...)` invocation in `runAnalyzeFlow` so the pre- and
    // post-flow surfaces stay aligned.
    const authzResult = await authorizePARAccess(par, auth);
    if (authzResult.kind === "denied") {
      void auditLog({
        actorId: auth.accountId,
        authContext: "general",
        action: "ai_analysis.continue_failed",
        targetType: "pending_analysis_request",
        targetId: par.id,
        details: {
          errorCode: "authorization_failed",
          stage: "authorize",
          externalKey: par.externalKey,
        },
        ipAddress: auth.meta.ipAddress,
        sid: auth.sessionId,
        aiceId: par.aiceId,
      });
      return renderAnalyzeBridgeErrorPage(
        "authorization_failed",
        "not authorized",
      );
    }

    const dispatch = await dispatchStatus(par, auth);
    if (dispatch) return dispatch;

    // status === "pending": claim before running the flow so concurrent
    // /continue requests on the same PAR cannot both invoke
    // `runAnalyzeFlow`. A failed CAS means another tick already claimed
    // (or terminated) the row — re-read and dispatch.
    const claimed = await claimPAR(getAuthPool(), par.id);
    if (!claimed) {
      const reloaded = await loadPendingAnalysisRequest(getAuthPool(), par.id);
      if (!reloaded) return renderAnalyzeBridgeNotFoundPage();
      const followUp = await dispatchStatus(reloaded, auth);
      if (followUp) return followUp;
      // Still pending after a failed claim should be impossible (a
      // failed CAS means the row left `pending`); fall through to the
      // in-progress page as a safe default rather than racing again.
      return renderAnalyzeBridgeInProgressPage();
    }

    if (!isSupportedLang(par.lang)) {
      const updated = await markPARFailed(
        getAuthPool(),
        par.id,
        "lang_unsupported",
      );
      if (!updated) {
        // Cleanup sweep flipped the row to `expired` (or another tick
        // latched a terminal state) between our `processing` claim and
        // this terminal CAS. Honour the authoritative status rather
        // than emitting a `lang_unsupported` page a reload would not
        // reproduce.
        return await handleTerminalCASFalse(par.id, auth);
      }
      void auditLog({
        actorId: auth.accountId,
        authContext: "general",
        action: "ai_analysis.continue_failed",
        targetType: "pending_analysis_request",
        targetId: par.id,
        details: {
          errorCode: "lang_unsupported",
          stage: "lang_check",
          externalKey: par.externalKey,
        },
        ipAddress: auth.meta.ipAddress,
        sid: auth.sessionId,
        aiceId: par.aiceId,
      });
      return renderAnalyzeBridgeErrorPage(
        "lang_unsupported",
        `lang must be one of KOREAN, ENGLISH`,
      );
    }

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
      const updated = await markPARFailed(
        getAuthPool(),
        par.id,
        "internal_error",
      );
      if (!updated) {
        // Cleanup sweep won the race during our in-flight window —
        // route through the same re-read dispatcher the post-flow
        // terminal CAS uses.
        return await handleTerminalCASFalse(par.id, auth);
      }
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

    const origin = request.nextUrl.origin;
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
      const updated = await markPARFailed(authPool, par.id, result.errorCode);
      if (!updated) {
        // The row left `pending`/`processing` between claim and terminal
        // CAS — most commonly because the cleanup sweep flipped it to
        // `expired` while `runAnalyzeFlow` was running. Re-read and
        // dispatch on the new state so the response matches what a
        // reload would show.
        return await handleTerminalCASFalse(par.id, auth);
      }
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

    const consumed = await markPARConsumed(authPool, par.id, result.viewUrl);
    if (!consumed) {
      // Same race as above on the success path. `runAnalyzeFlow` did
      // complete and a `view_url` exists, but the PAR row has already
      // left `processing` — most likely `expired` by the cleanup sweep.
      // Honour the row's authoritative state rather than asserting
      // success the reload would not reproduce.
      return await handleTerminalCASFalse(par.id, auth);
    }
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

/**
 * Re-read the PAR and dispatch on its new status after a terminal
 * `markPARConsumed`/`markPARFailed` CAS returned false. The row could
 * be `expired` (cleanup sweep won the race), `consumed`/`failed`
 * (another tick latched a result first), or, in pathological cases,
 * gone entirely.
 */
async function handleTerminalCASFalse(
  parId: string,
  auth: AuthenticatedRequest,
): Promise<Response> {
  const reloaded = await loadPendingAnalysisRequest(getAuthPool(), parId);
  if (!reloaded) return renderAnalyzeBridgeNotFoundPage();
  const dispatched = await dispatchStatus(reloaded, auth);
  if (dispatched) return dispatched;
  // Still `pending` is structurally impossible — we just took the
  // `processing` claim ourselves — but render the in-progress page as
  // a safe default so we never echo a stale `view_url`.
  return renderAnalyzeBridgeInProgressPage();
}

/**
 * Resolve the PAR's customer by `external_key` and run the same
 * `authorize(...)` check `runAnalyzeFlow` performs. Called before any
 * status-based dispatch so unauthorized accounts cannot probe
 * `consumed`/`failed`/`expired` terminal state via a guessed PAR id.
 */
async function authorizePARAccess(
  par: PendingAnalysisRequest,
  auth: AuthenticatedRequest,
): Promise<{ kind: "allowed" } | { kind: "denied" }> {
  const authPool = getAuthPool();
  const customer = await getCustomerByExternalKey(authPool, par.externalKey);
  if (!customer) return { kind: "denied" };

  const bridgeScope = auth.bridgeCustomerIds
    ? {
        aiceId: auth.bridgeAiceId ?? "",
        customerIds: auth.bridgeCustomerIds,
      }
    : null;

  const result = await withTransaction(authPool, (client) =>
    authorize(client, "general", auth.accountId, "analyses:create", {
      customerId: customer.id,
      aiceId: par.aiceId,
      requiresAiceId: true,
      operationKind: "process",
      bridgeScope,
    }),
  );
  return result.authorized ? { kind: "allowed" } : { kind: "denied" };
}

async function dispatchStatus(
  par: PendingAnalysisRequest,
  auth: AuthenticatedRequest,
): Promise<Response | null> {
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
    case "processing":
      return renderAnalyzeBridgeInProgressPage();
    case "pending":
      return null;
  }
}

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
