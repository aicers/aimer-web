import type { NextRequest } from "next/server";
import { selfFetchModeActive } from "@/lib/analysis/enrichment/feed-fetch";
import { setSelfFetchSchedule } from "@/lib/analysis/enrichment/feed-schedule";
import { HttpError } from "@/lib/auth/errors";
import { verifyCsrf, verifyOrigin, withAuth } from "@/lib/auth/guards";
import { getAuthPool, withTransaction } from "@/lib/db/client";

// ---------------------------------------------------------------------------
// PUT /api/admin/ti-feed/schedule — set the self-fetch schedule (self-fetch)
// ---------------------------------------------------------------------------
//
// Sets `{ enabled, intervalMs? }` (the background scheduler gate; default off).
// Active only in `self-fetch` mode (404 otherwise). admin-gated: origin + CSRF
// + `ti-feed:write`. The write is audited (`setSelfFetchSchedule`). The current
// schedule is also exposed on the status `GET /api/admin/ti-feed`.

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

    let raw: unknown;
    try {
      raw = await req.json();
    } catch {
      return Response.json({ error: "Invalid JSON body" }, { status: 400 });
    }

    try {
      const schedule = await withTransaction(getAuthPool(), (client) =>
        setSelfFetchSchedule(client, auth.accountId, raw, {
          ipAddress: auth.meta.ipAddress,
          sid: auth.sessionId,
        }),
      );
      return Response.json({ schedule });
    } catch (err) {
      if (err instanceof HttpError) {
        return Response.json(
          { error: err.message },
          { status: err.statusCode },
        );
      }
      throw err;
    }
  },
  { ctx: "admin" },
);
