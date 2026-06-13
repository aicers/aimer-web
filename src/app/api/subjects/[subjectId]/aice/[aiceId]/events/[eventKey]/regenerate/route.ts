// #463 — in-app single-event regenerate endpoint.
//
// `POST /api/subjects/{subjectId}/aice/{aiceId}/events/{eventKey}/regenerate`
//
// Optional `?lang=…&model_name=…&model=…` selecting the variant to
// regenerate (defaults to the env-configured variant when absent). The
// event page is itself variant-specific, so the button forwards the
// page's current `(lang, model_name, model)` and this endpoint regenerates
// exactly that variant (B1) — choosing a *different* model is the
// out-of-scope B2 picker.
//
// Unlike the aice-web-next "Force Rerun" link (which re-ingests a fresh
// RAW event from source), this path holds redaction constant: it sources
// the already-stored `detection_events.redacted_event` + its
// `redaction_policy_version`, recovers `event_time` from it, re-calls
// aimer with that redacted event, and writes a new generation. aimer never
// sees raw payload and aice-web-next is not touched.
//
// Authorizes `analyses:configure` with `operationKind: "write"` (the
// analyst-only permission the story regenerate route uses), NOT
// `analyses:create`: this endpoint powers the analyst-only regenerate
// button. A bridge session can never pass a write authorization
// (`bridge_write_blocked`), which is why the button is gated on
// `canRegenerate` (analyst AND not a bridge session) in the loader.
//
// Event analysis is synchronous today, so this endpoint stays synchronous
// (no job table / worker for events) and returns `200 { generation }`. The
// client navigates to the new generation using its own locale + the
// variant params, so the endpoint never builds a URL server-side.

