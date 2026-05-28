// RFC 0002 Phase 1 (#296) — story analysis summary endpoint.
//
// `GET /api/customers/{customer_id}/analysis/story/{story_id}/summary`
//
// Returns the latest non-superseded `story_analysis_result` row for
// the customer's default `(lang, model_name, model)` variant, or
// `{exists: false}` when no result exists yet (state row pending, job
// queued, or LLM not yet called).
//
// `score_kind`: `"leaf"` for story analysis (single LLM call). The
// `"aggregate"` value is reserved for periodic-report summaries.
//
// Permission gate: `analyses:read` (analyst-readable). Bridge sessions
// are allowed for reads; mirrors the report-summary contract.

import type { NextRequest } from "next/server";
import { assertAuthorized } from "@/lib/auth/authorization";
import { HttpError } from "@/lib/auth/errors";
import { withAuth } from "@/lib/auth/guards";
import { getAuthPool } from "@/lib/db/client";
import { getCustomerRuntimePool } from "@/lib/db/customer-runtime-pool";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

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

function extractStoryId(req: NextRequest): string | null {
  const segments = req.nextUrl.pathname.split("/");
  const idx = segments.indexOf("story");
  if (idx === -1 || idx + 1 >= segments.length) return null;
  const id = segments[idx + 1];
  return /^-?\d+$/.test(id) ? id : null;
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
    const storyId = extractStoryId(req);
    if (!storyId) {
      return Response.json(errorBody("invalid_story_id"), { status: 400 });
    }

    const pool = getAuthPool();
    const client = await pool.connect();
    try {
      await assertAuthorized(
        client,
        "general",
        auth.accountId,
        "analyses:read",
        {
          customerId,
          operationKind: "read",
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

    // Read the latest non-superseded result for the default variant.
    const customerPool = getCustomerRuntimePool(customerId);
    const rows = await customerPool.query<{
      priority_tier: string;
      severity_score: number;
      likelihood_score: number;
    }>(
      `SELECT priority_tier, severity_score, likelihood_score
         FROM story_analysis_result
        WHERE customer_id = $1
          AND story_id = $2::bigint
          AND lang = $3 AND model_name = $4 AND model = $5
          AND superseded_at IS NULL
        ORDER BY generation DESC
        LIMIT 1`,
      [customerId, storyId, DEFAULT_LANG, DEFAULT_MODEL_NAME, DEFAULT_MODEL],
    );
    if (rows.rows.length === 0) {
      return Response.json({ exists: false });
    }
    const row = rows.rows[0];
    return Response.json({
      exists: true,
      priority_tier: row.priority_tier,
      severity_score: row.severity_score,
      likelihood_score: row.likelihood_score,
      score_kind: "leaf",
      link: `/customers/${customerId}/analysis/story/${storyId}`,
    });
  },
  { ctx: "general" },
);
