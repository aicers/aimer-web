import {
  getFeedSourceStatuses,
  manualUploadModeActive,
} from "@/lib/analysis/enrichment/feed-upload";
import { assertAuthorized } from "@/lib/auth/authorization";
import { HttpError } from "@/lib/auth/errors";
import { withAuth } from "@/lib/auth/guards";
import { getAuthPool, getFeedPool } from "@/lib/db/client";

// ---------------------------------------------------------------------------
// GET /api/admin/ti-feed — per-source Tier-1 feed status (manual-upload mode)
// ---------------------------------------------------------------------------

export const GET = withAuth(
  async (_req, auth) => {
    // The manual-upload surface is inactive outside `TI_FEED_MODE=manual-upload`
    // so operator snapshots can't be silently clobbered by another mode.
    if (!manualUploadModeActive()) {
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

    const sources = await getFeedSourceStatuses(getFeedPool(), new Date());
    return Response.json({ sources });
  },
  { ctx: "admin" },
);
