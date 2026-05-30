// RFC 0002 Phase 2 (#297) — periodic report summary endpoint.
//
// `GET /api/customers/{customer_id}/analysis/report/{period}/{bucket_date}/summary`
//
// Returns the latest non-superseded `periodic_report_result` row for the
// customer's default `(tz, lang, model_name, model)` variant, or
// `{exists: false}` when no result exists yet.
//
// `score_kind`: `"aggregate"` for periodic-report summaries (scores were
// derived by aimer-web from included leaf rows + baseline drift). The
// `link` is the in-app customer-scoped view URL with an **uppercase**
// period segment (`/customers/{cid}/analysis/reports/DAILY/...`) so the
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

const DEFAULT_LANG = process.env.ANALYSIS_DEFAULT_LANG ?? "ENGLISH";
const DEFAULT_MODEL_NAME = process.env.ANALYSIS_DEFAULT_MODEL_NAME ?? "openai";
const DEFAULT_MODEL = process.env.ANALYSIS_DEFAULT_MODEL ?? "gpt-4o";

function extractCustomerId(req: NextRequest): string | null {
  const segments = req.nextUrl.pathname.split("/");
  const idx = segments.indexOf("customers");
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
    const customerId = extractCustomerId(req);
    if (!customerId) {
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
    try {
      authResult = await authorize(
        client,
        "general",
        auth.accountId,
        "reports:read",
        {
          customerId,
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
          [customerId],
        );
        tz = tzRow.rows[0]?.timezone ?? "UTC";
      }
    } finally {
      client.release();
    }

    const lang = req.nextUrl.searchParams.get("lang") ?? DEFAULT_LANG;
    const modelName =
      req.nextUrl.searchParams.get("model_name") ?? DEFAULT_MODEL_NAME;
    const model = req.nextUrl.searchParams.get("model") ?? DEFAULT_MODEL;

    const customerPool = getCustomerRuntimePool(customerId);
    const rows = await customerPool.query<{
      priority_tier: string;
      aggregate_severity_score: number;
      aggregate_likelihood_score: number;
    }>(
      `SELECT priority_tier,
              aggregate_severity_score,
              aggregate_likelihood_score
         FROM periodic_report_result
        WHERE customer_id = $1 AND period = $2
          AND bucket_date = $3::date AND tz = $4
          AND lang = $5 AND model_name = $6 AND model = $7
          AND superseded_at IS NULL
        ORDER BY generation DESC
        LIMIT 1`,
      [customerId, parts.period, parts.bucketDate, tz, lang, modelName, model],
    );
    if (rows.rows.length === 0) {
      return Response.json({ exists: false });
    }
    const row = rows.rows[0];
    // Forward only the variant params the caller actually requested so the
    // deep link opens the same variant. Omitted selectors stay implicit and
    // resolve to the page's defaults, matching pre-existing link behavior.
    const linkQuery = new URLSearchParams();
    for (const key of ["tz", "lang", "model_name", "model"] as const) {
      const value = req.nextUrl.searchParams.get(key);
      if (value) linkQuery.set(key, value);
    }
    const linkQs = linkQuery.toString();
    return Response.json({
      exists: true,
      priority_tier: row.priority_tier,
      severity_score: row.aggregate_severity_score,
      likelihood_score: row.aggregate_likelihood_score,
      score_kind: "aggregate",
      // Customer-scoped, uppercase-period view URL (item 4 / case lock),
      // carrying the requested variant so the deep link is variant-faithful.
      link: `/customers/${customerId}/analysis/reports/${parts.period}/${parts.bucketDate}${
        linkQs ? `?${linkQs}` : ""
      }`,
    });
  },
  { ctx: "general" },
);
