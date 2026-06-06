import type { NextRequest } from "next/server";
import { auditLog } from "@/lib/audit";
import { assertAuthorized } from "@/lib/auth/authorization";
import { HttpError } from "@/lib/auth/errors";
import { verifyCsrf, verifyOrigin, withAuth } from "@/lib/auth/guards";
import { getAuthPool, withTransaction } from "@/lib/db/client";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// /api/admin/analysts/[accountId]/assignments
function extractAccountId(req: NextRequest): string | null {
  const parts = req.nextUrl.pathname.split("/");
  const idx = parts.indexOf("analysts");
  return idx >= 0 ? (parts[idx + 1] ?? null) : null;
}

// ---------------------------------------------------------------------------
// POST /api/admin/analysts/[accountId]/assignments — add assignment
// ---------------------------------------------------------------------------

export const POST = withAuth(
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

    const accountId = extractAccountId(req);
    if (!accountId || !UUID_RE.test(accountId)) {
      return Response.json({ error: "Invalid account ID" }, { status: 400 });
    }

    let raw: unknown;
    try {
      raw = await req.json();
    } catch {
      return Response.json({ error: "Invalid JSON" }, { status: 400 });
    }

    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
      return Response.json(
        { error: "Request body must be a JSON object" },
        { status: 400 },
      );
    }

    const { customerId } = raw as Record<string, unknown>;
    if (typeof customerId !== "string" || !UUID_RE.test(customerId)) {
      return Response.json(
        { error: "customerId must be a valid UUID" },
        { status: 400 },
      );
    }

    try {
      const inserted = await withTransaction(pool, async (tx) => {
        // Account existence only — status is not checked here (an assignment
        // may be prepared on a non-active analyst; the sign-in gate enforces
        // status separately).
        const accountRows = await tx.query<{ id: string }>(
          `SELECT id FROM accounts WHERE id = $1`,
          [accountId],
        );
        if (accountRows.rows.length === 0) {
          throw new HttpError("Account not found", 404);
        }

        // Validate the customer before the INSERT so a foreign-key violation
        // never surfaces as a 500.
        const customerRows = await tx.query<{ status: string }>(
          `SELECT status FROM customers WHERE id = $1`,
          [customerId],
        );
        if (customerRows.rows.length === 0) {
          throw new HttpError("Customer not found", 404);
        }
        if (customerRows.rows[0].status !== "active") {
          throw new HttpError("Customer is not active", 400);
        }

        const insertResult = await tx.query<{ customer_id: string }>(
          `INSERT INTO analyst_customer_assignments
             (account_id, customer_id, assigned_by)
           VALUES ($1, $2, $3)
           ON CONFLICT DO NOTHING
           RETURNING customer_id`,
          [accountId, customerId, auth.accountId],
        );
        return insertResult.rows.length > 0;
      });

      if (inserted) {
        void auditLog({
          actorId: auth.accountId,
          authContext: "admin",
          action: "analyst.assignment.created",
          targetType: "account",
          targetId: accountId,
          details: { customerId },
          ipAddress: auth.meta.ipAddress,
          sid: auth.sessionId,
        });
      }

      return Response.json({ accountId, customerId });
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
  { ctx: "admin" },
);
