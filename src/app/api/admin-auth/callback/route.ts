import { type NextRequest, NextResponse } from "next/server";
import { auditLog } from "@/lib/audit";
import { withCorrelationId } from "@/lib/audit/correlation";
import { upsertAccount } from "@/lib/auth/account";
import { verifyAdminClaims } from "@/lib/auth/admin-verify";
import { canonicalOrigin } from "@/lib/auth/canonical-origin";
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
import { emitSevereAlert } from "@/lib/detection";

function denyRedirect(request: NextRequest, reason: string): NextResponse {
  return NextResponse.redirect(
    new URL(`/deny?reason=${reason}`, canonicalOrigin(request)),
  );
}

export async function GET(request: NextRequest): Promise<NextResponse> {
  return withCorrelationId(async () => {
    const { searchParams } = request.nextUrl;
    const code = searchParams.get("code");
    const state = searchParams.get("state");
    const error = searchParams.get("error");

    if (error) {
      const desc = searchParams.get("error_description") ?? error;
      return NextResponse.redirect(
        new URL(
          `/deny?reason=oidc_error&detail=${encodeURIComponent(desc)}`,
          canonicalOrigin(request),
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

    const origin = canonicalOrigin(request);
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
      const denyDetails = {
        reason:
          account.status === "suspended"
            ? "status_suspended"
            : "status_disabled",
        status: account.status,
      };
      void auditLog({
        actorId: account.id,
        authContext: "admin",
        action: "admin.auth.sign_in_denied",
        targetType: "account",
        targetId: account.id,
        details: denyDetails,
        ipAddress: meta.ipAddress,
      });
      void emitSevereAlert({
        indicator: "suspended_account_sign_in",
        actorId: account.id,
        ipAddress: meta.ipAddress,
        summary: {
          authContext: "admin",
          ...denyDetails,
        },
      });
      return denyRedirect(request, "account_inactive");
    }

    // Admin-specific verification (acr, auth_time, role, admin_eligible)
    const denyReason = verifyAdminClaims(idClaims, account.admin_eligible);
    if (denyReason) {
      void auditLog({
        actorId: account.id,
        authContext: "admin",
        action: "admin.auth.sign_in_denied",
        targetType: "account",
        targetId: account.id,
        details: { reason: denyReason, acr: idClaims.acr },
        ipAddress: meta.ipAddress,
      });

      // acr/auth_time denials indicate admin auth probing
      if (denyReason === "acr_invalid" || denyReason === "auth_time_too_old") {
        void emitSevereAlert({
          indicator: "admin_auth_denial_pattern",
          actorId: account.id,
          ipAddress: meta.ipAddress,
          summary: { reason: denyReason, acr: idClaims.acr },
        });
      }

      return denyRedirect(request, denyReason);
    }

    // Same-account enforcement: only after all deny checks pass
    await enforceSameAccount(request, account.id, "admin", meta);

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

    void auditLog({
      actorId: account.id,
      authContext: "admin",
      action: "admin.auth.sign_in_success",
      targetType: "session",
      targetId: sid,
      ipAddress: meta.ipAddress,
      sid,
    });

    return NextResponse.redirect(new URL("/admin", canonicalOrigin(request)));
  });
}
