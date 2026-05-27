// RFC 0002 Phase 0 (#294) — periodic report regenerate API stub.
//
// `POST /api/customers/{customer_id}/analysis/report/{period}/{bucket_date}/regenerate`
//
// Accepts optional `?tz=…&lang=…&model_name=…&model=…` per RFC 0002
// §"Force regenerate". Phase 0 DB side effects: none (see the story
// regenerate stub header for rationale).
//
// Permission gate: `reports:create` (Analyst role only, existing
// seed). Unauthenticated → 401, non-member or missing perm → 403.
//
// Bridge-session policy: force-regenerate is a write action (Phase 2
// will enqueue a real job row; the stub locks the auth contract for
// that). Bridge sessions are AICE-side ingest/process flows, not
// analyst UI actions, so this endpoint is blocked in bridge sessions
// via `operationKind: "write"`. The bridge scope is still passed so a
// bridge session whose customer_id matches the path can be rejected
// uniformly with the cross-customer case (`bridge_write_blocked` →
// 403) and so future relaxations stay scoped.

import type { NextRequest } from "next/server";
import { assertAuthorized } from "@/lib/auth/authorization";
import { HttpError } from "@/lib/auth/errors";
import { verifyCsrf, verifyOrigin, withAuth } from "@/lib/auth/guards";
import { getAuthPool } from "@/lib/db/client";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PERIODS = new Set(["LIVE", "DAILY", "WEEKLY", "MONTHLY"]);
const BUCKET_DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
// Synthetic bucket date for LIVE rows (issue #294 decision 4). Kept in
// sync with `LIVE_BUCKET_DATE` in `src/lib/analysis/state.ts` and
// migration 0029. Duplicated here instead of imported so this route
// stays free of the server-only graph that `state.ts` pulls in (the
// unit-test mocks the auth/db modules but not the analysis-state
// module).
const LIVE_BUCKET_DATE = "1970-01-01";

// Validates an ISO calendar date `YYYY-MM-DD`. Rejects shape mismatches
// AND impossible calendar dates (`2026-99-99`, `2026-02-31`, ...). The
// regex alone would let nonsense values pass to authorization and 202,
// pinning a surprising contract before Phase 1 casts this path segment
// to a real SQL `date` — see #294 round-24 review item 2.
function isValidBucketDate(value: string): boolean {
  const m = BUCKET_DATE_RE.exec(value);
  if (!m) return false;
  const year = Number(m[1]);
  const month = Number(m[2]);
  const day = Number(m[3]);
  if (month < 1 || month > 12 || day < 1 || day > 31) return false;
  const d = new Date(Date.UTC(year, month - 1, day));
  return (
    d.getUTCFullYear() === year &&
    d.getUTCMonth() === month - 1 &&
    d.getUTCDate() === day
  );
}

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
  // LIVE rows are pinned to the synthetic bucket date `1970-01-01` (issue
  // #294 decision 4; see `LIVE_BUCKET_DATE` and migration 0029). Anything
  // else for LIVE is a variant key the worker/reconcile will never
  // produce — reject before authorization so Phase 1 doesn't inherit a
  // surprising contract (round-25 review item 1).
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

    const pool = getAuthPool();
    const client = await pool.connect();
    try {
      await assertAuthorized(
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

    const url = req.nextUrl;
    return Response.json(
      {
        accepted: true,
        customer_id: customerId,
        period: parts.period,
        bucket_date: parts.bucketDate,
        variant: {
          tz: url.searchParams.get("tz"),
          lang: url.searchParams.get("lang"),
          model_name: url.searchParams.get("model_name"),
          model: url.searchParams.get("model"),
        },
      },
      { status: 202 },
    );
  },
  { ctx: "general" },
);
