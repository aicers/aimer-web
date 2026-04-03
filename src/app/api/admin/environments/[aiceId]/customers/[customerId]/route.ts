import type { NextRequest } from "next/server";
import { assertAuthorized } from "@/lib/auth/authorization";
import { HttpError } from "@/lib/auth/errors";
import { verifyCsrf, verifyOrigin, withAuth } from "@/lib/auth/guards";
import { getAuthPool } from "@/lib/db/client";

function extractIds(req: NextRequest): {
  aiceId: string | null;
  customerId: string | null;
} {
  // /api/admin/environments/[aiceId]/customers/[customerId]
  const parts = req.nextUrl.pathname.split("/");
  const envIdx = parts.indexOf("environments");
  const custIdx = parts.indexOf("customers");
  return {
    aiceId: envIdx >= 0 ? parts[envIdx + 1] : null,
    customerId: custIdx >= 0 ? parts[custIdx + 1] : null,
  };
}

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

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

    const { aiceId, customerId } = extractIds(req);
    if (!aiceId || !customerId || !UUID_RE.test(customerId)) {
      return Response.json({ error: "Invalid parameters" }, { status: 400 });
    }

    const pool = getAuthPool();
    const authzClient = await pool.connect();
    try {
      await assertAuthorized(
        authzClient,
        "admin",
        auth.accountId,
        "aice-environments:write",
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

    const result = await pool.query(
      `DELETE FROM aice_environment_customers
       WHERE aice_id = $1 AND customer_id = $2
       RETURNING aice_id`,
      [aiceId, customerId],
    );

    if (result.rows.length === 0) {
      return Response.json({ error: "Mapping not found" }, { status: 404 });
    }

    auth.audit.targetId = aiceId;
    auth.audit.details = { aiceId, customerId };

    return new Response(null, { status: 204 });
  },
  {
    ctx: "admin",
    audit: {
      action: "environment.customer_unlinked",
      targetType: "environment",
    },
  },
);
