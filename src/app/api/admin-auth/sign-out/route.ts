import type { NextRequest } from "next/server";
import { auditLog } from "@/lib/auth/audit-stub";
import { clearAuthCookies, getAuthCookie } from "@/lib/auth/cookies";
import { withLogoutAuth } from "@/lib/auth/guards";
import { buildKeycloakLogoutUrl } from "@/lib/auth/keycloak-logout";
import { getAuthPool, query } from "@/lib/db/client";

export const POST = withLogoutAuth(
  async (req: NextRequest, auth) => {
    const pool = getAuthPool();

    // Revoke admin session only
    if (auth.sessionId) {
      await query(
        pool,
        `UPDATE sessions SET revoked = true WHERE sid = $1 AND revoked = false`,
        [auth.sessionId],
      );
    }

    // Clear admin cookies only — preserve general session
    await clearAuthCookies("admin");

    await auditLog({
      actorId: auth.accountId ?? "unknown",
      authContext: "admin",
      action: "admin.auth.sign_out",
      targetType: "session",
      targetId: auth.sessionId ?? undefined,
      ipAddress: auth.meta.ipAddress,
      sid: auth.sessionId ?? undefined,
    });

    // Conditional IdP logout: preserve SSO if general session exists
    const generalToken = await getAuthCookie("general");
    if (generalToken) {
      // General session remains — do not terminate Keycloak SSO
      return Response.json({ logoutUrl: null });
    }

    // No general session — terminate Keycloak SSO
    const adminClientId = process.env.OIDC_ADMIN_CLIENT_ID ?? "aimer-web-admin";
    const logoutUrl = await buildKeycloakLogoutUrl(
      req.nextUrl.origin,
      adminClientId,
    );
    return Response.json({ logoutUrl });
  },
  { cookieName: "at_admin" },
);
