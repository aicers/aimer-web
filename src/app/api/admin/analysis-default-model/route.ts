// Admin-set global default analysis model (#473).
//
// `GET    /api/admin/analysis-default-model` — current global default (or
//         null), the catalog allow-list, and the env fallback pair.
// `PUT    /api/admin/analysis-default-model` — set the global default.
// `DELETE /api/admin/analysis-default-model` — clear it (revert to env).
//
// System Administrator only (`system-settings:read` / `:write`), the
// second tier of the three-tier resolution order. Mirrors the
// session-policy admin route. The catalog membership of the submitted
// pair is enforced at save (422 `model_not_in_catalog`).

import type { NextRequest } from "next/server";
import {
  clearGlobalDefaultModel,
  getEnvDefaultModel,
  readGlobalDefaultModelView,
  setGlobalDefaultModel,
} from "@/lib/analysis/default-model";
import { getModelCatalog } from "@/lib/analysis/model-catalog";
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
        return readGlobalDefaultModelView(client);
      });
      // Surface the stored value AND whether it is actually live, so the
      // settings page mirrors resolver semantics rather than advertising a
      // stale out-of-catalog value as the effective global default (#473
      // review round 2).
      return Response.json({
        global: view.stored,
        globalActive: view.active,
        effective: view.effective,
        source: view.source,
        envDefault: getEnvDefaultModel(),
        catalog: getModelCatalog(),
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
      const global = await withTransaction(getAuthPool(), (client) =>
        setGlobalDefaultModel(client, auth.accountId, raw, {
          ipAddress: auth.meta.ipAddress,
          sid: auth.sessionId,
        }),
      );
      return Response.json({ global });
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
        clearGlobalDefaultModel(client, auth.accountId, {
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
