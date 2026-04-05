import type { NextRequest } from "next/server";
import { auditLog } from "@/lib/audit";
import { assertAuthorized } from "@/lib/auth/authorization";
import { HttpError } from "@/lib/auth/errors";
import { verifyCsrf, verifyOrigin, withAuth } from "@/lib/auth/guards";
import { getAuthPool, withTransaction } from "@/lib/db/client";
import { assignAdminRole } from "@/lib/keycloak/admin-client";

const MAX_ADMINS = 3;

// Advisory lock ID for serializing admin designation requests.
// Prevents concurrent promotions from exceeding the 3-admin cap.
// Range 1000–1099 is used by migrations; customer locks start at 2000.
const ADMIN_DESIGNATION_LOCK_ID = 1100;

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// ---------------------------------------------------------------------------
// GET /api/admin/admins — list current System Admins
// ---------------------------------------------------------------------------

export const GET = withAuth(
  async (_req, auth) => {
    const pool = getAuthPool();
    const client = await pool.connect();
    try {
      await assertAuthorized(client, "admin", auth.accountId, "accounts:read");
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

    const result = await pool.query<{
      id: string;
      username: string;
      display_name: string | null;
      email: string | null;
      status: string;
      last_sign_in_at: string | null;
      created_at: string;
    }>(
      `SELECT id, username, display_name, email, status,
              last_sign_in_at, created_at
       FROM accounts
       WHERE admin_eligible = true
       ORDER BY created_at`,
    );

    return Response.json({
      admins: result.rows.map((r) => ({
        id: r.id,
        username: r.username,
        displayName: r.display_name,
        email: r.email,
        status: r.status,
        lastSignInAt: r.last_sign_in_at,
        createdAt: r.created_at,
      })),
      maxAdmins: MAX_ADMINS,
    });
  },
  { ctx: "admin" },
);

// ---------------------------------------------------------------------------
// POST /api/admin/admins — designate new System Admin
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

    const { accountId } = raw as Record<string, unknown>;
    if (typeof accountId !== "string" || !UUID_RE.test(accountId)) {
      return Response.json(
        { error: "accountId must be a valid UUID" },
        { status: 400 },
      );
    }

    try {
      const result = await withTransaction(pool, async (tx) => {
        // Serialize all designation attempts with an advisory lock.
        // A row-level FOR UPDATE on existing admin rows is insufficient:
        // concurrent requests can each lock a disjoint set and both
        // promote a new row, exceeding the cap.
        await tx.query(`SELECT pg_advisory_xact_lock($1)`, [
          ADMIN_DESIGNATION_LOCK_ID,
        ]);

        const countResult = await tx.query<{ admin_count: string }>(
          `SELECT COUNT(*) AS admin_count FROM accounts
           WHERE admin_eligible = true`,
        );

        if (Number(countResult.rows[0].admin_count) >= MAX_ADMINS) {
          throw new HttpError(
            `Maximum number of admins (${MAX_ADMINS}) reached`,
            409,
          );
        }

        // Verify target account exists, is active, and not already admin
        const accountRows = await tx.query<{
          status: string;
          oidc_subject: string;
          admin_eligible: boolean;
        }>(
          `SELECT status, oidc_subject, admin_eligible
           FROM accounts WHERE id = $1 FOR UPDATE`,
          [accountId],
        );

        if (accountRows.rows.length === 0) {
          throw new HttpError("Account not found", 404);
        }

        const account = accountRows.rows[0];
        if (account.admin_eligible) {
          throw new HttpError("Account is already an admin", 409);
        }

        if (account.status !== "active") {
          throw new HttpError(
            "Only active accounts can be designated as admin",
            409,
          );
        }

        // Set admin_eligible = true
        const updateResult = await tx.query<{ admin_eligible_at: string }>(
          `UPDATE accounts
           SET admin_eligible = true,
               admin_eligible_at = NOW(),
               updated_at = NOW()
           WHERE id = $1
           RETURNING admin_eligible_at`,
          [accountId],
        );

        return {
          oidcSubject: account.oidc_subject,
          adminEligibleAt: updateResult.rows[0].admin_eligible_at,
        };
      });

      // Assign Keycloak realm role (outside transaction — best-effort)
      try {
        await assignAdminRole(result.oidcSubject);
      } catch (keycloakErr) {
        // Roll back the DB change if Keycloak assignment fails, but only
        // if no newer admin-eligibility mutation has landed since our
        // transaction committed.  We guard on admin_eligible_at (not
        // updated_at) because updated_at is also bumped by unrelated
        // writes such as sign-in or status changes.
        await pool.query(
          `UPDATE accounts
           SET admin_eligible = false,
               admin_eligible_at = NOW(),
               updated_at = NOW()
           WHERE id = $1 AND admin_eligible_at = $2`,
          [accountId, result.adminEligibleAt],
        );
        throw keycloakErr;
      }

      void auditLog({
        actorId: auth.accountId,
        authContext: "admin",
        action: "admin.designated",
        targetType: "account",
        targetId: accountId,
        ipAddress: auth.meta.ipAddress,
        sid: auth.sessionId,
      });

      return Response.json({ id: accountId }, { status: 201 });
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
