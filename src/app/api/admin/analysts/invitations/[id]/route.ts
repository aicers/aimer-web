import type { NextRequest } from "next/server";
import { revokeAnalystInvitation } from "@/lib/auth/analyst-invitations";
import { assertAuthorized } from "@/lib/auth/authorization";
import { HttpError } from "@/lib/auth/errors";
import { verifyCsrf, verifyOrigin, withAuth } from "@/lib/auth/guards";
import { getAuthPool, withTransaction } from "@/lib/db/client";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// ---------------------------------------------------------------------------
// DELETE /api/admin/analysts/invitations/[id] — revoke
// ---------------------------------------------------------------------------

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

    const pool = getAuthPool();
    const authzClient = await pool.connect();
    try {
      await assertAuthorized(
        authzClient,
        "admin",
        auth.accountId,
        "analysts:write",
      );
    } catch (err) {
      if (err instanceof HttpError) {
        return Response.json(
          { error: err.message },
          { status: err.statusCode },
        );
      }
      throw err;
    } finally {
      authzClient.release();
    }

    const id = req.nextUrl.pathname.split("/").pop();
    if (!id || !UUID_RE.test(id)) {
      return Response.json({ error: "not_found" }, { status: 404 });
    }

    try {
      const result = await withTransaction(pool, (client) =>
        revokeAnalystInvitation(client, id),
      );
      auth.audit.targetId = id;
      return Response.json(result, { status: 200 });
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
  {
    ctx: "admin",
    audit: { action: "invitation.revoked", targetType: "analyst_invitation" },
  },
);
