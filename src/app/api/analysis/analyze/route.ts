import type { NextRequest } from "next/server";
import { z } from "zod";
import {
  type AnalyzeErrorCode,
  analyzeErrorResponse,
  type EventAnalysisResultRow,
} from "@/lib/analysis/analyze-types";
import {
  type CustomerLookup,
  isSupportedLang,
  LANG_VALUES,
  runAnalyzeFlow,
} from "@/lib/analysis/run-analyze-flow";
import { canonicalOrigin } from "@/lib/auth/canonical-origin";
import {
  type AuthenticatedRequest,
  verifyCsrf,
  verifyOrigin,
  withAuth,
} from "@/lib/auth/guards";
import { eventKeyString } from "@/lib/event-key";

const DEFAULT_MAX_PAYLOAD_BYTES = 50 * 1024 * 1024; // 50 MB

function getMaxPayloadBytes(): number {
  const envVal = process.env.BRIDGE_MAX_PAYLOAD_BYTES;
  if (envVal) {
    const parsed = Number(envVal);
    if (Number.isFinite(parsed) && parsed > 0) return parsed;
  }
  return DEFAULT_MAX_PAYLOAD_BYTES;
}

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

export const POST = withAuth(async (req: NextRequest, auth) => {
  try {
    return await handlePost(req, auth);
  } catch (err) {
    return analyzeErrorResponse(
      "internal_error",
      err instanceof Error ? err.message : "unexpected error",
    );
  }
});

async function handlePost(
  req: NextRequest,
  auth: AuthenticatedRequest,
): Promise<Response> {
  const originErr = verifyOrigin(req);
  if (originErr) return originErr;

  const csrfErr = verifyCsrf(req, {
    ctx: "general",
    sid: auth.sessionId,
    iat: auth.iat,
  });
  if (csrfErr) return csrfErr;

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

  if (!isSupportedLang(parsed.lang)) {
    return analyzeErrorResponse(
      "lang_unsupported",
      `lang must be one of ${LANG_VALUES.join(", ")}`,
    );
  }

  const customer: CustomerLookup = parsed.customer_id
    ? { kind: "id", customerId: parsed.customer_id }
    : { kind: "externalKey", externalKey: parsed.external_key ?? "" };

  const result = await runAnalyzeFlow({
    customer,
    aiceId: parsed.aice_id,
    eventKey: parsed.event_key,
    eventData: parsed.event_data,
    lang: parsed.lang,
    modelName: parsed.model_name,
    model: parsed.model,
    force: parsed.force,
    accountId: auth.accountId,
    sessionId: auth.sessionId,
    ipAddress: auth.meta.ipAddress,
    bridgeScope: auth.bridgeCustomerIds
      ? {
          aiceId: auth.bridgeAiceId ?? "",
          customerIds: auth.bridgeCustomerIds,
        }
      : null,
    origin: canonicalOrigin(req),
  });

  if (result.kind === "error") {
    return analyzeErrorResponse(result.errorCode, result.message);
  }

  return Response.json({ view_url: result.viewUrl, cached: result.cached });
}

// Re-export the row type so tests / page loader can share it.
export type { AnalyzeErrorCode, EventAnalysisResultRow };