import type { NextRequest } from "next/server";
import { appLocaleToReportLanguage, isSupportedLocale } from "@/i18n/locale";
import { analyzeErrorResponse } from "@/lib/analysis/analyze-types";
import { resolveDefaultModel } from "@/lib/analysis/default-model";
import { regenerateEventLeaf } from "@/lib/analysis/regenerate-event";
import { isSupportedLang } from "@/lib/analysis/run-analyze-flow";
import { authorize } from "@/lib/auth/authorization";
import { HttpError } from "@/lib/auth/errors";
import { verifyCsrf, verifyOrigin, withAuth } from "@/lib/auth/guards";
import { getAuthPool } from "@/lib/db/client";
import { getCustomerRuntimePool } from "@/lib/db/customer-runtime-pool";
import { eventKeyString } from "@/lib/event-key";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Default to the app user language (#581): an absent `?lang` regenerates the
// viewer-facing variant (which derives from the English canonical), not a
// hard-coded English. The button always forwards an explicit `?lang`, so this
// only governs direct API calls. The enum contract is unchanged.
const DEFAULT_LOCALE = process.env.DEFAULT_LOCALE ?? "ko";
const DEFAULT_LANG = isSupportedLocale(DEFAULT_LOCALE)
  ? appLocaleToReportLanguage(DEFAULT_LOCALE)
  : "ENGLISH";

// aimer's `Language` GraphQL enum is closed; the API boundary enforces it
// so a bad value cannot reach the LLM call.
const ALLOWED_LANGS = new Set(["KOREAN", "ENGLISH"]);

function pathSegmentAfter(req: NextRequest, marker: string): string | null {
  const segments = req.nextUrl.pathname.split("/");
  const idx = segments.indexOf(marker);
  if (idx === -1 || idx + 1 >= segments.length) return null;
  const raw = segments[idx + 1];
  if (!raw) return null;
  try {
    return decodeURIComponent(raw);
  } catch {
    return null;
  }
}

function errorBody(error: string, message?: string) {
  return message ? { error, message } : { error };
}

export const POST = withAuth(
  async (req: NextRequest, auth) => {
    const originErr = verifyOrigin(req);
    if (originErr) return originErr;
    const csrfErr = verifyCsrf(req, {
      ctx: auth.authContext,
      sid: auth.sessionId,
      iat: auth.iat,
    });
    if (csrfErr) return csrfErr;

    const subjectId = pathSegmentAfter(req, "subjects");
    if (!subjectId || !UUID_RE.test(subjectId)) {
      return Response.json(errorBody("invalid_customer_id"), { status: 400 });
    }
    const aiceId = pathSegmentAfter(req, "aice");
    if (!aiceId) {
      return Response.json(errorBody("invalid_aice_id"), { status: 400 });
    }
    const eventKey = pathSegmentAfter(req, "events");
    if (!eventKey || !eventKeyString.safeParse(eventKey).success) {
      return Response.json(errorBody("invalid_event_key"), { status: 400 });
    }

    const lang = req.nextUrl.searchParams.get("lang") ?? DEFAULT_LANG;
    if (!ALLOWED_LANGS.has(lang) || !isSupportedLang(lang)) {
      return Response.json(
        errorBody("invalid_param", "lang must be one of KOREAN, ENGLISH"),
        { status: 400 },
      );
    }
    // Default model is per-customer (#473): resolve the customer's
    // effective default (override → global → env) when the caller omits
    // the model axis. An explicitly supplied param still wins.
    const modelNameParam = req.nextUrl.searchParams.get("model_name");
    const modelParam = req.nextUrl.searchParams.get("model");

    const authPool = getAuthPool();
    const client = await authPool.connect();
    try {
      const def = await resolveDefaultModel(subjectId, client);
      const modelName = modelNameParam ?? def.modelName;
      const model = modelParam ?? def.model;
      // Use `authorize()` directly so a bridge-write rejection surfaces as
      // `{error: "bridge_write_blocked"}` rather than a generic 403 — same
      // contract as the story regenerate route (#296/#463).
      const authResult = await authorize(
        client,
        "general",
        auth.accountId,
        "analyses:configure",
        {
          customerId: subjectId,
          aiceId,
          requiresAiceId: true,
          operationKind: "write",
          bridgeScope: auth.bridgeCustomerIds
            ? {
                aiceId: auth.bridgeAiceId ?? "",
                customerIds: auth.bridgeCustomerIds,
              }
            : null,
        },
      );
      if (!authResult.authorized) {
        // Bridge-write / bridge-not-allowed leak only session-type.
        if (authResult.reason) {
          return Response.json(errorBody(authResult.reason), { status: 403 });
        }
        // Non-member: `authorizeGeneral` returns early without a permission
        // set. Surface as 404 to hide event existence (uniform with the
        // page route's existence-hiding 404).
        if (authResult.permissions === undefined) {
          return Response.json(errorBody("event_not_found"), { status: 404 });
        }
        // Member without the required permission — precise 403.
        return Response.json(errorBody("Forbidden"), { status: 403 });
      }

      // Source the event from storage, NOT the request body — via the
      // shared regenerate helper (#463 → #470 extraction). The button is
      // hidden when no `detection_events` row survives (retention swept the
      // source but the analysis row remains), so the `source_unavailable`
      // 404 is a server-side guard for a button that won't normally be
      // shown — it is NOT a "fall back to Force Rerun" case. The bulk
      // backfill (#470) calls the same helper per event.
      const customerPool = getCustomerRuntimePool(subjectId);
      const outcome = await regenerateEventLeaf({
        authPool,
        customerPool,
        customerId: subjectId,
        aiceId,
        eventKey,
        lang,
        modelName,
        model,
        accountId: auth.accountId,
        auditMeta: { ipAddress: auth.meta.ipAddress, sid: auth.sessionId },
        force: true,
      });
      if (outcome.kind === "source_unavailable") {
        return Response.json(errorBody("source_unavailable"), { status: 404 });
      }
      if (outcome.kind === "error") {
        return analyzeErrorResponse(outcome.errorCode, outcome.message);
      }

      // Locale-agnostic: return `{ generation }` only. The client builds the
      // target URL from its own locale + variant params, so we never reuse
      // the analyze flow's hardcoded `en` permalink locale.
      return Response.json({ generation: outcome.generation }, { status: 200 });
    } catch (err) {
      if (err instanceof HttpError) {
        return Response.json(errorBody(err.message), {
          status: err.statusCode,
        });
      }
      throw err;
    } finally {
      client.release();
    }
  },
  { ctx: "general" },
);
