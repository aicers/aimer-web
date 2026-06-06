import type { NextRequest } from "next/server";
import { auditLog } from "@/lib/audit";
import { assertAuthorized } from "@/lib/auth/authorization";
import { HttpError } from "@/lib/auth/errors";
import { verifyCsrf, verifyOrigin, withAuth } from "@/lib/auth/guards";
import { getAuthPool } from "@/lib/db/client";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// /api/admin/analysts/[accountId]/assignments/[customerId]
function extractIds(req: NextRequest): {
  accountId: string | null;
  customerId: string | null;
} {
  const parts = req.nextUrl.pathname.split("/");
  const analystIdx = parts.indexOf("analysts");
  const assignmentsIdx = parts.indexOf("assignments");
  return {
    accountId: analystIdx >= 0 ? (parts[analystIdx + 1] ?? null) : null,
    customerId:
      assignmentsIdx >= 0 ? (parts[assignmentsIdx + 1] ?? null) : null,
  };
}

// ---------------------------------------------------------------------------
// DELETE /api/admin/analysts/[accountId]/assignments/[customerId]
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
    const client = await pool.connect();
    try {
      await assertAuthorized(client, "admin", auth.accountId, "analysts:write");
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

    // Idempotent cleanup endpoint: UUID format is the only validation. An
    // unknown but well-formed id simply deletes zero rows and returns 200.
    const { accountId, customerId } = extractIds(req);
    if (
      !accountId ||
      !customerId ||
      !UUID_RE.test(accountId) ||
      !UUID_RE.test(customerId)
    ) {
      return Response.json({ error: "Invalid parameters" }, { status: 400 });
    }

    const result = await pool.query<{ customer_id: string }>(
      `DELETE FROM analyst_customer_assignments
       WHERE account_id = $1 AND customer_id = $2
       RETURNING customer_id`,
      [accountId, customerId],
    );

    if (result.rows.length > 0) {
      void auditLog({
        actorId: auth.accountId,
        authContext: "admin",
        action: "analyst.assignment.removed",
        targetType: "account",
        targetId: accountId,
        details: { customerId },
        ipAddress: auth.meta.ipAddress,
        sid: auth.sessionId,
      });
    }

    return Response.json({ accountId, customerId });
  },
  { ctx: "admin" },
);
