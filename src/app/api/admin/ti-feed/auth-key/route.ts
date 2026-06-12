import type { NextRequest } from "next/server";
import {
  selfFetchModeActive,
  setFeedSourceSecret,
} from "@/lib/analysis/enrichment/feed-fetch";
import { assertAuthorized } from "@/lib/auth/authorization";
import { HttpError } from "@/lib/auth/errors";
import { verifyCsrf, verifyOrigin, withAuth } from "@/lib/auth/guards";
import { getAuthPool, getFeedPool } from "@/lib/db/client";

// ---------------------------------------------------------------------------
// PUT /api/admin/ti-feed/auth-key — set the URLhaus Auth-Key (self-fetch mode)
// ---------------------------------------------------------------------------
//
// Operator submits the URLhaus Auth-Key; it is Transit-envelope encrypted and
// stored in `feed_source_secret`. WRITE-ONLY — the key is never returned (the
// status GET only reports set/unset). Active only in `self-fetch` mode (404
// otherwise). admin-gated: origin + CSRF + `ti-feed:write`.

/** Allowed secret key names (the catalog's only Auth-Key today is URLhaus). */
const ALLOWED_KEY_NAMES = new Set(["urlhaus"]);

/** Defensive upper bound — abuse.ch Auth-Keys are short hex/base tokens. */
const MAX_AUTH_KEY_LENGTH = 1024;

export const PUT = withAuth(
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

    let body: { keyName?: unknown; authKey?: unknown };
    try {
      body = await req.json();
    } catch {
      return Response.json({ error: "Invalid JSON body" }, { status: 400 });
    }

    const keyName =
      typeof body.keyName === "string" && body.keyName.length > 0
        ? body.keyName
        : "urlhaus";
    if (!ALLOWED_KEY_NAMES.has(keyName)) {
      return Response.json({ error: "Unknown key name" }, { status: 400 });
    }
    if (typeof body.authKey !== "string" || body.authKey.length === 0) {
      return Response.json({ error: "authKey is required" }, { status: 400 });
    }
    if (body.authKey.length > MAX_AUTH_KEY_LENGTH) {
      return Response.json({ error: "authKey is too long" }, { status: 400 });
    }

    await setFeedSourceSecret(getFeedPool(), keyName, body.authKey);
    return Response.json({ ok: true });
  },
  { ctx: "admin" },
);
