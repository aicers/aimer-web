// Shared request handlers for the per-customer default analysis model
// (#473). The permission split crosses auth contexts — System
// Administrator authorizes in the ADMIN context (any customer), Analyst
// in the GENERAL context (assigned customers only) — but both surfaces
// drive the SAME underlying service/guard (`*CustomerDefaultModel`).
// These handlers are parameterized by `authContext` so the admin route
// (`/api/admin/customers/[id]/default-model`) and the customer route
// (`/api/customers/[id]/analysis/default-model`) share one implementation
// and differ only in their `withAuth` / CSRF context.

import "server-only";

import type { NextRequest } from "next/server";
import { HttpError } from "@/lib/auth/errors";
import type { AuthenticatedRequest } from "@/lib/auth/guards";
import { verifyCsrf, verifyOrigin } from "@/lib/auth/guards";
import { getAuthPool, withTransaction } from "@/lib/db/client";
import {
  clearCustomerDefaultModel,
  getEnvDefaultModel,
  readCustomerDefaultModel,
  setCustomerDefaultModel,
} from "./default-model";
import { getModelCatalog } from "./model-catalog";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Extract the `[customerId]` path segment (the segment after `customers`). */
export function extractCustomerId(req: NextRequest): string | null {
  const segments = req.nextUrl.pathname.split("/");
  const idx = segments.indexOf("customers");
  if (idx === -1 || idx + 1 >= segments.length) return null;
  const id = segments[idx + 1];
  return UUID_RE.test(id) ? id : null;
}

function errorResponse(err: unknown): Response {
  if (err instanceof HttpError) {
    return Response.json({ error: err.message }, { status: err.statusCode });
  }
  throw err;
}

export async function handleGetCustomerDefaultModel(
  req: NextRequest,
  auth: AuthenticatedRequest,
  authContext: "general" | "admin",
): Promise<Response> {
  const customerId = extractCustomerId(req);
  if (!customerId) {
    return Response.json({ error: "Invalid customer ID" }, { status: 400 });
  }
  try {
    const view = await withTransaction(getAuthPool(), (client) =>
      readCustomerDefaultModel(client, authContext, auth.accountId, customerId),
    );
    return Response.json({
      ...view,
      envDefault: getEnvDefaultModel(),
      catalog: getModelCatalog(),
    });
  } catch (err) {
    return errorResponse(err);
  }
}

export async function handlePutCustomerDefaultModel(
  req: NextRequest,
  auth: AuthenticatedRequest,
  authContext: "general" | "admin",
): Promise<Response> {
  const originErr = verifyOrigin(req);
  if (originErr) return originErr;
  const csrfErr = verifyCsrf(req, {
    ctx: authContext,
    sid: auth.sessionId,
    iat: auth.iat,
  });
  if (csrfErr) return csrfErr;

  const customerId = extractCustomerId(req);
  if (!customerId) {
    return Response.json({ error: "Invalid customer ID" }, { status: 400 });
  }

  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    return Response.json({ error: "Invalid JSON" }, { status: 400 });
  }

  try {
    const { pair, changed } = await withTransaction(getAuthPool(), (client) =>
      setCustomerDefaultModel(
        client,
        authContext,
        auth.accountId,
        customerId,
        raw,
        { ipAddress: auth.meta.ipAddress, sid: auth.sessionId },
      ),
    );
    return Response.json({ override: pair, changed });
  } catch (err) {
    return errorResponse(err);
  }
}

export async function handleDeleteCustomerDefaultModel(
  req: NextRequest,
  auth: AuthenticatedRequest,
  authContext: "general" | "admin",
): Promise<Response> {
  const originErr = verifyOrigin(req);
  if (originErr) return originErr;
  const csrfErr = verifyCsrf(req, {
    ctx: authContext,
    sid: auth.sessionId,
    iat: auth.iat,
  });
  if (csrfErr) return csrfErr;

  const customerId = extractCustomerId(req);
  if (!customerId) {
    return Response.json({ error: "Invalid customer ID" }, { status: 400 });
  }

  try {
    const { cleared } = await withTransaction(getAuthPool(), (client) =>
      clearCustomerDefaultModel(
        client,
        authContext,
        auth.accountId,
        customerId,
        {
          ipAddress: auth.meta.ipAddress,
          sid: auth.sessionId,
        },
      ),
    );
    return Response.json({ cleared });
  } catch (err) {
    return errorResponse(err);
  }
}
