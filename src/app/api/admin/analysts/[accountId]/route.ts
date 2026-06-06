import type { NextRequest } from "next/server";
import { auditLog } from "@/lib/audit";
import { assertAuthorized } from "@/lib/auth/authorization";
import { HttpError } from "@/lib/auth/errors";
import { verifyCsrf, verifyOrigin, withAuth } from "@/lib/auth/guards";
import { getAuthPool, withTransaction } from "@/lib/db/client";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// /api/admin/analysts/[accountId]
function extractAccountId(req: NextRequest): string | null {
  const parts = req.nextUrl.pathname.split("/");
  const idx = parts.indexOf("analysts");
  return idx >= 0 ? (parts[idx + 1] ?? null) : null;
}

// ---------------------------------------------------------------------------
// GET /api/admin/analysts/[accountId] — analyst detail
// ---------------------------------------------------------------------------

export const GET = withAuth(
  async (req: NextRequest, auth) => {
    const pool = getAuthPool();
    const client = await pool.connect();
    try {
      await assertAuthorized(client, "admin", auth.accountId, "analysts:read");
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

    const accountRows = await pool.query<{
      account_id: string;
      email: string | null;
      display_name: string;
      analyst_eligible: boolean;
      last_sign_in_at: string | null;
    }>(
      `SELECT id AS account_id, email, display_name, analyst_eligible,
              last_sign_in_at
       FROM accounts WHERE id = $1`,
      [accountId],
    );
    if (accountRows.rows.length === 0) {
      return Response.json({ error: "Account not found" }, { status: 404 });
    }
    const account = accountRows.rows[0];

    const customerRows = await pool.query<{
      id: string;
      external_key: string;
      name: string;
      status: string;
    }>(
      `SELECT c.id, c.external_key, c.name, c.status
       FROM analyst_customer_assignments aca
       JOIN customers c ON c.id = aca.customer_id
       WHERE aca.account_id = $1
       ORDER BY aca.created_at`,
      [accountId],
    );

    return Response.json({
      accountId: account.account_id,
      email: account.email,
      displayName: account.display_name,
      analystEligible: account.analyst_eligible,
      lastSignInAt: account.last_sign_in_at,
      assignedCustomerIds: customerRows.rows.map((c) => c.id),
      assignedCustomers: customerRows.rows.map((c) => ({
        id: c.id,
        externalKey: c.external_key,
        name: c.name,
        status: c.status,
      })),
    });
  },
  { ctx: "admin" },
);

// ---------------------------------------------------------------------------
// PATCH /api/admin/analysts/[accountId] — revoke (toggle analyst_eligible)
// ---------------------------------------------------------------------------

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

    const { analystEligible } = raw as Record<string, unknown>;
    // This endpoint is revocation only: per the #269 contract the body must be
    // `{ "analystEligible": false }`. Re-enablement goes through
    // `POST /api/admin/analysts`, which enforces an active account and
    // non-empty, active `customerIds`. Accepting `true` here would re-enable a
    // suspended/disabled account and bypass that validation and audit path.
    if (analystEligible !== false) {
      return Response.json(
        { error: "analystEligible must be false (revocation only)" },
        { status: 400 },
      );
    }

    try {
      const result = await withTransaction(pool, async (tx) => {
        // Existence check only — revoke is valid on any account status so a
        // suspended/disabled account can still be cleaned up.
        const existing = await tx.query<{ analyst_eligible: boolean }>(
          `SELECT analyst_eligible FROM accounts WHERE id = $1 FOR UPDATE`,
          [accountId],
        );
        if (existing.rows.length === 0) {
          throw new HttpError("Account not found", 404);
        }
        const previous = existing.rows[0].analyst_eligible;

        // Update only when the column actually transitions; an empty
        // RETURNING set means a no-op.
        const updated = await tx.query<{ analyst_eligible: boolean }>(
          `UPDATE accounts SET analyst_eligible = $1, updated_at = NOW()
           WHERE id = $2 AND analyst_eligible IS DISTINCT FROM $1
           RETURNING analyst_eligible`,
          [analystEligible, accountId],
        );

        return { changed: updated.rows.length > 0, previous };
      });

      if (result.changed) {
        void auditLog({
          actorId: auth.accountId,
          authContext: "admin",
          action: "account.analyst_eligible_changed",
          targetType: "account",
          targetId: accountId,
          details: { from: result.previous, to: analystEligible },
          ipAddress: auth.meta.ipAddress,
          sid: auth.sessionId,
        });
      }

      return Response.json({ accountId, analystEligible });
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
