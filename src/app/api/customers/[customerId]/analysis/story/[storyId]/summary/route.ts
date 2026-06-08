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
//
// Non-member denials surface as `404 story_not_found` (existence-hiding
// uniform with the page route — see RFC 0002 amendment, issue #333).
// Bridge-not-allowed surfaces with its named reason at 403; a member
// without the required permission gets a generic 403 Forbidden.

import type { NextRequest } from "next/server";
import { resolveDefaultModel } from "@/lib/analysis/default-model";
import { type AuthorizeResult, authorize } from "@/lib/auth/authorization";
import { withAuth } from "@/lib/auth/guards";
import { getAuthPool } from "@/lib/db/client";
import { getCustomerRuntimePool } from "@/lib/db/customer-runtime-pool";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const DEFAULT_LANG = process.env.ANALYSIS_DEFAULT_LANG ?? "ENGLISH";

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
    let authResult: AuthorizeResult;
    try {
      authResult = await authorize(
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
    } finally {
      client.release();
    }
    if (!authResult.authorized) {
      // Bridge-not-allowed leaks only session-type, not story
      // existence — keep its 403 contract intact.
      if (authResult.reason === "bridge_not_allowed") {
        return Response.json(errorBody(authResult.reason), { status: 403 });
      }
      // Non-member: `permissions` is undefined because
      // `authorizeGeneral` returns early before the permission set is
      // built. Surface as 404 to hide story existence (uniform with
      // the page route).
      if (authResult.permissions === undefined) {
        return Response.json(errorBody("story_not_found"), { status: 404 });
      }
      // Member without the required permission — precise 403.
      return Response.json(errorBody("Forbidden"), { status: 403 });
    }

    // Read the latest non-superseded result for the default variant. The
    // default MODEL is per-customer (#473): resolve it (override → global →
    // env) rather than reading env directly. `lang` stays the env default.
    const def = await resolveDefaultModel(customerId);
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
      [customerId, storyId, DEFAULT_LANG, def.modelName, def.model],
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
