import { type NextRequest, NextResponse } from "next/server";
import { setNextLocaleCookie } from "@/i18n/locale-cookie";
import { auditLog } from "@/lib/audit";
import { withCorrelationId } from "@/lib/audit/correlation";
import { countAccessibleCustomers, upsertAccount } from "@/lib/auth/account";
import {
  acceptAnalystInvitation,
  analystReasonToDenyKey,
  diagnoseTerminalInvitation,
  resolveInvitationType,
} from "@/lib/auth/analyst-invitations";
import { processBridgeCallback } from "@/lib/auth/bridge";
import { canonicalOrigin } from "@/lib/auth/canonical-origin";
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
import { reconcileSignInLocale } from "@/lib/auth/locale-sync";
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

    const origin = canonicalOrigin(request);
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

    // Account upsert — key on the validated id_token.iss claim (the
    // authoritative OIDC issuer), not the config-derived KEYCLOAK_URL.
    const account = await withTransaction(pool, (client) =>
      upsertAccount(client, idClaims.iss, idClaims),
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

    // Locale sync (#387): reconcile saved `accounts.locale` with any
    // pre-existing NEXT_LOCALE cookie. A saved preference wins and is
    // mirrored to the cookie; a NULL DB locale with a valid cookie
    // promotes the cookie to the account. The cookie then drives locale
    // resolution in the next-intl middleware (no per-request DB lookup).
    const cookieLocale = request.cookies.get("NEXT_LOCALE")?.value;
    const resolvedLocale = await reconcileSignInLocale(
      pool,
      account.id,
      account.locale,
      cookieLocale,
    );
    if (resolvedLocale) {
      await setNextLocaleCookie(resolvedLocale);
    }

    // Invitation processing (#77, #268): accept invitation if token cookie
    // exists. Resolve the invitation TYPE before consuming so analyst tokens
    // are not mis-classified as expired member invitations.
    const invitationToken = request.cookies.get("invitation_token")?.value;
    if (invitationToken) {
      const invitationType = await resolveInvitationType(pool, invitationToken);

      if (invitationType === "member") {
        // Existing member path — unchanged (#77).
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
      } else if (invitationType === "analyst") {
        // Analyst path (#268). The invitation_token cookie is cleared on
        // EVERY exit (accept / retryable / non-retryable) to match member
        // behavior and avoid stale-token races. "Retryable" means the DB row
        // stays pending, NOT that the cookie is reused — a retry re-clicks the
        // email link, which re-sets the cookie via the invite entry endpoint.
        // Do not add a "keep cookie on retryable" optimization here.
        const result = await acceptAnalystInvitation(pool, {
          token: invitationToken,
          accountId: account.id,
          email: idClaims.email,
          emailVerified: idClaims.email_verified,
        });

        await clearInvitationTokenCookie();

        if (result.outcome === "accepted") {
          void auditLog({
            actorId: account.id,
            authContext: "general",
            action: "invitation.accepted",
            targetType: "analyst_invitation",
            targetId: result.invitationId,
            details: { customerIds: result.customerIds },
            ipAddress: meta.ipAddress,
          });
          // Fall through to the standard sign-in qualification check.
        } else {
          // Retryable and non-retryable failures both audit as
          // invitation.failed (the analyst path deliberately does not use
          // invitation.expired) and deny via the reused member-side keys.
          void auditLog({
            actorId: account.id,
            authContext: "general",
            action: "invitation.failed",
            targetType: "analyst_invitation",
            targetId: result.invitationId,
            details: { reason: result.reason },
            ipAddress: meta.ipAddress,
          });
          return denyRedirect(request, analystReasonToDenyKey(result.reason));
        }
      } else {
        // not_found: the primary resolver matched no pending + unexpired row
        // in either table. Run the diagnostic to classify the terminal state
        // and branch on the SOURCE TABLE so the member path stays unchanged.
        const diagnostic = await diagnoseTerminalInvitation(
          pool,
          invitationToken,
        );
        await clearInvitationTokenCookie();

        if (diagnostic.source === "invitation") {
          // Member-terminal carve-out — preserve the legacy member audit and
          // action verbatim (a terminal member token historically routed
          // through acceptInvitation and collapsed to invitation_expired).
          void auditLog({
            actorId: account.id,
            authContext: "general",
            action: "invitation.expired",
            targetType: "invitation",
            details: { reason: "invitation_expired" },
            ipAddress: meta.ipAddress,
          });
          return denyRedirect(request, "invitation_expired");
        }

        if (diagnostic.source === "analyst_invitation") {
          void auditLog({
            actorId: account.id,
            authContext: "general",
            action: "invitation.failed",
            targetType: "analyst_invitation",
            targetId: diagnostic.id,
            details: { reason: diagnostic.reason },
            ipAddress: meta.ipAddress,
          });
          return denyRedirect(
            request,
            analystReasonToDenyKey(diagnostic.reason),
          );
        }

        // No row in either table. The original token type is unknowable, so
        // this analyst-scoped path defaults target_type to analyst_invitation
        // and omits targetId (no row exists to reference).
        void auditLog({
          actorId: account.id,
          authContext: "general",
          action: "invitation.failed",
          targetType: "analyst_invitation",
          details: { reason: "not_found" },
          ipAddress: meta.ipAddress,
        });
        return denyRedirect(request, "invitation_expired");
      }
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

        // Forensic metadata is restricted to audit (System Admin only).
        // Never include these keys in the HTTP response, deny page, or
        // any user-facing log.
        const auditDetails: Record<string, unknown> = {
          reason: bridgeResult.deny,
          connectionId,
        };
        if (bridgeResult.requestedCustomerExternalKeys !== undefined) {
          auditDetails.requestedCustomerExternalKeys =
            bridgeResult.requestedCustomerExternalKeys;
        }
        if (bridgeResult.matchedCustomerExternalKeys !== undefined) {
          auditDetails.matchedCustomerExternalKeys =
            bridgeResult.matchedCustomerExternalKeys;
        }

        void auditLog({
          actorId: account.id,
          authContext: "general",
          action: "bridge.connection_denied",
          targetType: "bridge",
          details: auditDetails,
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
          analyzeRequestId: bridgeResult.analyzeRequestId,
        },
        ipAddress: meta.ipAddress,
        sid: bridgeSid,
        aiceId: bridgeResult.bridgeAiceId ?? undefined,
      });

      if (bridgeResult.analyzeRequestId) {
        return NextResponse.redirect(
          new URL(
            `/api/analysis/analyze-bridge/continue?id=${bridgeResult.analyzeRequestId}`,
            canonicalOrigin(request),
          ),
        );
      }
      return NextResponse.redirect(new URL("/", canonicalOrigin(request)));
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

    return NextResponse.redirect(new URL("/", canonicalOrigin(request)));
  });
}
