// RFC 0002 Phase 2 (#297) — periodic report summary endpoint.
//
// `GET /api/subjects/{subject_id}/analysis/report/{period}/{bucket_date}/summary`
//
// Returns the latest non-superseded `periodic_report_result` row for the
// customer's default `(tz, lang, model_name, model)` variant, or
// `{exists: false}` when no result exists yet — or when the parent
// `periodic_report_state` is missing or archived, so the summary never
// advertises a deep link the detail page would 404 (round-9 item 2).
//
// `score_kind`: `"aggregate"` for periodic-report summaries (scores were
// derived by aimer-web from included leaf rows + baseline drift). The
// `link` is the in-app customer-scoped view URL with an **uppercase**
// period segment (`/subjects/{sid}/analysis/reports/DAILY/...`) so the
// UI route and the API path validation share one case convention.
//
// Permission gate: `reports:read`. Bridge sessions are denied on reads
// (round-15 S3): non-member → 404 (existence-hiding); member-without-perm
// → 403; bridge → 403. Path validation mirrors the regenerate endpoint
// (calendar-valid ISO date; LIVE pinned to 1970-01-01).
//
// The returned `link` carries the report-variant query params that were
// requested (`?tz=&lang=&model_name=&model=`) so the deep link opens the
// same variant the summary described instead of coercing to the default.

import type { NextRequest } from "next/server";
import {
  appLocaleToReportLanguage,
  isSupportedLocale,
  type ReportLanguage,
} from "@/i18n/locale";
import { resolveDefaultModel } from "@/lib/analysis/default-model";
import {
  isValidBucketDate,
  LIVE_BUCKET_DATE,
} from "@/lib/analysis/report-bucket-date";
import { type AuthorizeResult, authorize } from "@/lib/auth/authorization";
import { withAuth } from "@/lib/auth/guards";
import { getAuthPool } from "@/lib/db/client";
import { getCustomerRuntimePool } from "@/lib/db/customer-runtime-pool";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PERIODS = new Set(["LIVE", "DAILY", "WEEKLY", "MONTHLY"]);

// This is an API route, NOT a `[locale]` page, so it has no viewer locale to
// resolve a default language from. When `?lang=` is absent (or not a valid
// app-locale code) it falls back to the English guaranteed baseline — NOT
// `ANALYSIS_DEFAULT_LANG` — keeping the endpoint locale-stateless (#388).
// Viewer-aware callers pass the resolved locale-code `?lang=`.
const ENGLISH_BASELINE: ReportLanguage = "ENGLISH";

function extractCustomerId(req: NextRequest): string | null {
  const segments = req.nextUrl.pathname.split("/");
  let idx = segments.indexOf("subjects");
  if (idx === -1) idx = segments.indexOf("customers");
  if (idx === -1 || idx + 1 >= segments.length) return null;
  const id = segments[idx + 1];
  return UUID_RE.test(id) ? id : null;
}

function extractReportPathParts(
  req: NextRequest,
): { period: string; bucketDate: string } | null {
  const segments = req.nextUrl.pathname.split("/");
  const idx = segments.indexOf("report");
  if (idx === -1 || idx + 2 >= segments.length) return null;
  const period = segments[idx + 1];
  const bucketDate = segments[idx + 2];
  if (!PERIODS.has(period) || !isValidBucketDate(bucketDate)) return null;
  if (period === "LIVE" && bucketDate !== LIVE_BUCKET_DATE) return null;
  return { period, bucketDate };
}

function errorBody(error: string, message?: string) {
  return message ? { error, message } : { error };
}

