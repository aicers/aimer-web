import type { NextRequest } from "next/server";
import { auditLog } from "@/lib/audit";
import { assertAuthorized } from "@/lib/auth/authorization";
import { HttpError } from "@/lib/auth/errors";
import { verifyCsrf, verifyOrigin, withAuth } from "@/lib/auth/guards";
import { getAuthPool, withTransaction } from "@/lib/db/client";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// ---------------------------------------------------------------------------
// GET /api/admin/analysts — list analysts
// ---------------------------------------------------------------------------

export const GET = withAuth(
  async (_req: NextRequest, auth) => {
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

    // An account is listed if it is currently analyst-eligible OR still has
    // assignment rows (so revoked-with-stale-assignments accounts remain
    // visible to admins for cleanup).
    const result = await pool.query<{
      account_id: string;
      email: string | null;
      display_name: string;
      analyst_eligible: boolean;
      assigned_customer_ids: string[];
      last_sign_in_at: string | null;
    }>(
      `SELECT a.id AS account_id,
              a.email,
              a.display_name,
              a.analyst_eligible,
              a.last_sign_in_at,
              COALESCE(
                array_agg(aca.customer_id ORDER BY aca.created_at)
                  FILTER (WHERE aca.customer_id IS NOT NULL),
                '{}'
              ) AS assigned_customer_ids
       FROM accounts a
       LEFT JOIN analyst_customer_assignments aca ON aca.account_id = a.id
       WHERE a.analyst_eligible = true OR aca.customer_id IS NOT NULL
       GROUP BY a.id
       ORDER BY a.created_at`,
    );

    return Response.json({
      analysts: result.rows.map((r) => ({
        accountId: r.account_id,
        email: r.email,
        displayName: r.display_name,
        analystEligible: r.analyst_eligible,
        assignedCustomerIds: r.assigned_customer_ids,
        lastSignInAt: r.last_sign_in_at,
      })),
    });
  },
  { ctx: "admin" },
);

// ---------------------------------------------------------------------------
// POST /api/admin/analysts — direct designation
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

    const { accountId, customerIds } = raw as Record<string, unknown>;
    if (typeof accountId !== "string" || !UUID_RE.test(accountId)) {
      return Response.json(
        { error: "accountId must be a valid UUID" },
        { status: 400 },
      );
    }

    if (
      !Array.isArray(customerIds) ||
      customerIds.length === 0 ||
      !customerIds.every((id) => typeof id === "string" && UUID_RE.test(id))
    ) {
      return Response.json(
        { error: "customerIds must be a non-empty array of UUIDs" },
        { status: 400 },
      );
    }

    // Dedupe server-side so a repeated id cannot inflate the inserted-row
    // count or emit a duplicate audit event.
    const uniqueCustomerIds = [...new Set(customerIds as string[])];

    try {
      const result = await withTransaction(pool, async (tx) => {
        const accountRows = await tx.query<{ status: string }>(
          `SELECT status FROM accounts WHERE id = $1 FOR UPDATE`,
          [accountId],
        );
        if (accountRows.rows.length === 0) {
          throw new HttpError("Account not found", 404);
        }
        if (accountRows.rows[0].status !== "active") {
          throw new HttpError(
            "Only active accounts can be designated as analyst",
            400,
          );
        }

        // Validate every customer exists and is active before any INSERT so a
        // foreign-key violation never surfaces as a 500.
        const customerRows = await tx.query<{ id: string; status: string }>(
          `SELECT id, status FROM customers WHERE id = ANY($1::uuid[])`,
          [uniqueCustomerIds],
        );
        const customerStatus = new Map(
          customerRows.rows.map((c) => [c.id, c.status]),
        );
        for (const id of uniqueCustomerIds) {
          const status = customerStatus.get(id);
          if (status === undefined) {
            throw new HttpError(`Customer not found: ${id}`, 404);
          }
          if (status !== "active") {
            throw new HttpError(`Customer is not active: ${id}`, 400);
          }
        }

        // Flip analyst_eligible only when it actually transitions.
        const eligibleResult = await tx.query<{ analyst_eligible: boolean }>(
          `UPDATE accounts SET analyst_eligible = true, updated_at = NOW()
           WHERE id = $1 AND analyst_eligible IS DISTINCT FROM true
           RETURNING analyst_eligible`,
          [accountId],
        );
        const eligibleChanged = eligibleResult.rows.length > 0;

        // Insert assignments; RETURNING tells us which rows were actually new.
        const insertResult = await tx.query<{ customer_id: string }>(
          `INSERT INTO analyst_customer_assignments
             (account_id, customer_id, assigned_by)
           SELECT $1, c, $3 FROM unnest($2::uuid[]) AS c
           ON CONFLICT DO NOTHING
           RETURNING customer_id`,
          [accountId, uniqueCustomerIds, auth.accountId],
        );
        const insertedCustomerIds = insertResult.rows.map((r) => r.customer_id);

        const currentRows = await tx.query<{ customer_id: string }>(
          `SELECT customer_id FROM analyst_customer_assignments
           WHERE account_id = $1
           ORDER BY created_at`,
          [accountId],
        );
        const assignedCustomerIds = currentRows.rows.map((r) => r.customer_id);

        return { eligibleChanged, insertedCustomerIds, assignedCustomerIds };
      });

      if (result.eligibleChanged) {
        void auditLog({
          actorId: auth.accountId,
          authContext: "admin",
          action: "account.analyst_eligible_changed",
          targetType: "account",
          targetId: accountId,
          details: { from: false, to: true },
          ipAddress: auth.meta.ipAddress,
          sid: auth.sessionId,
        });
      }
      for (const customerId of result.insertedCustomerIds) {
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

      return Response.json({
        accountId,
        analystEligible: true,
        assignedCustomerIds: result.assignedCustomerIds,
      });
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
