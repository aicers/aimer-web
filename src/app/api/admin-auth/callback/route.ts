import { type NextRequest, NextResponse } from "next/server";
import { upsertAccount } from "@/lib/auth/account";
import { verifyAdminClaims } from "@/lib/auth/admin-verify";
import { auditLog } from "@/lib/auth/audit-stub";
import {
  clearOidcTempCookies,
  getOidcTempCookies,
  setAuthCookies,
} from "@/lib/auth/cookies";
import { generateCsrf } from "@/lib/auth/csrf";
import { signJwt } from "@/lib/auth/jwt";
import { exchangeCodeForTokens, getIssuerUrl } from "@/lib/auth/oidc";
import { getOidcDiscovery } from "@/lib/auth/oidc-discovery";
import { validateIdToken } from "@/lib/auth/oidc-validate";
import { extractRequestMeta } from "@/lib/auth/request-meta";
import { getAuthPool, query, withTransaction } from "@/lib/db/client";

function denyRedirect(request: NextRequest, reason: string): NextResponse {
  return NextResponse.redirect(new URL(`/deny?reason=${reason}`, request.url));
}

export async function GET(request: NextRequest): Promise<NextResponse> {
  const { searchParams } = request.nextUrl;
  const code = searchParams.get("code");
  const state = searchParams.get("state");
  const error = searchParams.get("error");

  if (error) {
    const desc = searchParams.get("error_description") ?? error;
    return NextResponse.redirect(
      new URL(
        `/deny?reason=oidc_error&detail=${encodeURIComponent(desc)}`,
        request.url,
      ),
    );
  }

  if (!code || !state) {
    return denyRedirect(request, "missing_params");
  }

  // Verify OIDC temp cookies (admin-specific)
  const temp = await getOidcTempCookies("admin");
  if (!temp) {
    return denyRedirect(request, "session_expired");
  }

  if (temp.state !== state) {
    await clearOidcTempCookies("admin");
    return denyRedirect(request, "state_mismatch");
  }

  await clearOidcTempCookies("admin");

  // Exchange code for tokens
  const issuerUrl = getIssuerUrl();
  const discovery = await getOidcDiscovery(issuerUrl);
  const clientId = process.env.OIDC_ADMIN_CLIENT_ID ?? "aimer-web-admin";
  const clientSecret = process.env.OIDC_ADMIN_CLIENT_SECRET;
  if (!clientSecret) {
    throw new Error("OIDC_ADMIN_CLIENT_SECRET must be set");
  }

  const origin = request.nextUrl.origin;
  const redirectUri = `${origin}/api/admin-auth/callback`;

  let tokens: Awaited<ReturnType<typeof exchangeCodeForTokens>>;
  try {
    tokens = await exchangeCodeForTokens({
      discovery,
      clientId,
      clientSecret,
      code,
      redirectUri,
      codeVerifier: temp.codeVerifier,
    });
  } catch {
    return denyRedirect(request, "token_exchange_failed");
  }

  // Validate ID token
  let idClaims: Awaited<ReturnType<typeof validateIdToken>>;
  try {
    idClaims = await validateIdToken({
      idToken: tokens.id_token,
      jwksUri: discovery.jwks_uri,
      issuer: discovery.issuer,
      clientId,
      nonce: temp.nonce,
    });
  } catch {
    return denyRedirect(request, "id_token_invalid");
  }

  const meta = extractRequestMeta(request);
  const pool = getAuthPool();

  // Account upsert
  const account = await withTransaction(pool, (client) =>
    upsertAccount(client, issuerUrl, idClaims),
  );

  // Status check
  if (account.status !== "active") {
    await auditLog({
      actorId: account.id,
      authContext: "admin",
      action: "admin.auth.sign_in_denied",
      targetType: "account",
      targetId: account.id,
      details: { reason: "account_inactive", status: account.status },
      ipAddress: meta.ipAddress,
    });
    return denyRedirect(request, "account_inactive");
  }

  // Admin-specific verification (acr, auth_time, role, admin_eligible)
  const denyReason = verifyAdminClaims(idClaims, account.admin_eligible);
  if (denyReason) {
    await auditLog({
      actorId: account.id,
      authContext: "admin",
      action: "admin.auth.sign_in_denied",
      targetType: "account",
      targetId: account.id,
      details: { reason: denyReason, acr: idClaims.acr },
      ipAddress: meta.ipAddress,
    });
    return denyRedirect(request, denyReason);
  }

  // Create admin session
  const sessionRows = await query<{ sid: string }>(
    pool,
    `INSERT INTO sessions (account_id, auth_context, ip_address, user_agent)
     VALUES ($1, 'admin', $2, $3)
     RETURNING sid`,
    [account.id, meta.ipAddress, meta.userAgent],
  );
  const sid = sessionRows[0].sid;

  // Sign JWT with admin issuer
  const { token, iat, exp } = await signJwt(
    { sub: account.id, sid, ctx: "admin", tv: account.token_version },
    "admin",
  );
  const csrfToken = generateCsrf({ ctx: "admin", sid, iat });
  await setAuthCookies("admin", { jwt: token, csrfToken, expiresAt: exp });

  await auditLog({
    actorId: account.id,
    authContext: "admin",
    action: "admin.auth.sign_in",
    targetType: "session",
    targetId: sid,
    ipAddress: meta.ipAddress,
    sid,
  });

  // TODO(#43): Redirect to /admin once admin pages exist
  return NextResponse.redirect(new URL("/", request.url));
}
