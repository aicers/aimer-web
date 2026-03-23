import { type NextRequest, NextResponse } from "next/server";
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
    return NextResponse.redirect(
      new URL("/deny?reason=missing_params", request.url),
    );
  }

  // Verify OIDC temp cookies
  const temp = await getOidcTempCookies();
  if (!temp) {
    return NextResponse.redirect(
      new URL("/deny?reason=session_expired", request.url),
    );
  }

  if (temp.state !== state) {
    await clearOidcTempCookies();
    return NextResponse.redirect(
      new URL("/deny?reason=state_mismatch", request.url),
    );
  }

  await clearOidcTempCookies();

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
    return NextResponse.redirect(
      new URL("/deny?reason=token_exchange_failed", request.url),
    );
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
    return NextResponse.redirect(
      new URL("/deny?reason=id_token_invalid", request.url),
    );
  }

  const meta = extractRequestMeta(request);

  // Account upsert
  const pool = getAuthPool();
  const account = await withTransaction(pool, async (client) => {
    const result = await client.query<{
      id: string;
      status: string;
      token_version: number;
      locale: string | null;
    }>(
      `INSERT INTO accounts (oidc_issuer, oidc_subject, username, display_name, email, last_sign_in_at)
       VALUES ($1, $2, $3, $4, $5, NOW())
       ON CONFLICT (oidc_issuer, oidc_subject) DO UPDATE SET
         username = EXCLUDED.username,
         display_name = EXCLUDED.display_name,
         email = EXCLUDED.email,
         last_sign_in_at = NOW(),
         updated_at = NOW()
       RETURNING id, status, token_version, locale`,
      [
        issuerUrl,
        idClaims.sub,
        idClaims.preferred_username,
        idClaims.name ?? idClaims.preferred_username,
        idClaims.email ?? null,
      ],
    );
    return result.rows[0];
  });

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
    return NextResponse.redirect(
      new URL("/deny?reason=account_inactive", request.url),
    );
  }

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
  const accessRows = await query<{ total: number }>(
    pool,
    `SELECT COUNT(*)::int AS total FROM (
       SELECT account_id FROM account_customer_memberships WHERE account_id = $1
       UNION ALL
       SELECT account_id FROM analyst_customer_assignments WHERE account_id = $1
     ) AS combined`,
    [account.id],
  );

  if (accessRows[0].total === 0) {
    await auditLog({
      actorId: account.id,
      authContext: "general",
      action: "auth.sign_in_denied",
      targetType: "account",
      targetId: account.id,
      details: { reason: "no_customer_access" },
      ipAddress: meta.ipAddress,
    });
    return NextResponse.redirect(
      new URL("/deny?reason=no_access", request.url),
    );
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

  // Sign JWT
  const { token, iat, exp } = await signJwt({
    sub: account.id,
    sid,
    ctx: "general",
    tv: account.token_version,
  });

  // Generate CSRF
  const csrfToken = generateCsrf({ ctx: "general", sid, iat });

  // Set cookies
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
