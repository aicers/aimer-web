import type { NextRequest } from "next/server";
import { auditLog } from "@/lib/auth/audit-stub";
import { clearAllAuthCookies } from "@/lib/auth/cookies";
import { withLogoutAuth } from "@/lib/auth/guards";
import { verifyJwtForLogout } from "@/lib/auth/jwt";
import { getIssuerUrl } from "@/lib/auth/oidc";
import { getOidcDiscovery } from "@/lib/auth/oidc-discovery";
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

  await auditLog({
    actorId: auth.accountId ?? "unknown",
    authContext: "general",
    action: "auth.sign_out",
    targetType: "session",
    targetId: auth.sessionId ?? undefined,
    ipAddress: auth.meta.ipAddress,
    sid: auth.sessionId ?? undefined,
  });

  // Build Keycloak logout URL
  const issuerUrl = getIssuerUrl();
  const discovery = await getOidcDiscovery(issuerUrl);
  const clientId = process.env.OIDC_GENERAL_CLIENT_ID ?? "aimer-web";
  const origin = req.nextUrl.origin;

  const logoutUrl = new URL(discovery.end_session_endpoint);
  logoutUrl.searchParams.set("client_id", clientId);
  logoutUrl.searchParams.set("post_logout_redirect_uri", origin);

  return Response.json({ logoutUrl: logoutUrl.toString() });
});
