import type { NextRequest } from "next/server";
import { auditLog } from "@/lib/auth/audit-stub";
import { HttpError } from "@/lib/auth/errors";
import { verifyCsrf, verifyOrigin, withAuth } from "@/lib/auth/guards";
import { changeMemberRole, removeMember } from "@/lib/auth/members";
import { getAuthPool } from "@/lib/db/client";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const DELETE = withAuth(async (req: NextRequest, auth) => {
  const originErr = verifyOrigin(req);
  if (originErr) return originErr;

  const csrfErr = verifyCsrf(req, {
    ctx: "general",
    sid: auth.sessionId,
    iat: auth.iat,
  });
  if (csrfErr) return csrfErr;

  const accountId = req.nextUrl.pathname.split("/").pop();
  if (!accountId || !UUID_RE.test(accountId)) {
    return Response.json(
      { error: "Invalid accountId format" },
      { status: 400 },
    );
  }

  const customerId = req.nextUrl.searchParams.get("customer_id");
  if (!customerId || !UUID_RE.test(customerId)) {
    return Response.json(
      { error: "customer_id query parameter is required (UUID)" },
      { status: 400 },
    );
  }

  try {
    await removeMember(getAuthPool(), {
      actorId: auth.accountId,
      targetAccountId: accountId,
      customerId,
    });

    await auditLog({
      actorId: auth.accountId,
      authContext: "general",
      action: "member.remove",
      targetType: "membership",
      targetId: accountId,
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

export const PATCH = withAuth(async (req: NextRequest, auth) => {
  const originErr = verifyOrigin(req);
  if (originErr) return originErr;

  const csrfErr = verifyCsrf(req, {
    ctx: "general",
    sid: auth.sessionId,
    iat: auth.iat,
  });
  if (csrfErr) return csrfErr;

  const accountId = req.nextUrl.pathname.split("/").pop();
  if (!accountId || !UUID_RE.test(accountId)) {
    return Response.json(
      { error: "Invalid accountId format" },
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

  const { customerId, roleId } = raw as Record<string, unknown>;
  if (typeof customerId !== "string" || !UUID_RE.test(customerId)) {
    return Response.json(
      { error: "customerId is required (UUID)" },
      { status: 400 },
    );
  }

  if (typeof roleId !== "number" || !Number.isInteger(roleId)) {
    return Response.json(
      { error: "roleId is required (integer)" },
      { status: 400 },
    );
  }

  try {
    await changeMemberRole(getAuthPool(), {
      actorId: auth.accountId,
      targetAccountId: accountId,
      customerId,
      roleId,
    });

    await auditLog({
      actorId: auth.accountId,
      authContext: "general",
      action: "member.role_change",
      targetType: "membership",
      targetId: accountId,
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
