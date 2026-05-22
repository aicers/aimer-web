import type { NextRequest } from "next/server";
import { auditLog } from "../audit";
import type { AuditAction } from "../audit/actions";
import { withCorrelationId } from "../audit/correlation";
import { getAuthPool } from "../db/client";
import { canonicalOrigin } from "./canonical-origin";
import type { AuthContext } from "./cookies";
import { getAuthCookie, setAuthCookies } from "./cookies";
import { validateCsrf } from "./csrf";
import { type VerifiedJwt, verifyJwtForLogout, verifyJwtFull } from "./jwt";
import type { RequestMeta } from "./request-meta";
import { extractRequestMeta } from "./request-meta";
import { maybeRotateSession } from "./rotation";
import { getSessionPolicy } from "./session-policy";
import {
  SessionExpiredError,
  SessionRevokedError,
  updateSessionMeta,
  validateSession,
} from "./session-validator";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Declarative audit config for guard-level emission. */
export interface AuditOption {
  action: AuditAction;
  targetType: string;
}

/** Mutable metadata that handlers populate for guard-level audit. */
export interface AuditMeta {
  targetId?: string;
  details?: Record<string, unknown>;
  customerId?: string;
  aiceId?: string;
}

export interface AuthenticatedRequest {
  accountId: string;
  sessionId: string;
  authContext: AuthContext;
  tokenVersion: number;
  iat: number;
  meta: RequestMeta;
  bridgeAiceId: string | null;
  bridgeCustomerIds: string[] | null;
  /** Mutable audit metadata — set fields before returning a 2xx response. */
  audit: AuditMeta;
}

export interface LogoutAuthRequest {
  sessionId: string | null;
  accountId: string | null;
  iat: number | null;
  meta: RequestMeta;
}

// ---------------------------------------------------------------------------
// withAuth — full verification + session policy + rotation
// ---------------------------------------------------------------------------

export function withAuth(
  handler: (req: NextRequest, auth: AuthenticatedRequest) => Promise<Response>,
  options?: { ctx?: AuthContext; audit?: AuditOption },
): (req: NextRequest) => Promise<Response> {
  const ctx = options?.ctx ?? "general";
  const auditOption = options?.audit;

  return async (req: NextRequest) => {
    const token = await getAuthCookie(ctx);
    if (!token) {
      return Response.json({ error: "Unauthorized" }, { status: 401 });
    }

    let claims: VerifiedJwt;
    try {
      claims = await verifyJwtFull(token, ctx);
    } catch {
      return Response.json({ error: "Unauthorized" }, { status: 401 });
    }

    const meta = extractRequestMeta(req);

    return withCorrelationId(async () => {
      // Session policy check
      const policy = await getSessionPolicy();
      const ctxPolicy = policy[ctx];

      let bridgeAiceId: string | null = null;
      let bridgeCustomerIds: string[] | null = null;
      try {
        const session = await validateSession(
          getAuthPool(),
          claims.sid,
          ctxPolicy,
        );
        bridgeAiceId = session.bridgeAiceId;
        bridgeCustomerIds = session.bridgeCustomerIds;

        // IP/UA mismatch detection — emit once, then update session baseline
        // so subsequent requests with the same new IP/UA don't re-trigger.
        const ipChanged =
          meta.ipAddress && meta.ipAddress !== session.ipAddress;
        const uaChanged =
          meta.userAgent && meta.userAgent !== session.userAgent;

        if (ipChanged) {
          void auditLog({
            actorId: claims.sub,
            authContext: ctx,
            action: "session.ip_mismatch",
            targetType: "session",
            targetId: claims.sid,
            details: {
              previous: session.ipAddress,
              current: meta.ipAddress,
            },
            ipAddress: meta.ipAddress,
            sid: claims.sid,
          });
        }
        if (uaChanged) {
          void auditLog({
            actorId: claims.sub,
            authContext: ctx,
            action: "session.ua_mismatch",
            targetType: "session",
            targetId: claims.sid,
            details: {
              previous: session.userAgent,
              current: meta.userAgent,
            },
            ipAddress: meta.ipAddress,
            sid: claims.sid,
          });
        }
        if (ipChanged || uaChanged) {
          void updateSessionMeta(
            getAuthPool(),
            claims.sid,
            ipChanged ? meta.ipAddress : undefined,
            uaChanged ? meta.userAgent : undefined,
          );
        }
      } catch (err) {
        if (err instanceof SessionExpiredError) {
          const action =
            err.reason === "idle"
              ? "session.idle_timeout"
              : "session.absolute_timeout";
          auditLog({
            actorId: claims.sub,
            authContext: ctx,
            action,
            targetType: "session",
            targetId: claims.sid,
            ipAddress: meta.ipAddress,
            sid: claims.sid,
          });
          return Response.json(
            { error: `Session expired (${err.reason})` },
            { status: 401 },
          );
        }
        if (err instanceof SessionRevokedError) {
          auditLog({
            actorId: claims.sub,
            authContext: ctx,
            action: "session.revoked",
            targetType: "session",
            targetId: claims.sid,
            ipAddress: meta.ipAddress,
            sid: claims.sid,
          });
          return Response.json({ error: "Session revoked" }, { status: 401 });
        }
        return Response.json({ error: "Unauthorized" }, { status: 401 });
      }

      // Rotation
      const rotation = await maybeRotateSession({ claims, ctx });
      if (rotation.rotated && rotation.jwt && rotation.csrfToken) {
        const expiresAt = rotation.expiresAt ?? claims.exp;
        await setAuthCookies(ctx, {
          jwt: rotation.jwt,
          csrfToken: rotation.csrfToken,
          expiresAt,
        });
      }

      const auditMeta: AuditMeta = {};
      const response = await handler(req, {
        accountId: claims.sub,
        sessionId: claims.sid,
        authContext: ctx,
        tokenVersion: claims.tv,
        iat: rotation.rotated && rotation.iat ? rotation.iat : claims.iat,
        meta,
        bridgeAiceId,
        bridgeCustomerIds,
        audit: auditMeta,
      });

      if (auditOption && response.ok) {
        void auditLog({
          actorId: claims.sub,
          authContext: ctx,
          action: auditOption.action,
          targetType: auditOption.targetType,
          targetId: auditMeta.targetId,
          details: auditMeta.details,
          ipAddress: meta.ipAddress,
          sid: claims.sid,
          customerId: auditMeta.customerId,
          aiceId: auditMeta.aiceId,
        });
      }

      return response;
    });
  };
}

