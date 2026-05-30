// RFC 0002 Phase 2 (#297) — periodic report regenerate endpoint.
//
// `POST /api/customers/{customer_id}/analysis/report/{period}/{bucket_date}/regenerate`
//
// Optional `?tz=…&lang=…&model_name=…&model=…`. Unlike the story
// endpoint, `tz` IS accepted (periodic reports are timezone-keyed);
// it defaults to the customer's current `customers.timezone`.
//
// Order of checks (round-14 item 4 / round-15 S3): path validation →
// origin/CSRF → authorize (401 / non-member 404 / member-without-perm
// 403 / bridge 403) → Phase 2 period rejection (WEEKLY/MONTHLY →
// 400 period_not_yet_supported) → source-availability precheck
// (missing state row → 404 report_state_not_found; archived → 409
// source_unavailable) → UPSERT job row.
//
// Two branches per RFC §"Force regenerate":
//   - Existing row for `(tz, lang, model_name, model)` → UPDATE
//     generation+1, status='queued', attempts=0, last_error=NULL,
//     dry_run=FALSE, force timestamps refreshed. UNCONDITIONAL on prior
//     status — the in-flight worker is defensive via captured generation.
//   - No row → INSERT generation=1, status='queued', force timestamps set.
//
// Returns 202 with `{state_pk: {customer_id, period, bucket_date, tz},
// variant: {tz, lang, model_name, model}, generation}`.

import type { NextRequest } from "next/server";
import {
  isValidBucketDate,
  LIVE_BUCKET_DATE,
} from "@/lib/analysis/report-bucket-date";
import { authorize } from "@/lib/auth/authorization";
import { HttpError } from "@/lib/auth/errors";
import { verifyCsrf, verifyOrigin, withAuth } from "@/lib/auth/guards";
import { getAuthPool } from "@/lib/db/client";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// Path-shape set stays all four periods (#298 lifts the rejection). The
// Phase 2 real handler rejects WEEKLY/MONTHLY *after* auth so denied
// callers still see their denial code first.
const PERIODS = new Set(["LIVE", "DAILY", "WEEKLY", "MONTHLY"]);
const PHASE2_PERIODS = new Set(["LIVE", "DAILY"]);

const DEFAULT_LANG = process.env.ANALYSIS_DEFAULT_LANG ?? "ENGLISH";
const DEFAULT_MODEL_NAME = process.env.ANALYSIS_DEFAULT_MODEL_NAME ?? "openai";
const DEFAULT_MODEL = process.env.ANALYSIS_DEFAULT_MODEL ?? "gpt-4o";
const ALLOWED_LANGS = new Set(["KOREAN", "ENGLISH"]);

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
  // LIVE rows are pinned to the synthetic bucket date `1970-01-01`.
  if (period === "LIVE" && bucketDate !== LIVE_BUCKET_DATE) return null;
  return { period, bucketDate };
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

    const customerId = extractCustomerId(req);
    if (!customerId) {
      return Response.json(errorBody("invalid_customer_id"), { status: 400 });
    }
    const parts = extractReportPathParts(req);
    if (!parts) {
      return Response.json(errorBody("invalid_report_path"), { status: 400 });
    }

    const lang = req.nextUrl.searchParams.get("lang") ?? DEFAULT_LANG;
    if (!ALLOWED_LANGS.has(lang)) {
      return Response.json(
        errorBody("invalid_param", "lang must be one of KOREAN, ENGLISH"),
        { status: 400 },
      );
    }
    const modelName =
      req.nextUrl.searchParams.get("model_name") ?? DEFAULT_MODEL_NAME;
    const model = req.nextUrl.searchParams.get("model") ?? DEFAULT_MODEL;

    const pool = getAuthPool();
    const client = await pool.connect();
    try {
      const authResult = await authorize(
        client,
        "general",
        auth.accountId,
        "reports:create",
        {
          customerId,
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
        // Bridge denials leak only session-type — keep their 403.
        if (authResult.reason) {
          return Response.json(errorBody(authResult.reason), { status: 403 });
        }
        // Non-member: existence-hiding 404 (round-15 S3).
        if (authResult.permissions === undefined) {
          return Response.json(errorBody("report_state_not_found"), {
            status: 404,
          });
        }
        // Member without the required permission — precise 403.
        return Response.json(errorBody("Forbidden"), { status: 403 });
      }

      // Phase 2 boundary (round-14 item 4): WEEKLY/MONTHLY are not yet
      // processed. Rejected only after the caller has cleared auth, so a
      // denied caller sees its denial code (401/404/403), not this.
      if (!PHASE2_PERIODS.has(parts.period)) {
        return Response.json(errorBody("period_not_yet_supported"), {
          status: 400,
        });
      }

      // Default tz = the customer's current timezone snapshot.
      const tzParam = req.nextUrl.searchParams.get("tz");
      let tz = tzParam ?? null;
      if (!tz) {
        const tzRow = await client.query<{ timezone: string }>(
          `SELECT timezone FROM customers WHERE id = $1`,
          [customerId],
        );
        tz = tzRow.rows[0]?.timezone ?? "UTC";
      }

      // Source-availability precheck. Force-regenerate is not a seeding
      // path — it creates a variant job only when the state row exists.
      const stateRow = await client.query<{ status: string }>(
        `SELECT status FROM periodic_report_state
          WHERE customer_id = $1 AND period = $2
            AND bucket_date = $3::date AND tz = $4`,
        [customerId, parts.period, parts.bucketDate, tz],
      );
      if (stateRow.rows.length === 0) {
        return Response.json(errorBody("report_state_not_found"), {
          status: 404,
        });
      }
      if (stateRow.rows[0].status === "archived") {
        return Response.json(errorBody("source_unavailable"), { status: 409 });
      }

      // UPSERT the job row keyed on the full variant PK.
      const upsertRes = await client.query<{
        generation: number;
        inserted: boolean;
      }>(
        `INSERT INTO periodic_report_job
           (customer_id, period, bucket_date, tz, lang, model_name, model,
            status, generation, dry_run,
            force_requested_at, force_requested_by,
            attempts, last_error)
         VALUES ($1, $2, $3::date, $4, $5, $6, $7,
                 'queued', 1, FALSE,
                 NOW(), $8::uuid,
                 0, NULL)
         ON CONFLICT (customer_id, period, bucket_date, tz, lang, model_name, model)
         DO UPDATE SET
           generation         = periodic_report_job.generation + 1,
           status             = 'queued',
           dry_run            = FALSE,
           force_requested_at = NOW(),
           force_requested_by = EXCLUDED.force_requested_by,
           attempts           = 0,
           last_error         = NULL,
           processing_started_at = NULL,
           updated_at         = NOW()
         RETURNING generation, (xmax = 0) AS inserted`,
        [
          customerId,
          parts.period,
          parts.bucketDate,
          tz,
          lang,
          modelName,
          model,
          auth.accountId,
        ],
      );
      const { generation } = upsertRes.rows[0];

      return Response.json(
        {
          accepted: true,
          state_pk: {
            customer_id: customerId,
            period: parts.period,
            bucket_date: parts.bucketDate,
            tz,
          },
          variant: { tz, lang, model_name: modelName, model },
          generation,
        },
        { status: 202 },
      );
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
