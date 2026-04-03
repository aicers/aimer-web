import type { NextRequest } from "next/server";
import { assertAuthorized } from "@/lib/auth/authorization";
import { HttpError } from "@/lib/auth/errors";
import { verifyCsrf, verifyOrigin, withAuth } from "@/lib/auth/guards";
import { getAuthPool } from "@/lib/db/client";

function extractAiceId(req: NextRequest): string | null {
  // /api/admin/environments/[aiceId]/customers
  const parts = req.nextUrl.pathname.split("/");
  const idx = parts.indexOf("environments");
  return idx >= 0 ? parts[idx + 1] : null;
}

export const GET = withAuth(
  async (req: NextRequest, auth) => {
    const pool = getAuthPool();
    const client = await pool.connect();
    try {
      await assertAuthorized(
        client,
        "admin",
        auth.accountId,
        "aice-environments:read",
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
      client.release();
    }

    const aiceId = extractAiceId(req);
    if (!aiceId) {
      return Response.json(
        { error: "Missing aiceId parameter" },
        { status: 400 },
      );
    }

    const result = await pool.query<{
      customer_id: string;
      customer_name: string;
      external_key: string;
      created_at: string;
    }>(
      `SELECT ec.customer_id, c.name AS customer_name,
              c.external_key, ec.created_at
       FROM aice_environment_customers ec
       JOIN customers c ON c.id = ec.customer_id
       WHERE ec.aice_id = $1
       ORDER BY c.name`,
      [aiceId],
    );

    return Response.json({
      customers: result.rows.map((r) => ({
        customerId: r.customer_id,
        customerName: r.customer_name,
        externalKey: r.external_key,
        createdAt: r.created_at,
      })),
    });
  },
  { ctx: "admin" },
);

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
        "aice-environments:write",
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

    const aiceId = extractAiceId(req);
    if (!aiceId) {
      return Response.json(
        { error: "Missing aiceId parameter" },
        { status: 400 },
      );
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

    // Verify environment exists
    const envCheck = await pool.query(
      `SELECT 1 FROM aice_environments WHERE aice_id = $1`,
      [aiceId],
    );
    if (envCheck.rows.length === 0) {
      return Response.json({ error: "Environment not found" }, { status: 404 });
    }

    // Verify customer exists
    const custCheck = await pool.query(
      `SELECT 1 FROM customers WHERE id = $1`,
      [customerId],
    );
    if (custCheck.rows.length === 0) {
      return Response.json({ error: "Customer not found" }, { status: 404 });
    }

    try {
      await pool.query(
        `INSERT INTO aice_environment_customers (aice_id, customer_id)
         VALUES ($1, $2)`,
        [aiceId, customerId],
      );
    } catch (err: unknown) {
      const pgErr = err as { code?: string };
      if (pgErr.code === "23505") {
        return Response.json(
          { error: "Customer already linked to this environment" },
          { status: 409 },
        );
      }
      throw err;
    }

    auth.audit.targetId = aiceId;
    auth.audit.details = { aiceId, customerId };

    return Response.json({ aiceId, customerId }, { status: 201 });
  },
  {
    ctx: "admin",
    audit: {
      action: "environment.customer_linked",
      targetType: "environment",
    },
  },
);
