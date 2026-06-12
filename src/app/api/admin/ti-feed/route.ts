import {
  getSelfFetchSourceStatuses,
  selfFetchModeActive,
  tiFeedAdminSurfaceActive,
} from "@/lib/analysis/enrichment/feed-fetch";
import { getFeedSourceStatuses } from "@/lib/analysis/enrichment/feed-upload";
import { assertAuthorized } from "@/lib/auth/authorization";
import { HttpError } from "@/lib/auth/errors";
import { withAuth } from "@/lib/auth/guards";
import { getAuthPool, getFeedPool } from "@/lib/db/client";

// ---------------------------------------------------------------------------
// GET /api/admin/ti-feed — per-source Tier-1 feed status (SHARED surface)
// ---------------------------------------------------------------------------
//
// Shared by the `manual-upload` and `self-fetch` supply modes (#566 / #568):
// both have an operator-facing Threat Feeds page. This status GET — like the
// page and the nav entry — is active in EITHER mode and 404s otherwise, so
// the nav probe surfaces the page in both. The mode-specific mutating routes
// (`/upload` vs `/fetch` + `/auth-key`) gate on their own mode.
//
// The response carries `mode` so the UI renders the right controls, and the
// per-source status shape differs by mode: manual-upload reports snapshot
// row counts + freshness; self-fetch reports fetch URL / last-fetch state /
// Auth-Key set-ness (freshness from `feed_fetch_state`, not row count).
//
// Auth: session-gated via `withAuth({ ctx: "admin" })` and authorized with the
// read permission `ti-feed:read`. `verifyOrigin`/`verifyCsrf` are intentionally
// NOT applied to this safe, read-only GET (a forged cross-site GET cannot read
// the response under the same-origin policy). The mutating routes run the full
// origin + CSRF + `ti-feed:write` gate.

export const GET = withAuth(
  async (_req, auth) => {
    if (!tiFeedAdminSurfaceActive()) {
      return Response.json({ error: "Not found" }, { status: 404 });
    }

    const authPool = getAuthPool();
    const client = await authPool.connect();
    try {
      await assertAuthorized(client, "admin", auth.accountId, "ti-feed:read");
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

    const feedPool = getFeedPool();
    const now = new Date();
    if (selfFetchModeActive()) {
      const sources = await getSelfFetchSourceStatuses(feedPool, now);
      return Response.json({ mode: "self-fetch", sources });
    }
    const sources = await getFeedSourceStatuses(feedPool, now);
    return Response.json({ mode: "manual-upload", sources });
  },
  { ctx: "admin" },
);
