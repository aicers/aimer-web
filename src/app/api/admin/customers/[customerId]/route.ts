import type { NextRequest } from "next/server";
import { auditLog } from "@/lib/auth/audit-stub";
import { deleteCustomer } from "@/lib/auth/delete-customer";
import { HttpError } from "@/lib/auth/errors";
import { verifyCsrf, verifyOrigin, withAuth } from "@/lib/auth/guards";
import { getAuditPool, getAuthPool } from "@/lib/db/client";

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

    const customerId = req.nextUrl.pathname.split("/").pop();
    if (!customerId || !UUID_RE.test(customerId)) {
      return Response.json({ error: "Invalid customer ID" }, { status: 400 });
    }

    try {
      await deleteCustomer(getAuthPool(), getAuditPool(), customerId);
    } catch (err) {
      if (err instanceof HttpError) {
        return Response.json(
          { error: err.message },
          { status: err.statusCode },
        );
      }
      throw err;
    }

    await auditLog({
      actorId: auth.accountId,
      authContext: "admin",
      action: "customer.delete",
      targetType: "customer",
      targetId: customerId,
      ipAddress: auth.meta.ipAddress,
      sid: auth.sessionId,
    });

    return new Response(null, { status: 204 });
  },
  { ctx: "admin" },
);
