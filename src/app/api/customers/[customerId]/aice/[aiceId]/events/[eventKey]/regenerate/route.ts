// #463 — in-app single-event regenerate endpoint.
//
// `POST /api/customers/{customerId}/aice/{aiceId}/events/{eventKey}/regenerate`
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
import { analyzeErrorResponse } from "@/lib/analysis/analyze-types";
import { parseEventTime } from "@/lib/analysis/event-time";
import {
  analyzeAndStoreEventResult,
  isSupportedLang,
  type SupportedLang,
} from "@/lib/analysis/run-analyze-flow";
import { authorize } from "@/lib/auth/authorization";
import { HttpError } from "@/lib/auth/errors";
import { verifyCsrf, verifyOrigin, withAuth } from "@/lib/auth/guards";
import { getAuthPool } from "@/lib/db/client";
import { getCustomerRuntimePool } from "@/lib/db/customer-runtime-pool";
import { eventKeyString } from "@/lib/event-key";
import {
  decryptRedactionMap,
  loadCustomerOwnedDomains,
  loadCustomerRanges,
  type RedactionMap,
} from "@/lib/redaction";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const DEFAULT_LANG = process.env.ANALYSIS_DEFAULT_LANG ?? "ENGLISH";
const DEFAULT_MODEL_NAME = process.env.ANALYSIS_DEFAULT_MODEL_NAME ?? "openai";
const DEFAULT_MODEL = process.env.ANALYSIS_DEFAULT_MODEL ?? "gpt-4o";

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

    const customerId = pathSegmentAfter(req, "customers");
    if (!customerId || !UUID_RE.test(customerId)) {
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
    const modelName =
      req.nextUrl.searchParams.get("model_name") ?? DEFAULT_MODEL_NAME;
    const model = req.nextUrl.searchParams.get("model") ?? DEFAULT_MODEL;

    const authPool = getAuthPool();
    const client = await authPool.connect();
    try {
      // Use `authorize()` directly so a bridge-write rejection surfaces as
      // `{error: "bridge_write_blocked"}` rather than a generic 403 — same
      // contract as the story regenerate route (#296/#463).
      const authResult = await authorize(
        client,
        "general",
        auth.accountId,
        "analyses:configure",
        {
          customerId,
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

      // Source the event from storage, NOT the request body. The button is
      // hidden when no `detection_events` row survives (retention swept the
      // source but the analysis row remains), so this 404 is a server-side
      // guard for a button that won't normally be shown — it is NOT a
      // "fall back to Force Rerun" case.
      const customerPool = getCustomerRuntimePool(customerId);
      const sourceRow = await customerPool.query<{
        redacted_event: unknown;
        redaction_policy_version: string;
      }>(
        `SELECT redacted_event, redaction_policy_version
           FROM detection_events
          WHERE aice_id = $1 AND event_key = $2::numeric`,
        [aiceId, eventKey],
      );
      if (sourceRow.rows.length === 0) {
        return Response.json(errorBody("source_unavailable"), { status: 404 });
      }
      const { redacted_event: redactedEvent, redaction_policy_version } =
        sourceRow.rows[0];

      // Recover `event_time` from the stored redacted event (the cache-
      // poisoning guard the analyze flow already uses). A stored event that
      // somehow lacks a parseable `event_time` cannot be re-analyzed.
      const eventTimeForAimer =
        typeof redactedEvent === "object" && redactedEvent !== null
          ? parseEventTime(
              (redactedEvent as Record<string, unknown>).event_time,
            )
          : null;
      if (eventTimeForAimer === null) {
        return analyzeErrorResponse(
          "event_time_invalid",
          "stored redacted_event.event_time is missing or invalid",
        );
      }

      // Load the redaction map for the hallucination scan over the LLM
      // output. A decrypt failure (KEK rotation race / vault outage) is
      // non-fatal: the scan runs against an empty map rather than failing
      // the regenerate, mirroring the read loader's degradation.
      let mergedMap: RedactionMap = {};
      const mapRow = await customerPool.query<{
        ciphertext: Buffer;
        wrapped_dek: string;
      }>(
        `SELECT ciphertext, wrapped_dek FROM event_redaction_map
          WHERE aice_id = $1 AND event_key = $2::numeric`,
        [aiceId, eventKey],
      );
      if (mapRow.rows.length > 0) {
        try {
          mergedMap = await decryptRedactionMap(
            customerId,
            mapRow.rows[0].ciphertext,
            mapRow.rows[0].wrapped_dek,
          );
        } catch {
          mergedMap = {};
        }
      }

      const ranges = await loadCustomerRanges(authPool, customerId);
      const ownedDomains = await loadCustomerOwnedDomains(authPool, customerId);

      const langForStorage: SupportedLang = lang;
      const stored = await analyzeAndStoreEventResult({
        customerPool,
        aiceId,
        eventKey,
        redactedEvent,
        eventTimeForAimer,
        // Regenerate the exact viewed variant: pass the concrete lang as
        // both the GraphQL variable and the storage PK component.
        lang: langForStorage,
        langForStorage,
        modelName,
        model,
        accountId: auth.accountId,
        mergedMap,
        ranges,
        ownedDomains,
        // Hold redaction constant: stamp the STORED policy version rather
        // than recomputing under current policy (that is Force Rerun's job).
        redactionPolicyVersion: redaction_policy_version,
        auditBase: {
          actorId: auth.accountId,
          authContext: "general",
          targetType: "event_analysis_result",
          ipAddress: auth.meta.ipAddress,
          sid: auth.sessionId,
          customerId,
          aiceId,
        },
        force: true,
      });
      if (stored.kind === "error") {
        return analyzeErrorResponse(stored.errorCode, stored.message);
      }

      // Locale-agnostic: return `{ generation }` only. The client builds the
      // target URL from its own locale + variant params, so we never reuse
      // the analyze flow's hardcoded `en` permalink locale.
      return Response.json({ generation: stored.generation }, { status: 200 });
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
