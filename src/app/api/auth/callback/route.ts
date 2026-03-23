import { type NextRequest, NextResponse } from "next/server";
import { countAccessibleCustomers, upsertAccount } from "@/lib/auth/account";
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
import { enforceSameAccount } from "@/lib/auth/same-account";
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

  // Verify OIDC temp cookies
  const temp = await getOidcTempCookies("general");
  if (!temp) {
    return denyRedirect(request, "session_expired");
  }

  if (temp.state !== state) {
    await clearOidcTempCookies("general");
    return denyRedirect(request, "state_mismatch");
  }

  await clearOidcTempCookies("general");

  // Exchange code for tokens
  const issuerUrl = getIssuerUrl();
  const discovery = await getOidcDiscovery(issuerUrl);
  const clientId = process.env.OIDC_GENERAL_CLIENT_ID ?? "aimer-web";
  const clientSecret = process.env.OIDC_GENERAL_CLIENT_SECRET;
  if (!clientSecret) {
    throw new Error("OIDC_GENERAL_CLIENT_SECRET must be set");
  }

  const origin = request.nextUrl.origin;
  const redirectUri = `${origin}/api/auth/callback`;

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
      authContext: "general",
      action: "auth.sign_in_denied",
      targetType: "account",
      targetId: account.id,
      details: { reason: "account_inactive", status: account.status },
      ipAddress: meta.ipAddress,
    });
    return denyRedirect(request, "account_inactive");
  }

  // Same-account enforcement: revoke previous account's sessions if different
  await enforceSameAccount(request, account.id, "general", meta);

  // Invitation stub (#51): check for invitation_token cookie
  const invitationToken = request.cookies.get("invitation_token")?.value;
  if (invitationToken) {
    // TODO(#51): Process invitation acceptance
  }

  // Bridge stub (#33): check for connection_id cookie
  const connectionId = request.cookies.get("connection_id")?.value;
  if (connectionId) {
    // TODO(#33): Process bridge flow
  }

  // Standard check: count accessible customers
  const total = await countAccessibleCustomers(pool, account.id);
  if (total === 0) {
    await auditLog({
      actorId: account.id,
      authContext: "general",
      action: "auth.sign_in_denied",
      targetType: "account",
      targetId: account.id,
      details: { reason: "no_customer_access" },
      ipAddress: meta.ipAddress,
    });
    return denyRedirect(request, "no_access");
  }

  // Create session
  const sessionRows = await query<{ sid: string }>(
    pool,
    `INSERT INTO sessions (account_id, auth_context, ip_address, user_agent)
     VALUES ($1, 'general', $2, $3)
     RETURNING sid`,
    [account.id, meta.ipAddress, meta.userAgent],
  );
  const sid = sessionRows[0].sid;

  // Sign JWT + CSRF + cookies
  const { token, iat, exp } = await signJwt({
    sub: account.id,
    sid,
    ctx: "general",
    tv: account.token_version,
  });
  const csrfToken = generateCsrf({ ctx: "general", sid, iat });
  await setAuthCookies("general", { jwt: token, csrfToken, expiresAt: exp });

  await auditLog({
    actorId: account.id,
    authContext: "general",
    action: "auth.sign_in",
    targetType: "session",
    targetId: sid,
    ipAddress: meta.ipAddress,
    sid,
  });

  return NextResponse.redirect(new URL("/", request.url));
}
