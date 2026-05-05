import type { NextRequest } from "next/server";
import { assertAuthorized } from "@/lib/auth/authorization";
import { createCustomer, validateCustomerFields } from "@/lib/auth/customers";
import { HttpError } from "@/lib/auth/errors";
import { verifyCsrf, verifyOrigin, withAuth } from "@/lib/auth/guards";
import { getAuthPool, withTransaction } from "@/lib/db/client";
import { provisionCustomerDb } from "@/lib/db/provision-customer";

export const GET = withAuth(
  async (_req, auth) => {
    const pool = getAuthPool();
    const client = await pool.connect();
    try {
      await assertAuthorized(client, "admin", auth.accountId, "customers:read");
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
      name: string;
      external_key: string;
      description: string | null;
      status: string;
      database_status: string;
      created_at: string;
    }>(
      `SELECT id, name, external_key, description, status,
              database_status, created_at
       FROM customers
       ORDER BY created_at`,
    );

    return Response.json({
      customers: result.rows.map((r) => ({
        id: r.id,
        name: r.name,
        externalKey: r.external_key,
        description: r.description,
        status: r.status,
        databaseStatus: r.database_status,
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

    // Parse request body
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

    const { name, externalKey, description, managerAccountId } = raw as Record<
      string,
      unknown
    >;

    let validated: ReturnType<typeof validateCustomerFields>;
    try {
      validated = validateCustomerFields(
        { name, externalKey, description },
        { requireAll: true },
      );
    } catch (err) {
      if (err instanceof HttpError) {
        return Response.json(
          { error: err.message },
          { status: err.statusCode },
        );
      }
      throw err;
    }

    if (typeof managerAccountId !== "string") {
      return Response.json(
        { error: "manager_account_id_required" },
        { status: 400 },
      );
    }

    if (!UUID_RE.test(managerAccountId)) {
      return Response.json(
        { error: "Invalid managerAccountId format" },
        { status: 400 },
      );
    }

    try {
      const result = await withTransaction(getAuthPool(), (client) =>
        createCustomer(client, {
          name: validated.name as string,
          externalKey: validated.externalKey as string,
          description: validated.description ?? undefined,
          managerAccountId,
        }),
      );

      // Provision customer database after auth_db transaction commits
      const pool = getAuthPool();
      const databaseStatus = await provisionCustomerDb(pool, result.id, {
        actorContext: {
          actorId: auth.accountId,
          authContext: "admin",
          ipAddress: auth.meta.ipAddress,
          sid: auth.sessionId,
        },
      });

      auth.audit.targetId = result.id;
      auth.audit.details = {
        name: validated.name,
        externalKey: validated.externalKey,
        managerAccountId,
        databaseStatus,
      };

      return Response.json(
        {
          id: result.id,
          name: result.name,
          externalKey: result.externalKey,
          status: result.status,
          databaseStatus,
        },
        { status: 201 },
      );
    } catch (err: unknown) {
      if (err instanceof HttpError) {
        return Response.json(
          { error: err.message },
          { status: err.statusCode },
        );
      }
      throw err;
    }
  },
  {
    ctx: "admin",
    audit: { action: "customer.created", targetType: "customer" },
  },
);
