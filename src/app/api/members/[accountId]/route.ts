import type { NextRequest } from "next/server";
import { auditLog } from "@/lib/audit";
import { HttpError } from "@/lib/auth/errors";
import { verifyCsrf, verifyOrigin, withAuth } from "@/lib/auth/guards";
import { changeRole, removeMember } from "@/lib/auth/members";
import { getAuthPool, withTransaction } from "@/lib/db/client";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// ---------------------------------------------------------------------------
// DELETE /api/members/:accountId?customer_id=...
// ---------------------------------------------------------------------------

export const DELETE = withAuth(async (req: NextRequest, auth) => {
  const originErr = verifyOrigin(req);
  if (originErr) return originErr;

  const csrfErr = verifyCsrf(req, {
    ctx: "general",
    sid: auth.sessionId,
    iat: auth.iat,
  });
  if (csrfErr) return csrfErr;

  const targetAccountId = req.nextUrl.pathname.split("/").pop();
  if (!targetAccountId || !UUID_RE.test(targetAccountId)) {
    return Response.json(
      { error: "Invalid accountId format" },
      { status: 400 },
    );
  }

  const customerId = req.nextUrl.searchParams.get("customer_id");
  if (!customerId || !UUID_RE.test(customerId)) {
    return Response.json(
      { error: "customer_id query parameter is required" },
      { status: 400 },
    );
  }

  try {
    await withTransaction(getAuthPool(), (client) =>
      removeMember(client, {
        accountId: auth.accountId,
        targetAccountId,
        customerId,
      }),
    );

    void auditLog({
      actorId: auth.accountId,
      authContext: "general",
      action: "membership.removed",
      targetType: "membership",
      targetId: targetAccountId,
      details: { customerId },
      ipAddress: auth.meta.ipAddress,
      sid: auth.sessionId,
      customerId,
    });

    return new Response(null, { status: 204 });
  } catch (err: unknown) {
    if (err instanceof HttpError) {
      return Response.json({ error: err.message }, { status: err.statusCode });
    }
    throw err;
  }
});

// ---------------------------------------------------------------------------
// PATCH /api/members/:accountId
// ---------------------------------------------------------------------------

export const PATCH = withAuth(async (req: NextRequest, auth) => {
  const originErr = verifyOrigin(req);
  if (originErr) return originErr;

  const csrfErr = verifyCsrf(req, {
    ctx: "general",
    sid: auth.sessionId,
    iat: auth.iat,
  });
  if (csrfErr) return csrfErr;

  const targetAccountId = req.nextUrl.pathname.split("/").pop();
  if (!targetAccountId || !UUID_RE.test(targetAccountId)) {
    return Response.json(
      { error: "Invalid accountId format" },
      { status: 400 },
    );
  }

  // Parse body
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

  const { customerId, roleId } = raw as Record<string, unknown>;
  if (
    typeof customerId !== "string" ||
    typeof roleId !== "number" ||
    !Number.isInteger(roleId) ||
    roleId < -2147483648 ||
    roleId > 2147483647
  ) {
    return Response.json(
      { error: "customerId (string) and roleId (integer) are required" },
      { status: 400 },
    );
  }

  if (!UUID_RE.test(customerId)) {
    return Response.json(
      { error: "Invalid customerId format" },
      { status: 400 },
    );
  }

  try {
    await withTransaction(getAuthPool(), (client) =>
      changeRole(client, {
        accountId: auth.accountId,
        targetAccountId,
        customerId,
        roleId,
      }),
    );

    void auditLog({
      actorId: auth.accountId,
      authContext: "general",
      action: "membership.role_changed",
      targetType: "membership",
      targetId: targetAccountId,
      details: { customerId, roleId },
      ipAddress: auth.meta.ipAddress,
      sid: auth.sessionId,
      customerId,
    });

    return new Response(null, { status: 204 });
  } catch (err: unknown) {
    if (err instanceof HttpError) {
      return Response.json({ error: err.message }, { status: err.statusCode });
    }
    throw err;
  }
});
