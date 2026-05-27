// RFC 0002 Phase 0 (#294) — story regenerate API stub.
//
// `POST /api/customers/{customer_id}/analysis/story/{story_id}/regenerate`
//
// Accepts optional `?lang=…&model_name=…&model=…`. Rejects `tz` with
// `400 invalid_param` — story analysis is timezone-independent
// (RFC 0002 §"Customer-level timezone"; issue #294 scope).
//
// **Phase 0 DB side effects: none.** The stub validates auth +
// customer membership + permission + tz-rejection and returns 202
// with a placeholder body. Real force-regenerate semantics
// (`force_requested_at`/`force_requested_by`, `generation++`,
// first-time variant insert) are Phase 1 (#296) concerns — there is
// no existing job to bump in Phase 0, so a stub insert would not
// exercise the real path and would add cleanup load to PR-6's
// dry-run purge.
//
// Permission gate: `analyses:configure` (Analyst role only, existing
// seed). Unauthenticated → 401, non-member or missing perm → 403.

import type { NextRequest } from "next/server";
import { assertAuthorized } from "@/lib/auth/authorization";
import { HttpError } from "@/lib/auth/errors";
import { verifyCsrf, verifyOrigin, withAuth } from "@/lib/auth/guards";
import { getAuthPool } from "@/lib/db/client";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function extractCustomerId(req: NextRequest): string | null {
  // Pathname: /api/customers/{customerId}/analysis/story/{storyId}/regenerate
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
    const storyId = extractStoryId(req);
    if (!storyId) {
      return Response.json(errorBody("invalid_story_id"), { status: 400 });
    }

    // Story analysis output is timezone-independent (RFC 0002). Reject
    // tz here so a client that mistakenly sends it does not silently
    // succeed and start expecting tz to be honored in Phase 1.
    if (req.nextUrl.searchParams.has("tz")) {
      return Response.json(
        errorBody("invalid_param", "tz is not supported on story regenerate"),
        { status: 400 },
      );
    }

    const pool = getAuthPool();
    const client = await pool.connect();
    try {
      await assertAuthorized(
        client,
        "general",
        auth.accountId,
        "analyses:configure",
        { customerId },
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

    // Placeholder body — the public shape (URL + status codes + error
    // codes) is what Phase 0 locks in. The {variant, generation} fields
    // become real in Phase 1.
    const url = req.nextUrl;
    return Response.json(
      {
        accepted: true,
        story_id: storyId,
        customer_id: customerId,
        variant: {
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
