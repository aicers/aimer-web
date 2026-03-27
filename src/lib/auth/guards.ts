import type { NextRequest } from "next/server";
import { getAuthPool } from "../db/client";
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
  validateSession,
} from "./session-validator";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface AuthenticatedRequest {
  accountId: string;
  sessionId: string;
  authContext: AuthContext;
  tokenVersion: number;
  iat: number;
  meta: RequestMeta;
  bridgeAiceId: string | null;
  bridgeCustomerIds: string[] | null;
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
  options?: { ctx?: AuthContext },
): (req: NextRequest) => Promise<Response> {
  const ctx = options?.ctx ?? "general";

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
    } catch (err) {
      if (err instanceof SessionExpiredError) {
        return Response.json(
          { error: `Session expired (${err.reason})` },
          { status: 401 },
        );
      }
      if (err instanceof SessionRevokedError) {
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

    const meta = extractRequestMeta(req);

    return handler(req, {
      accountId: claims.sub,
      sessionId: claims.sid,
      authContext: ctx,
      tokenVersion: claims.tv,
      iat: rotation.rotated && rotation.iat ? rotation.iat : claims.iat,
      meta,
      bridgeAiceId,
      bridgeCustomerIds,
    });
  };
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
  const expectedOrigin = req.nextUrl.origin;
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
      return handler(req, {
        sessionId: null,
        accountId: null,
        iat: null,
        meta,
      });
    }

    const claims = await verifyJwtForLogout(token, ctx);

    if (!claims) {
      // Signature failed — proceed with cookie deletion only
      return handler(req, {
        sessionId: null,
        accountId: null,
        iat: null,
        meta,
      });
    }

    const csrfErr = verifyCsrf(req, {
      ctx,
      sid: claims.sid,
      iat: claims.iat,
    });
    if (csrfErr) return csrfErr;

    return handler(req, {
      sessionId: claims.sid,
      accountId: claims.sub,
      iat: claims.iat,
      meta,
    });
  };
}
