import type { NextRequest } from "next/server";
import { auditLog } from "@/lib/audit";
import { assertAuthorized } from "@/lib/auth/authorization";
import { HttpError } from "@/lib/auth/errors";
import { verifyCsrf, verifyOrigin, withAuth } from "@/lib/auth/guards";
import { getAuthPool, withTransaction } from "@/lib/db/client";
import { removeAdminRole } from "@/lib/keycloak/admin-client";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// ---------------------------------------------------------------------------
// DELETE /api/admin/admins/[accountId] — revoke System Admin
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
      await assertAuthorized(client, "admin", auth.accountId, "accounts:write");
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

    const accountId = req.nextUrl.pathname.split("/").pop();
    if (!accountId || !UUID_RE.test(accountId)) {
      return Response.json({ error: "Invalid account ID" }, { status: 400 });
    }

    if (accountId === auth.accountId) {
      return Response.json({ error: "cannot_revoke_self" }, { status: 400 });
    }

    try {
      const result = await withTransaction(pool, async (tx) => {
        const accountRows = await tx.query<{
          admin_eligible: boolean;
          oidc_subject: string;
        }>(
          `SELECT admin_eligible, oidc_subject FROM accounts
           WHERE id = $1 FOR UPDATE`,
          [accountId],
        );

        if (accountRows.rows.length === 0) {
          throw new HttpError("Account not found", 404);
        }

        const account = accountRows.rows[0];
        if (!account.admin_eligible) {
          throw new HttpError("Account is not an admin", 409);
        }

        // Set admin_eligible = false
        await tx.query(
          `UPDATE accounts
           SET admin_eligible = false,
               admin_eligible_at = NOW(),
               updated_at = NOW()
           WHERE id = $1`,
          [accountId],
        );

        // Revoke all admin sessions immediately.
        // General sessions are left intact — the user can still use
        // the non-admin portal.  For admin JWTs already in flight,
        // verifyJwtFull rejects them via the admin_eligible = false
        // check, so a token_version bump is not needed.
        await tx.query(
          `UPDATE sessions SET revoked = true
           WHERE account_id = $1 AND auth_context = 'admin' AND revoked = false`,
          [accountId],
        );

        return { oidcSubject: account.oidc_subject };
      });

      // Remove Keycloak realm role (outside transaction — best-effort)
      try {
        await removeAdminRole(result.oidcSubject);
      } catch {
        // Keycloak role removal is best-effort; the DB change is
        // authoritative. Log the failure but don't revert.
      }

      void auditLog({
        actorId: auth.accountId,
        authContext: "admin",
        action: "admin.revoked",
        targetType: "account",
        targetId: accountId,
        ipAddress: auth.meta.ipAddress,
        sid: auth.sessionId,
      });

      return new Response(null, { status: 204 });
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
