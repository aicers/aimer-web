import type { NextRequest } from "next/server";
import { auditLog } from "@/lib/auth/audit-stub";
import { HttpError } from "@/lib/auth/errors";
import { verifyCsrf, verifyOrigin, withAuth } from "@/lib/auth/guards";
import { revokeInvitation } from "@/lib/auth/invitation-management";
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

  // Extract invitation ID from the URL path
  const id = req.nextUrl.pathname.split("/").pop();
  if (!id || !UUID_RE.test(id)) {
    return Response.json({ error: "Invalid invitation ID" }, { status: 400 });
  }

  try {
    await revokeInvitation(getAuthPool(), auth.accountId, id);

    await auditLog({
      actorId: auth.accountId,
      authContext: "general",
      action: "invitation.revoke",
      targetType: "invitation",
      targetId: id,
      ipAddress: auth.meta.ipAddress,
      sid: auth.sessionId,
    });

    return new Response(null, { status: 204 });
  } catch (err: unknown) {
    if (err instanceof HttpError) {
      return Response.json({ error: err.message }, { status: err.statusCode });
    }
    throw err;
  }
});
