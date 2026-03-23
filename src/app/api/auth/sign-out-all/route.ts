import type { NextRequest } from "next/server";
import { auditLog } from "@/lib/auth/audit-stub";
import { clearAllAuthCookies } from "@/lib/auth/cookies";
import { withLogoutAuth } from "@/lib/auth/guards";
import { getIssuerUrl } from "@/lib/auth/oidc";
import { getOidcDiscovery } from "@/lib/auth/oidc-discovery";
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

  await auditLog({
    actorId: auth.accountId ?? "unknown",
    authContext: "general",
    action: "auth.sign_out_all",
    targetType: "account",
    targetId: auth.accountId ?? undefined,
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
