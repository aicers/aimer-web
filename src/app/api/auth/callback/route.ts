import { type NextRequest, NextResponse } from "next/server";
import { auditLog } from "@/lib/audit";
import { withCorrelationId } from "@/lib/audit/correlation";
import { countAccessibleCustomers, upsertAccount } from "@/lib/auth/account";
import { processBridgeCallback } from "@/lib/auth/bridge";
import {
  clearAuthCookies,
  clearConnectionIdCookie,
  clearInvitationTokenCookie,
  clearOidcTempCookies,
  getOidcTempCookies,
  setAuthCookies,
} from "@/lib/auth/cookies";
import { generateCsrf } from "@/lib/auth/csrf";
import { acceptInvitation } from "@/lib/auth/invitations";
import { signJwt } from "@/lib/auth/jwt";
import { exchangeCodeForTokens, getIssuerUrl } from "@/lib/auth/oidc";
import { getOidcDiscovery } from "@/lib/auth/oidc-discovery";
import { validateIdToken } from "@/lib/auth/oidc-validate";
import { extractRequestMeta } from "@/lib/auth/request-meta";
import { enforceSameAccount } from "@/lib/auth/same-account";
import { getAuthPool, query, withTransaction } from "@/lib/db/client";
import { emitSevereAlert } from "@/lib/detection";

function denyRedirect(request: NextRequest, reason: string): NextResponse {
  return NextResponse.redirect(new URL(`/deny?reason=${reason}`, request.url));
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
      const denyDetails = {
        reason:
          account.status === "suspended"
            ? "status_suspended"
            : "status_disabled",
        status: account.status,
      };
      void auditLog({
        actorId: account.id,
        authContext: "general",
        action: "general.auth.sign_in_denied",
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
          authContext: "general",
          ...denyDetails,
        },
      });
      return denyRedirect(request, "account_inactive");
    }

    // Invitation processing (#77): accept invitation if token cookie exists
    const invitationToken = request.cookies.get("invitation_token")?.value;
    if (invitationToken) {
      const result = await acceptInvitation(pool, {
        token: invitationToken,
        accountId: account.id,
        email: idClaims.email,
        emailVerified: idClaims.email_verified,
      });

      if (result.deny) {
        // Clear cookie for non-retryable denials to avoid blocking
        // subsequent sign-in attempts with a stale token.
        await clearInvitationTokenCookie();
        void auditLog({
          actorId: account.id,
          authContext: "general",
          action:
            result.deny === "invitation_expired"
              ? "invitation.expired"
              : "invitation.failed",
          targetType: "invitation",
          details: { reason: result.deny },
          ipAddress: meta.ipAddress,
        });
        return denyRedirect(request, result.deny);
      }

      await clearInvitationTokenCookie();

      void auditLog({
        actorId: account.id,
        authContext: "general",
        action: "invitation.accepted",
        targetType: "invitation",
        targetId: result.invitationId,
        details: { customerId: result.customerId },
        ipAddress: meta.ipAddress,
      });
    }

    // Bridge flow (#33): check for connection_id cookie
    const connectionId = request.cookies.get("connection_id")?.value;
    if (connectionId) {
      // Same-account enforcement before consuming the connection so that
      // a DB failure here does not leave the connection permanently consumed.
      await enforceSameAccount(request, account.id, "general", meta);

      const bridgeResult = await processBridgeCallback(
        pool,
        connectionId,
        account.id,
        { ipAddress: meta.ipAddress, userAgent: meta.userAgent },
      );

      if (bridgeResult.deny) {
        // Intentional denial — safe to clear cookie now
        await clearConnectionIdCookie();
        await clearAuthCookies("general");
        void auditLog({
          actorId: account.id,
          authContext: "general",
          action: "bridge.connection_denied",
          targetType: "bridge",
          details: { reason: bridgeResult.deny, connectionId },
          ipAddress: meta.ipAddress,
          aiceId: bridgeResult.bridgeAiceId ?? undefined,
        });

        // Scope-related denials indicate probing attempts
        const scopeReasons = new Set([
          "bridge_customer_mismatch",
          "bridge_customer_inactive",
          "bridge_environment_inactive",
          "bridge_no_access",
        ]);
        if (scopeReasons.has(bridgeResult.deny)) {
          void emitSevereAlert({
            indicator: "bridge_scope_probing",
            actorId: account.id,
            ipAddress: meta.ipAddress,
            summary: {
              reason: bridgeResult.deny,
              connectionId,
              aiceId: bridgeResult.bridgeAiceId,
            },
          });
        }

        return denyRedirect(request, bridgeResult.deny);
      }

      // Session + staged events already created inside the transaction.
      // Only JWT signing + cookies remain (idempotent, safe outside tx).
      const bridgeSid = bridgeResult.sessionId as string;

      // Sign JWT + CSRF + cookies
      const { token, iat, exp } = await signJwt({
        sub: account.id,
        sid: bridgeSid,
        ctx: "general",
        tv: account.token_version,
      });
      const csrfToken = generateCsrf({ ctx: "general", sid: bridgeSid, iat });
      await setAuthCookies("general", {
        jwt: token,
        csrfToken,
        expiresAt: exp,
      });

      // Bridge flow fully succeeded — safe to clear the one-time cookie
      await clearConnectionIdCookie();

      void auditLog({
        actorId: account.id,
        authContext: "general",
        action: "bridge.connection_granted",
        targetType: "session",
        targetId: bridgeSid,
        details: {
          connectionId,
          customerIds: bridgeResult.bridgeCustomerIds,
        },
        ipAddress: meta.ipAddress,
        sid: bridgeSid,
        aiceId: bridgeResult.bridgeAiceId ?? undefined,
      });

      return NextResponse.redirect(new URL("/", request.url));
    }

    // Standard check: count accessible customers
    const total = await countAccessibleCustomers(pool, account.id);
    if (total === 0) {
      void auditLog({
        actorId: account.id,
        authContext: "general",
        action: "general.auth.sign_in_denied",
        targetType: "account",
        targetId: account.id,
        details: { reason: "membership_missing" },
        ipAddress: meta.ipAddress,
      });
      return denyRedirect(request, "no_access");
    }

    // Same-account enforcement: only after all deny checks pass
    await enforceSameAccount(request, account.id, "general", meta);

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

    void auditLog({
      actorId: account.id,
      authContext: "general",
      action: "general.auth.sign_in_success",
      targetType: "session",
      targetId: sid,
      ipAddress: meta.ipAddress,
      sid,
    });

    return NextResponse.redirect(new URL("/", request.url));
  });
}
