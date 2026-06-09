// RFC 0002 Phase 1 (#296) — story regenerate endpoint.
//
// `POST /api/subjects/{subject_id}/analysis/story/{story_id}/regenerate`
//
// Optional `?lang=…&model_name=…&model=…`. Rejects `tz` with `400
// invalid_param` (story analysis is timezone-independent).
//
// Source-availability precheck (before any job-row write):
//   - State row does not exist → `404 story_not_found`.
//   - State row is `archived`, or no `story_version` survives in
//     customer DB → `409 source_unavailable`.
//
// Two branches per RFC §"Force regenerate":
//   - Existing row for `(lang, model_name, model)` → UPDATE generation+1,
//     status='queued', attempts=0, last_error=NULL, dry_run=FALSE, force
//     timestamps refreshed. UNCONDITIONAL on prior status — including
//     `processing`. The in-flight worker is defensive via captured
//     generation.
//   - No row → INSERT generation=1, status='queued', force timestamps
//     set, dry_run=FALSE.
//
// Returns 202 with `{state_pk: {customer_id, story_id}, variant: {lang,
// model_name, model}, generation}`.

import type { NextRequest } from "next/server";
import { resolveDefaultModel } from "@/lib/analysis/default-model";
import { authorize } from "@/lib/auth/authorization";
import { HttpError } from "@/lib/auth/errors";
import { verifyCsrf, verifyOrigin, withAuth } from "@/lib/auth/guards";
import { getAuthPool } from "@/lib/db/client";
import { getCustomerRuntimePool } from "@/lib/db/customer-runtime-pool";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const DEFAULT_LANG = process.env.ANALYSIS_DEFAULT_LANG ?? "ENGLISH";

// Aimer's `Language` GraphQL enum is closed; sending anything else
// would persist a bad job row that fails at the LLM call far from the
// caller. The worker casts the column value back to this enum at
// dispatch time, so the API boundary is the right place to enforce it.
const ALLOWED_LANGS = new Set(["KOREAN", "ENGLISH"]);

function extractCustomerId(req: NextRequest): string | null {
  const segments = req.nextUrl.pathname.split("/");
  let idx = segments.indexOf("subjects");
  if (idx === -1) idx = segments.indexOf("customers");
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

    const subjectId = extractCustomerId(req);
    if (!subjectId) {
      return Response.json(errorBody("invalid_customer_id"), { status: 400 });
    }
    const storyId = extractStoryId(req);
    if (!storyId) {
      return Response.json(errorBody("invalid_story_id"), { status: 400 });
    }

    if (req.nextUrl.searchParams.has("tz")) {
      return Response.json(
        errorBody("invalid_param", "tz is not supported on story regenerate"),
        { status: 400 },
      );
    }

    const lang = req.nextUrl.searchParams.get("lang") ?? DEFAULT_LANG;
    if (!ALLOWED_LANGS.has(lang)) {
      return Response.json(
        errorBody("invalid_param", "lang must be one of KOREAN, ENGLISH"),
        { status: 400 },
      );
    }
    // Default model is per-customer (#473): when the caller omits the
    // model axis, resolve the customer's effective default (override →
    // global → env) rather than reading env directly. Resolved below on
    // the same auth client. An explicitly supplied param still wins.
    const modelNameParam = req.nextUrl.searchParams.get("model_name");
    const modelParam = req.nextUrl.searchParams.get("model");

    const pool = getAuthPool();
    const client = await pool.connect();
    try {
      const def = await resolveDefaultModel(subjectId, client);
      const modelName = modelNameParam ?? def.modelName;
      const model = modelParam ?? def.model;
      // Use `authorize()` directly (not `assertAuthorized`) because
      // bridge-write rejections need to surface as
      // `{error: "bridge_write_blocked"}` per the RFC 0002 / #296
      // contract. `assertAuthorized` collapses every denial into the
      // same `HttpError("Forbidden", 403)`, which would lose the
      // reason and force the route to return a generic `Forbidden`
      // body.
      const authResult = await authorize(
        client,
        "general",
        auth.accountId,
        "analyses:configure",
        {
          customerId: subjectId,
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
        // Bridge-write / bridge-not-allowed leak only session-type, not
        // story existence — keep their 403 contract intact (#296).
        if (authResult.reason) {
          return Response.json(errorBody(authResult.reason), { status: 403 });
        }
        // Non-member: `permissions` is undefined because
        // `authorizeGeneral` returns early before the permission set
        // is built. Surface as 404 to hide story existence (uniform
        // with the page route — see RFC 0002 amendment / #333).
        if (authResult.permissions === undefined) {
          return Response.json(errorBody("story_not_found"), { status: 404 });
        }
        // Member without the required permission — precise 403.
        return Response.json(errorBody("Forbidden"), { status: 403 });
      }

      // Source-availability precheck. The state row is the source-of-
      // truth handle into the analysis pipeline; force-regenerate
      // cannot resurrect an archived narrative or one without a
      // surviving story_version.
      const stateRow = await client.query<{ status: string }>(
        `SELECT status FROM story_analysis_state
          WHERE customer_id = $1 AND story_id = $2::bigint`,
        [subjectId, storyId],
      );
      if (stateRow.rows.length === 0) {
        return Response.json(errorBody("story_not_found"), { status: 404 });
      }
      if (stateRow.rows[0].status === "archived") {
        return Response.json(errorBody("source_unavailable"), { status: 409 });
      }

      // Confirm at least one `story_version` survives in the customer
      // DB. The state row can outlive every version when an archive
      // races with the regenerate request.
      const customerPool = getCustomerRuntimePool(subjectId);
      const versionRows = await customerPool.query<{ story_version: string }>(
        `SELECT story_version FROM story
          WHERE story_id = $1::bigint
          LIMIT 1`,
        [storyId],
      );
      if (versionRows.rows.length === 0) {
        return Response.json(errorBody("source_unavailable"), { status: 409 });
      }

      // UPSERT the job row. The UPDATE branch's WHERE clause is the PK,
      // so a missing variant row triggers the INSERT branch.
      const upsertRes = await client.query<{
        generation: number;
        inserted: boolean;
      }>(
        `INSERT INTO story_analysis_job
           (customer_id, story_id, lang, model_name, model,
            status, generation, dry_run,
            force_requested_at, force_requested_by,
            attempts, last_error)
         VALUES ($1, $2::bigint, $3, $4, $5,
                 'queued', 1, FALSE,
                 NOW(), $6::uuid,
                 0, NULL)
         ON CONFLICT (customer_id, story_id, lang, model_name, model)
         DO UPDATE SET
           generation         = story_analysis_job.generation + 1,
           status             = 'queued',
           dry_run            = FALSE,
           force_requested_at = NOW(),
           force_requested_by = EXCLUDED.force_requested_by,
           attempts           = 0,
           last_error         = NULL,
           processing_started_at = NULL,
           updated_at         = NOW()
         RETURNING generation, (xmax = 0) AS inserted`,
        [subjectId, storyId, lang, modelName, model, auth.accountId],
      );
      const { generation } = upsertRes.rows[0];

      return Response.json(
        {
          accepted: true,
          state_pk: { customer_id: subjectId, story_id: storyId },
          variant: { lang, model_name: modelName, model },
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
