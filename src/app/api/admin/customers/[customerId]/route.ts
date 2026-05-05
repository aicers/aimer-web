import type { NextRequest } from "next/server";
import { assertAuthorized } from "@/lib/auth/authorization";
import { updateCustomer, validateCustomerFields } from "@/lib/auth/customers";
import { deleteCustomer } from "@/lib/auth/delete-customer";
import { HttpError } from "@/lib/auth/errors";
import { verifyCsrf, verifyOrigin, withAuth } from "@/lib/auth/guards";
import {
  getAuthPool,
  getMigrationAuditPool,
  withTransaction,
} from "@/lib/db/client";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

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

    const customerId = req.nextUrl.pathname.split("/").pop();
    if (!customerId || !UUID_RE.test(customerId)) {
      return Response.json({ error: "Invalid customer ID" }, { status: 400 });
    }

    try {
      await deleteCustomer(getAuthPool(), getMigrationAuditPool(), customerId, {
        actorId: auth.accountId,
        authContext: "admin",
        ipAddress: auth.meta.ipAddress,
        sid: auth.sessionId,
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

    auth.audit.targetId = customerId;

    return new Response(null, { status: 204 });
  },
  {
    ctx: "admin",
    audit: { action: "customer.deleted", targetType: "customer" },
  },
);

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

    const customerId = req.nextUrl.pathname.split("/").pop();
    if (!customerId || !UUID_RE.test(customerId)) {
      return Response.json({ error: "Invalid customer ID" }, { status: 400 });
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

    const { name, externalKey, description } = raw as Record<string, unknown>;

    if (
      name === undefined &&
      externalKey === undefined &&
      description === undefined
    ) {
      return Response.json({ error: "no_fields_to_update" }, { status: 400 });
    }

    let validated: ReturnType<typeof validateCustomerFields>;
    try {
      validated = validateCustomerFields({ name, externalKey, description });
    } catch (err) {
      if (err instanceof HttpError) {
        return Response.json(
          { error: err.message },
          { status: err.statusCode },
        );
      }
      throw err;
    }

    try {
      const result = await withTransaction(pool, (client) =>
        updateCustomer(client, customerId, {
          name: validated.name,
          externalKey: validated.externalKey,
          description: validated.description,
        }),
      );

      auth.audit.targetId = customerId;
      auth.audit.customerId = customerId;
      auth.audit.details = {
        changedFields: result.changedFields,
        previous: result.previous,
        next: result.next,
        customerId,
        customerName: result.name,
      };

      return Response.json({
        id: result.id,
        name: result.name,
        externalKey: result.externalKey,
        description: result.description,
        status: result.status,
        databaseStatus: result.databaseStatus,
        changedFields: result.changedFields,
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
  {
    ctx: "admin",
    audit: { action: "customer.updated", targetType: "customer" },
  },
);
