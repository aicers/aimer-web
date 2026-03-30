import type { NextRequest } from "next/server";
import { auditLog } from "@/lib/audit";
import { clearAllAuthCookies } from "@/lib/auth/cookies";
import { withLogoutAuth } from "@/lib/auth/guards";
import { buildKeycloakLogoutUrl } from "@/lib/auth/keycloak-logout";
import { getAuthPool, query } from "@/lib/db/client";

export const POST = withLogoutAuth(
  async (req: NextRequest, auth) => {
    const pool = getAuthPool();

    if (auth.accountId) {
      await query(
        pool,
        `UPDATE sessions SET revoked = true WHERE account_id = $1 AND revoked = false`,
        [auth.accountId],
      );

      await query(
        pool,
        `UPDATE accounts SET token_version = token_version + 1, updated_at = NOW() WHERE id = $1`,
        [auth.accountId],
      );
    }

    await clearAllAuthCookies();

    if (auth.accountId) {
      void auditLog({
        actorId: auth.accountId,
        authContext: "admin",
        action: "admin.auth.sign_out_all",
        targetType: "account",
        targetId: auth.accountId,
        ipAddress: auth.meta.ipAddress,
        sid: auth.sessionId ?? undefined,
      });
    }

    const adminClientId = process.env.OIDC_ADMIN_CLIENT_ID ?? "aimer-web-admin";
    const logoutUrl = await buildKeycloakLogoutUrl(
      req.nextUrl.origin,
      adminClientId,
    );
    return Response.json({ logoutUrl });
  },
  { cookieName: "at_admin" },
);
