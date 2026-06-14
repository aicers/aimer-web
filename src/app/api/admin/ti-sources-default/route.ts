// Admin-set global default TI source selection (RFC 0003 F2, #598).
//
// `GET    /api/admin/ti-sources-default` — current global default (or null),
//         whether it is currently registry-active, the effective fallback,
//         the selectable catalog DTO, and the built-in all-enabled fallback.
// `PUT    /api/admin/ti-sources-default` — set the global default.
// `DELETE /api/admin/ti-sources-default` — clear it (revert to all-enabled).
//
// System Administrator only (`system-settings:read` / `:write`), the second
// tier of the three-tier resolution order — NOT the per-subject `ti-sources:*`
// grant. Mirrors the `analysis-default-model` admin route. The selection is
// validated against the live registry at save (empty → 422; unknown id → 422).

import type { NextRequest } from "next/server";
import {
  allEnabledSourceIds,
  clearGlobalTiSources,
  readGlobalTiSourcesView,
  setGlobalTiSources,
  toCatalogDto,
} from "@/lib/analysis/ti-sources";
import { assertAuthorized } from "@/lib/auth/authorization";
import { HttpError } from "@/lib/auth/errors";
import { verifyCsrf, verifyOrigin, withAuth } from "@/lib/auth/guards";
import { getAuthPool, withTransaction } from "@/lib/db/client";

function errorResponse(err: unknown): Response {
  if (err instanceof HttpError) {
    return Response.json({ error: err.message }, { status: err.statusCode });
  }
  throw err;
}

export const GET = withAuth(
  async (_req: NextRequest, auth) => {
    try {
      const view = await withTransaction(getAuthPool(), async (client) => {
        await assertAuthorized(
          client,
          "admin",
          auth.accountId,
          "system-settings:read",
        );
        return readGlobalTiSourcesView(client);
      });
      // Surface the stored value AND whether it is currently registry-active,
      // so the settings page mirrors resolver semantics rather than
      // advertising a stale stored value as the effective global default.
      return Response.json({
        global: view.stored,
        globalActive: view.active,
        effective: view.effective,
        source: view.source,
        allEnabled: allEnabledSourceIds(),
        catalog: toCatalogDto(view.effective),
      });
    } catch (err) {
      return errorResponse(err);
    }
  },
  { ctx: "admin" },
);

export const PUT = withAuth(
  async (req: NextRequest, auth) => {
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
      return Response.json({ error: "Invalid JSON" }, { status: 400 });
    }

    try {
      const { enabledSourceIds, changed } = await withTransaction(
        getAuthPool(),
        (client) =>
          setGlobalTiSources(client, auth.accountId, raw, {
            ipAddress: auth.meta.ipAddress,
            sid: auth.sessionId,
          }),
      );
      return Response.json({ global: enabledSourceIds, changed });
    } catch (err) {
      return errorResponse(err);
    }
  },
  { ctx: "admin" },
);

export const DELETE = withAuth(
  async (req: NextRequest, auth) => {
    const originErr = verifyOrigin(req);
    if (originErr) return originErr;
    const csrfErr = verifyCsrf(req, {
      ctx: "admin",
      sid: auth.sessionId,
      iat: auth.iat,
    });
    if (csrfErr) return csrfErr;

    try {
      const { cleared } = await withTransaction(getAuthPool(), (client) =>
        clearGlobalTiSources(client, auth.accountId, {
          ipAddress: auth.meta.ipAddress,
          sid: auth.sessionId,
        }),
      );
      return Response.json({ cleared });
    } catch (err) {
      return errorResponse(err);
    }
  },
  { ctx: "admin" },
);
