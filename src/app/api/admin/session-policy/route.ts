import type { NextRequest } from "next/server";
import { HttpError } from "@/lib/auth/errors";
import { verifyCsrf, verifyOrigin, withAuth } from "@/lib/auth/guards";
import {
  clearSessionPolicyCache,
  readSessionPolicy,
  updateSessionPolicy,
} from "@/lib/auth/session-policy";
import { getAuthPool, withTransaction } from "@/lib/db/client";

export const GET = withAuth(
  async (_req: NextRequest, auth) => {
    try {
      const policy = await withTransaction(getAuthPool(), (client) =>
        readSessionPolicy(client, auth.accountId),
      );

      return Response.json({ policy });
    } catch (err: unknown) {
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
      const policy = await withTransaction(getAuthPool(), (client) =>
        updateSessionPolicy(client, auth.accountId, raw),
      );

      clearSessionPolicyCache();

      auth.audit.targetId = "session_policy";
      auth.audit.details = { policy };

      return Response.json({ policy });
    } catch (err: unknown) {
      if (err instanceof HttpError) {
        return Response.json(
          { error: err.message },
          { status: err.statusCode },
        );
      }
      throw err;
    }
  },
  {
    ctx: "admin",
    audit: { action: "system.settings_updated", targetType: "system-settings" },
  },
);
