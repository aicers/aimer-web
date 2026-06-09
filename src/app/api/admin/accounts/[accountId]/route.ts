import type { NextRequest } from "next/server";
import { auditLog } from "@/lib/audit";
import { assertAuthorized } from "@/lib/auth/authorization";
import { HttpError } from "@/lib/auth/errors";
import { verifyCsrf, verifyOrigin, withAuth } from "@/lib/auth/guards";
import { getAuthPool, withTransaction } from "@/lib/db/client";
import { reconcileGroupsForAccount } from "@/lib/groups/lifecycle";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const VALID_STATUSES = new Set(["active", "suspended"]);

export const PATCH = withAuth(
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
      return Response.json({ error: "cannot_suspend_self" }, { status: 400 });
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

    const { status } = raw as Record<string, unknown>;
    if (typeof status !== "string" || !VALID_STATUSES.has(status)) {
      return Response.json(
        { error: "status must be 'active' or 'suspended'" },
        { status: 400 },
      );
    }

    try {
      const result = await withTransaction(pool, async (tx) => {
        const rows = await tx.query<{ status: string }>(
          `SELECT status FROM accounts WHERE id = $1 FOR UPDATE`,
          [accountId],
        );

        if (rows.rows.length === 0) {
          throw new HttpError("Account not found", 404);
        }

        const currentStatus = rows.rows[0].status;
        if (currentStatus === "disabled") {
          throw new HttpError(
            "Cannot change status of a disabled account",
            409,
          );
        }
        if (currentStatus === status) {
          return { changed: false, previousStatus: currentStatus };
        }

        await tx.query(
          `UPDATE accounts SET status = $1, updated_at = NOW() WHERE id = $2`,
          [status, accountId],
        );

        if (status === "suspended") {
          await tx.query(
            `UPDATE sessions SET revoked = true
             WHERE account_id = $1 AND revoked = false`,
            [accountId],
          );
          await tx.query(
            `UPDATE accounts SET token_version = token_version + 1
             WHERE id = $1`,
            [accountId],
          );
        }

        return { changed: true, previousStatus: currentStatus };
      });

      if (result.changed) {
        const action =
          status === "suspended" ? "account.suspended" : "account.restored";
        void auditLog({
          actorId: auth.accountId,
          authContext: "admin",
          action,
          targetType: "account",
          targetId: accountId,
          details: { previousStatus: result.previousStatus, newStatus: status },
          ipAddress: auth.meta.ipAddress,
          sid: auth.sessionId,
        });

        // Group lifecycle (#510): a `suspended` account no longer qualifies
        // as a manager, so re-evaluate every group it owns or helps manage
        // (owner transfer / auto-delete); restoring it can re-qualify it.
        // Best-effort — the sweep converges if this hiccups.
        try {
          await reconcileGroupsForAccount(pool, accountId, {
            actorContext: {
              actorId: auth.accountId,
              authContext: "admin",
              ipAddress: auth.meta.ipAddress,
              sid: auth.sessionId,
            },
          });
        } catch (err) {
          console.error(
            `Group lifecycle reconcile after account ${accountId} status change failed:`,
            (err as Error).message,
          );
        }
      }

      return Response.json({ id: accountId, status });
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
