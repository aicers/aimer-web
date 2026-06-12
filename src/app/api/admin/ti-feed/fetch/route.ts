import type { NextRequest } from "next/server";
import {
  SelfFetchFeedSource,
  type SelfFetchOutcome,
  selfFetchModeActive,
} from "@/lib/analysis/enrichment/feed-fetch";
import { assertAuthorized } from "@/lib/auth/authorization";
import { HttpError } from "@/lib/auth/errors";
import { verifyCsrf, verifyOrigin, withAuth } from "@/lib/auth/guards";
import { getAuthPool, getFeedPool } from "@/lib/db/client";

// ---------------------------------------------------------------------------
// POST /api/admin/ti-feed/fetch — operator "Fetch Now" (self-fetch mode)
// ---------------------------------------------------------------------------
//
// Synchronously fetches + imports one source (`{ sourcePolicyId }`) or every
// fetchable source (no body / `{}`), respecting single-flight (per-source
// advisory lock) and the hard cadence floor. Active only in `self-fetch`
// mode (404 otherwise). admin-gated: origin + CSRF + `ti-feed:write`.

/**
 * Collapse the engine's richer internal outcome to the API's status set.
 * `locked` (another fetch already in flight) surfaces as a benign error.
 */
function toApiResult(outcome: SelfFetchOutcome): {
  status: "imported" | "not-modified" | "too-soon" | "error";
  rowCount?: number;
  nextAllowedAt?: string;
  error?: string;
} {
  switch (outcome.status) {
    case "imported":
      return { status: "imported", rowCount: outcome.rowCount };
    case "not-modified":
      return { status: "not-modified" };
    case "too-soon":
      return { status: "too-soon", nextAllowedAt: outcome.nextAllowedAt };
    case "locked":
      return {
        status: "error",
        error: "A fetch for this source is already in progress",
      };
    default:
      return { status: "error", error: outcome.error };
  }
}

export const POST = withAuth(
  async (req: NextRequest, auth) => {
    if (!selfFetchModeActive()) {
      return Response.json({ error: "Not found" }, { status: 404 });
    }

    const originErr = verifyOrigin(req);
    if (originErr) return originErr;

    const csrfErr = verifyCsrf(req, {
      ctx: "admin",
      sid: auth.sessionId,
      iat: auth.iat,
    });
    if (csrfErr) return csrfErr;

    const authPool = getAuthPool();
    const client = await authPool.connect();
    try {
      await assertAuthorized(client, "admin", auth.accountId, "ti-feed:write");
    } catch (err) {
      if (err instanceof HttpError) {
        return Response.json(
          { error: err.message },
          { status: err.statusCode },
        );
      }
      throw err;
    } finally {
      client.release();
    }

    let body: { sourcePolicyId?: unknown } = {};
    try {
      const text = await req.text();
      if (text.length > 0) body = JSON.parse(text);
    } catch {
      return Response.json({ error: "Invalid JSON body" }, { status: 400 });
    }

    const source = new SelfFetchFeedSource({ feedPool: getFeedPool() });

    // Single source.
    if (body.sourcePolicyId !== undefined) {
      if (typeof body.sourcePolicyId !== "string") {
        return Response.json(
          { error: "sourcePolicyId must be a string" },
          { status: 400 },
        );
      }
      const outcome = await source.fetchAndImport(body.sourcePolicyId);
      return Response.json(toApiResult(outcome));
    }

    // All fetchable sources.
    const all = await source.fetchAndImportAll();
    return Response.json({
      results: all.map((r) => ({
        sourcePolicyId: r.sourcePolicyId,
        ...toApiResult(r.outcome),
      })),
    });
  },
  { ctx: "admin" },
);