// ---------------------------------------------------------------------------
// Best-effort session probe — used by routes that accept cross-site
// entry (e.g. /api/analysis/analyze-bridge). Unlike `withAuth`, the
// caller must NOT 401 on a missing cookie — that is the typical state
// for cross-site top-level POSTs from aice-web-next, where SameSite=Strict
// keeps the general-session cookies from travelling. A returned `null`
// means "no live session — take the cross-site bridge path"; a returned
// object means "session present, callers may run the short-circuit".
// ---------------------------------------------------------------------------

export interface OptionalGeneralSession {
  accountId: string;
  sessionId: string;
  iat: number;
  tokenVersion: number;
  bridgeAiceId: string | null;
  bridgeCustomerIds: string[] | null;
}

export async function tryLoadGeneralSession(): Promise<OptionalGeneralSession | null> {
  const token = await getAuthCookie("general");
  if (!token) return null;

  let claims: VerifiedJwt;
  try {
    claims = await verifyJwtFull(token, "general");
  } catch {
    return null;
  }

  const policy = await getSessionPolicy();
  try {
    const session = await validateSession(
      getAuthPool(),
      claims.sid,
      policy.general,
    );
    return {
      accountId: claims.sub,
      sessionId: claims.sid,
      iat: claims.iat,
      tokenVersion: claims.tv,
      bridgeAiceId: session.bridgeAiceId,
      bridgeCustomerIds: session.bridgeCustomerIds,
    };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Shared mutation guards (origin + CSRF)
// ---------------------------------------------------------------------------

/**
 * Verify that the request Origin header matches the expected origin.
 * Returns a 403 Response on mismatch, or null if the origin is valid.
 */
export function verifyOrigin(req: NextRequest): Response | null {
  const origin = req.headers.get("origin");
  const expectedOrigin = canonicalOrigin(req);
  let originMatch = false;
  if (origin) {
    try {
      originMatch = new URL(origin).origin === expectedOrigin;
    } catch {
      // Malformed Origin header
    }
  }
  if (!originMatch) {
    return Response.json({ error: "Origin mismatch" }, { status: 403 });
  }
  return null;
}

/**
 * Verify the CSRF token from the request header.
 * Returns a 403 Response on failure, or null if valid.
 */
export function verifyCsrf(
  req: NextRequest,
  params: { ctx: AuthContext; sid: string; iat: number },
): Response | null {
  const csrfHeader =
    params.ctx === "general"
      ? req.headers.get("x-csrf-token")
      : req.headers.get("x-csrf-token-admin");

  if (!csrfHeader) {
    return Response.json({ error: "CSRF token required" }, { status: 403 });
  }

  const valid = validateCsrf({
    token: csrfHeader,
    ctx: params.ctx,
    sid: params.sid,
    iat: params.iat,
  });
  if (!valid) {
    return Response.json({ error: "CSRF validation failed" }, { status: 403 });
  }
  return null;
}

// ---------------------------------------------------------------------------
// withLogoutAuth — verify signature only (exp ignored), CSRF check
// ---------------------------------------------------------------------------

export function withLogoutAuth(
  handler: (req: NextRequest, auth: LogoutAuthRequest) => Promise<Response>,
  options?: { cookieName?: string },
): (req: NextRequest) => Promise<Response> {
  const cookieName = options?.cookieName ?? "at";
  const ctx: AuthContext = cookieName === "at_admin" ? "admin" : "general";

  return async (req: NextRequest) => {
    const meta = extractRequestMeta(req);

    const originErr = verifyOrigin(req);
    if (originErr) return originErr;

    const token = req.cookies.get(cookieName)?.value;

    if (!token) {
      return withCorrelationId(() =>
        handler(req, {
          sessionId: null,
          accountId: null,
          iat: null,
          meta,
        }),
      );
    }

    const claims = await verifyJwtForLogout(token, ctx);

    if (!claims) {
      // Signature failed — proceed with cookie deletion only
      return withCorrelationId(() =>
        handler(req, {
          sessionId: null,
          accountId: null,
          iat: null,
          meta,
        }),
      );
    }

    const csrfErr = verifyCsrf(req, {
      ctx,
      sid: claims.sid,
      iat: claims.iat,
    });
    if (csrfErr) return csrfErr;

    return withCorrelationId(() =>
      handler(req, {
        sessionId: claims.sid,
        accountId: claims.sub,
        iat: claims.iat,
        meta,
      }),
    );
  };
}
