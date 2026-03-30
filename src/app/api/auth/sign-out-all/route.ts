import type { NextRequest } from "next/server";
import { auditLog } from "@/lib/audit";
import { clearAllAuthCookies } from "@/lib/auth/cookies";
import { withLogoutAuth } from "@/lib/auth/guards";
import { buildKeycloakLogoutUrl } from "@/lib/auth/keycloak-logout";
import { getAuthPool, query } from "@/lib/db/client";

export const POST = withLogoutAuth(async (req: NextRequest, auth) => {
  const pool = getAuthPool();

  if (auth.accountId) {
    // Revoke all sessions for this account
    await query(
      pool,
      `UPDATE sessions SET revoked = true WHERE account_id = $1 AND revoked = false`,
      [auth.accountId],
    );

    // Bump token_version to invalidate all outstanding JWTs
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
      authContext: "general",
      action: "general.auth.sign_out_all",
      targetType: "account",
      targetId: auth.accountId,
      ipAddress: auth.meta.ipAddress,
      sid: auth.sessionId ?? undefined,
    });
  }

  const logoutUrl = await buildKeycloakLogoutUrl(req.nextUrl.origin);
  return Response.json({ logoutUrl });
});
