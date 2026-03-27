import type { NextRequest } from "next/server";
import { auditLog } from "@/lib/auth/audit-stub";
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

      await auditLog({
        actorId: auth.accountId,
        authContext: "admin",
        action: "session-policy.update",
        targetType: "system-settings",
        targetId: "session_policy",
        details: { policy },
        ipAddress: auth.meta.ipAddress,
        sid: auth.sessionId,
      });

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
