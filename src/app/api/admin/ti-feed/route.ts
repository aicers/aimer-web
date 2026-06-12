import { getTier1FeedSource } from "@/lib/analysis/enrichment/feed-catalog";
import {
  getSelfFetchSourceStatuses,
  selfFetchModeActive,
  tiFeedAdminSurfaceActive,
} from "@/lib/analysis/enrichment/feed-fetch";
import {
  effectiveCadenceMs,
  readSelfFetchSchedule,
} from "@/lib/analysis/enrichment/feed-schedule";
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
      // Surface the schedule and, per source, the next time the scheduler
      // would fetch it at the effective cadence (`max(intervalMs, floor)`).
      // The source of truth for last-fetch / next-due is per-source
      // `feed_fetch_state` (#570 §4), NOT a new column or the in-memory
      // worker state.
      const [statuses, schedule] = await Promise.all([
        getSelfFetchSourceStatuses(feedPool, now),
        readSelfFetchSchedule(authPool),
      ]);
      const sources = statuses.map((status) => {
        const fetchConfig = getTier1FeedSource(status.sourcePolicyId)?.fetch;
        if (!fetchConfig) {
          return {
            ...status,
            effectiveCadenceMs: null,
            nextFetchDueAt: null,
            dueNow: false,
          };
        }
        const cadence = effectiveCadenceMs(
          schedule.intervalMs,
          fetchConfig.cadenceFloorMs,
        );
        // Next-due mirrors the worker's `nextFetchAllowedAt(state, cadence)`.
        // A never-fetched source has no concrete next-due timestamp, but the
        // worker treats it as due on the next tick. Surface that explicitly as
        // `dueNow` instead of a bare `null` — otherwise the UI would render it
        // as "—", indistinguishable from a non-fetchable (merged) source.
        const nextFetchDueAt = status.lastFetchedAt
          ? new Date(
              new Date(status.lastFetchedAt).getTime() + cadence,
            ).toISOString()
          : null;
        const dueNow = status.lastFetchedAt === null;
        return {
          ...status,
          effectiveCadenceMs: cadence,
          nextFetchDueAt,
          dueNow,
        };
      });
      return Response.json({ mode: "self-fetch", sources, schedule });
    }
    const sources = await getFeedSourceStatuses(feedPool, now);
    return Response.json({ mode: "manual-upload", sources });
  },
  { ctx: "admin" },
);
