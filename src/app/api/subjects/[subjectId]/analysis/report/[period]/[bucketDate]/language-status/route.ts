// #388 (L2 phase 2) — read-only on-demand report-language job status.
//
// `GET /api/subjects/{subject_id}/analysis/report/{period}/{bucket_date}/language-status`
//
// Returns the `periodic_report_job.status` for the requested report-language
// variant, so the detail page can poll a not-yet-available language's
// queued→processing→done/failed transition WITHOUT re-enqueuing. This endpoint
// is deliberately READ-ONLY: enqueue (with its failed→queued retry) happens
// once in the page loader on view; if polling also enqueued, a persistently
// failing job would be retried on every poll and never surface as `failed`
// (the "no infinite spinner" contract).
//
// `?lang=` is an app-locale code (`en`/`ko`), validated then mapped to the
// aimer enum at this boundary (#388 locale-code URL contract); an absent /
// unrecognized value falls back to the English baseline. Permission gate and
// path validation mirror the summary endpoint.

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
import { authorize } from "@/lib/auth/authorization";
import { withAuth } from "@/lib/auth/guards";
import { getAuthPool } from "@/lib/db/client";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PERIODS = new Set(["LIVE", "DAILY", "WEEKLY", "MONTHLY"]);
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

export const GET = withAuth(
  async (req: NextRequest, auth) => {
    const subjectId = extractCustomerId(req);
    if (!subjectId) {
      return Response.json({ error: "invalid_customer_id" }, { status: 400 });
    }
    const parts = extractReportPathParts(req);
    if (!parts) {
      return Response.json({ error: "invalid_report_path" }, { status: 400 });
    }

    const pool = getAuthPool();
    const client = await pool.connect();
    let tz: string;
    try {
      const authResult = await authorize(
        client,
        "general",
        auth.accountId,
        "reports:read",
        {
          customerId: subjectId,
          operationKind: "read",
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
          return Response.json({ error: authResult.reason }, { status: 403 });
        }
        if (authResult.permissions === undefined) {
          return Response.json({ error: "not_found" }, { status: 404 });
        }
        return Response.json({ error: "Forbidden" }, { status: 403 });
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

      const langParam = req.nextUrl.searchParams.get("lang");
      const lang = isSupportedLocale(langParam)
        ? appLocaleToReportLanguage(langParam)
        : ENGLISH_BASELINE;
      // Default model is per-customer (#473): resolve on the same auth
      // client (override → global → env). An explicit param still wins.
      const def = await resolveDefaultModel(subjectId, client);
      const modelName =
        req.nextUrl.searchParams.get("model_name") ?? def.modelName;
      const model = req.nextUrl.searchParams.get("model") ?? def.model;

      const jobRow = await client.query<{ status: string }>(
        `SELECT status FROM periodic_report_job
          WHERE subject_id = $1 AND period = $2
            AND bucket_date = $3::date AND tz = $4
            AND lang = $5 AND model_name = $6 AND model = $7`,
        [subjectId, parts.period, parts.bucketDate, tz, lang, modelName, model],
      );
      return Response.json({ status: jobRow.rows[0]?.status ?? null });
    } finally {
      client.release();
    }
  },
  { ctx: "general" },
);
