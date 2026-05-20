import type { NextRequest } from "next/server";
import { assertAuthorized } from "@/lib/auth/authorization";
import { HttpError } from "@/lib/auth/errors";
import { verifyCsrf, verifyOrigin, withAuth } from "@/lib/auth/guards";
import { getAuthPool } from "@/lib/db/client";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function extractIds(
  req: NextRequest,
): { customerId: string; rangeId: string } | null {
  // Path: `/api/admin/customers/<customerId>/redaction-ranges/<rangeId>`.
  const segments = req.nextUrl.pathname.split("/");
  const rangeId = segments[segments.length - 1];
  const customerId = segments[segments.length - 3];
  if (!UUID_RE.test(customerId) || !UUID_RE.test(rangeId)) return null;
  return { customerId, rangeId };
}

export const DELETE = withAuth(
  async (req: NextRequest, auth) => {
    const originErr = verifyOrigin(req);
    if (originErr) return originErr;

    const csrfErr = verifyCsrf(req, {
      ctx: "general",
      sid: auth.sessionId,
      iat: auth.iat,
    });
    if (csrfErr) return csrfErr;

    const ids = extractIds(req);
    if (!ids) {
      return Response.json({ error: "Invalid ID" }, { status: 400 });
    }
    const { customerId, rangeId } = ids;

    const pool = getAuthPool();
    const client = await pool.connect();
    try {
      await assertAuthorized(
        client,
        "general",
        auth.accountId,
        "customer-redaction-ranges:write",
        { customerId, operationKind: "write" },
      );
      const { rows } = await client.query<{ cidr: string }>(
        `DELETE FROM customer_redaction_ranges
         WHERE id = $1 AND customer_id = $2
         RETURNING cidr::text AS cidr`,
        [rangeId, customerId],
      );
      if (rows.length === 0) {
        return Response.json({ error: "Range not found" }, { status: 404 });
      }

      auth.audit.targetId = rangeId;
      auth.audit.customerId = customerId;
      auth.audit.details = {
        customerId,
        cidr: rows[0].cidr,
        rangeId,
      };

      return new Response(null, { status: 204 });
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
  },
  {
    ctx: "general",
    audit: {
      action: "customer_redaction_ranges.deleted",
      targetType: "customer_redaction_range",
    },
  },
);