export const GET = withAuth(
  async (req: NextRequest, auth) => {
    const subjectId = extractCustomerId(req);
    if (!subjectId) {
      return Response.json(errorBody("invalid_customer_id"), { status: 400 });
    }
    const parts = extractReportPathParts(req);
    if (!parts) {
      return Response.json(errorBody("invalid_report_path"), { status: 400 });
    }

    const pool = getAuthPool();
    const client = await pool.connect();
    let authResult: AuthorizeResult;
    let tz: string;
    let stateExists: boolean;
    let stateArchived: boolean;
    try {
      authResult = await authorize(
        client,
        "general",
        auth.accountId,
        "reports:read",
        {
          customerId: subjectId,
          operationKind: "read",
          // Bridge sessions cannot read these surfaces (round-15 S3):
          // an in-scope bridge is denied with bridge_not_allowed → 403.
          allowInBridge: false,
          bridgeScope: auth.bridgeCustomerIds
            ? {
                aiceId: auth.bridgeAiceId ?? "",
                customerIds: auth.bridgeCustomerIds,
              }
            : null,
        },
      );
      if (!authResult.authorized) {
        if (authResult.reason === "bridge_not_allowed") {
          return Response.json(errorBody(authResult.reason), { status: 403 });
        }
        if (authResult.permissions === undefined) {
          return Response.json(errorBody("report_state_not_found"), {
            status: 404,
          });
        }
        return Response.json(errorBody("Forbidden"), { status: 403 });
      }
      const tzParam = req.nextUrl.searchParams.get("tz");
      if (tzParam) {
        tz = tzParam;
      } else {
        const tzRow = await client.query<{ timezone: string }>(
          `SELECT timezone FROM customers WHERE id = $1`,
          [subjectId],
        );
        tz = tzRow.rows[0]?.timezone ?? "UTC";
      }
      // Probe the auth-side parent state for the requested tz on the same
      // connection. A missing or archived state means the detail page /
      // result-page loader would 404 (round-9 item 2): never hand out a deep
      // link the viewer cannot open. A customer timezone change archives the
      // old-tz state but can leave its `periodic_report_result` row
      // non-superseded, so a `?tz=<old tz>` summary would otherwise advertise
      // a dead link.
      const stateRow = await client.query<{ status: string }>(
        `SELECT status FROM periodic_report_state
          WHERE subject_id = $1 AND period = $2
            AND bucket_date = $3::date AND tz = $4`,
        [subjectId, parts.period, parts.bucketDate, tz],
      );
      stateExists = stateRow.rows.length > 0;
      stateArchived = stateRow.rows[0]?.status === "archived";
    } finally {
      client.release();
    }

    // Mirror the result-not-yet contract: report nothing to link to when the
    // parent state is gone or archived.
    if (!stateExists || stateArchived) {
      return Response.json({ exists: false });
    }

    // `?lang=` is an app-locale code (`en`/`ko`), validated then mapped to the
    // aimer enum here at the boundary; an absent / unrecognized value (e.g. a
    // legacy enum-shaped `KOREAN`) falls back to the English baseline.
    const langParam = req.nextUrl.searchParams.get("lang");
    const lang = isSupportedLocale(langParam)
      ? appLocaleToReportLanguage(langParam)
      : ENGLISH_BASELINE;
    // Default model is per-customer (#473): resolve the customer's
    // effective default (override → global → env) when the caller omits
    // the model axis. An explicitly supplied param still wins.
    const def = await resolveDefaultModel(subjectId);
    const modelName =
      req.nextUrl.searchParams.get("model_name") ?? def.modelName;
    const model = req.nextUrl.searchParams.get("model") ?? def.model;

    const customerPool = getCustomerRuntimePool(subjectId);
    const rows = await customerPool.query<{
      priority_tier: string;
      aggregate_severity_score: number;
      aggregate_likelihood_score: number;
    }>(
      `SELECT priority_tier,
              aggregate_severity_score,
              aggregate_likelihood_score
         FROM periodic_report_result
        WHERE subject_id = $1 AND period = $2
          AND bucket_date = $3::date AND tz = $4
          AND lang = $5 AND model_name = $6 AND model = $7
          AND superseded_at IS NULL
        ORDER BY generation DESC
        LIMIT 1`,
      [subjectId, parts.period, parts.bucketDate, tz, lang, modelName, model],
    );
    if (rows.rows.length === 0) {
      return Response.json({ exists: false });
    }
    const row = rows.rows[0];
    // Forward only the variant params the caller actually requested so the
    // deep link opens the same variant. Omitted selectors stay implicit and
    // resolve to the page's defaults, matching pre-existing link behavior.
    // `lang` is kept in the locale-code vocabulary (the page reinterprets
    // `?lang=` as `en`/`ko`), so only a valid locale code is forwarded; an
    // unrecognized value is dropped rather than leaking an enum into the URL.
    const linkQuery = new URLSearchParams();
    for (const key of ["tz", "model_name", "model"] as const) {
      const value = req.nextUrl.searchParams.get(key);
      if (value) linkQuery.set(key, value);
    }
    if (isSupportedLocale(langParam)) linkQuery.set("lang", langParam);
    const linkQs = linkQuery.toString();
    return Response.json({
      exists: true,
      priority_tier: row.priority_tier,
      severity_score: row.aggregate_severity_score,
      likelihood_score: row.aggregate_likelihood_score,
      score_kind: "aggregate",
      // Customer-scoped, uppercase-period view URL (item 4 / case lock),
      // carrying the requested variant so the deep link is variant-faithful.
      link: `/subjects/${subjectId}/analysis/reports/${parts.period}/${parts.bucketDate}${
        linkQs ? `?${linkQs}` : ""
      }`,
    });
  },
  { ctx: "general" },
);
