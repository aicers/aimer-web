import type { NextRequest } from "next/server";
import { assertAuthorized } from "@/lib/auth/authorization";
import { HttpError } from "@/lib/auth/errors";
import { verifyCsrf, verifyOrigin, withAuth } from "@/lib/auth/guards";
import { getAuthPool } from "@/lib/db/client";
import { provisionCustomerDb } from "@/lib/db/provision-customer";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

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
    const authzClient = await pool.connect();
    try {
      await assertAuthorized(
        authzClient,
        "admin",
        auth.accountId,
        "customers:write",
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

    const segments = req.nextUrl.pathname.split("/");
    const customerId = segments[segments.length - 2];
    if (!customerId || !UUID_RE.test(customerId)) {
      return Response.json({ error: "Invalid customer ID" }, { status: 400 });
    }

    const { rows } = await pool.query<{
      database_status: string;
    }>("SELECT database_status FROM customers WHERE id = $1", [customerId]);

    if (rows.length === 0) {
      return Response.json({ error: "Customer not found" }, { status: 404 });
    }

    if (rows[0].database_status !== "failed") {
      return Response.json(
        { error: "Retry is only allowed when database_status is 'failed'" },
        { status: 409 },
      );
    }

    await pool.query(
      "UPDATE customers SET database_status = 'provisioning' WHERE id = $1",
      [customerId],
    );

    const databaseStatus = await provisionCustomerDb(pool, customerId, {
      isRetry: true,
      actorContext: {
        actorId: auth.accountId,
        authContext: "admin",
        ipAddress: auth.meta.ipAddress,
        sid: auth.sessionId,
      },
    });

    auth.audit.targetId = customerId;
    auth.audit.details = { databaseStatus };

    return Response.json({ databaseStatus });
  },
  {
    ctx: "admin",
    audit: {
      action: "customer_db.provision_retried",
      targetType: "customer",
    },
  },
);
