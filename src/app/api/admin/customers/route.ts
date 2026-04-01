import type { NextRequest } from "next/server";
import { createCustomer } from "@/lib/auth/customers";
import { HttpError } from "@/lib/auth/errors";
import { verifyCsrf, verifyOrigin, withAuth } from "@/lib/auth/guards";
import { getAuthPool, withTransaction } from "@/lib/db/client";
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

    if (
      typeof name !== "string" ||
      typeof externalKey !== "string" ||
      !name.trim() ||
      !externalKey.trim()
    ) {
      return Response.json(
        { error: "name and externalKey are required non-empty strings" },
        { status: 400 },
      );
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

    if (description !== undefined && typeof description !== "string") {
      return Response.json(
        { error: "description must be a string" },
        { status: 400 },
      );
    }

    try {
      const result = await withTransaction(getAuthPool(), (client) =>
        createCustomer(client, {
          name,
          externalKey,
          description:
            typeof description === "string" ? description : undefined,
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
        name,
        externalKey,
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
