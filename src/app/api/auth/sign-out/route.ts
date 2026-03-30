import type { NextRequest } from "next/server";
import { auditLog } from "@/lib/audit";
import { clearAllAuthCookies } from "@/lib/auth/cookies";
import { withLogoutAuth } from "@/lib/auth/guards";
import { verifyJwtForLogout } from "@/lib/auth/jwt";
import { buildKeycloakLogoutUrl } from "@/lib/auth/keycloak-logout";
import { getAuthPool, query } from "@/lib/db/client";

export const POST = withLogoutAuth(async (req: NextRequest, auth) => {
  const pool = getAuthPool();

  // Revoke general session
  if (auth.sessionId) {
    await query(
      pool,
      `UPDATE sessions SET revoked = true WHERE sid = $1 AND revoked = false`,
      [auth.sessionId],
    );
  }

  // Also revoke admin session if present in current browser
  const adminToken = req.cookies.get("at_admin")?.value;
  if (adminToken) {
    const adminClaims = await verifyJwtForLogout(adminToken);
    if (adminClaims) {
      await query(
        pool,
        `UPDATE sessions SET revoked = true WHERE sid = $1 AND revoked = false`,
        [adminClaims.sid],
      );
    }
  }

  await clearAllAuthCookies();

  if (auth.accountId) {
    void auditLog({
      actorId: auth.accountId,
      authContext: "general",
      action: "general.auth.sign_out",
      targetType: "session",
      targetId: auth.sessionId ?? undefined,
      ipAddress: auth.meta.ipAddress,
      sid: auth.sessionId ?? undefined,
    });
  }

  const logoutUrl = await buildKeycloakLogoutUrl(req.nextUrl.origin);
  return Response.json({ logoutUrl });
});
