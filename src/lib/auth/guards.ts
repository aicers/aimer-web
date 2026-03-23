import type { NextRequest } from "next/server";
import { getAuthPool, query } from "../db/client";
import type { AuthContext } from "./cookies";
import { getAuthCookie, setAuthCookies } from "./cookies";
import { validateCsrf } from "./csrf";
import { type VerifiedJwt, verifyJwtForLogout, verifyJwtFull } from "./jwt";
import type { RequestMeta } from "./request-meta";
import { extractRequestMeta } from "./request-meta";
import { maybeRotateSession } from "./rotation";
import { getSessionPolicy } from "./session-policy";

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
      claims = await verifyJwtFull(token);
    } catch {
      return Response.json({ error: "Unauthorized" }, { status: 401 });
    }

    // Session policy check
    const policy = await getSessionPolicy();
    const ctxPolicy = policy[ctx];
    const now = Math.floor(Date.now() / 1000);

    const session = await query<{
      created_at: Date;
      last_active_at: Date;
    }>(
      getAuthPool(),
      `SELECT created_at, last_active_at FROM sessions WHERE sid = $1`,
      [claims.sid],
    );

    if (session.length > 0) {
      const createdAt = Math.floor(session[0].created_at.getTime() / 1000);
      const lastActive = Math.floor(session[0].last_active_at.getTime() / 1000);
      const idleSeconds = ctxPolicy.idle_timeout_minutes * 60;
      const absoluteSeconds = ctxPolicy.absolute_timeout_minutes * 60;

      if (now - lastActive > idleSeconds) {
        return Response.json(
          { error: "Session expired (idle)" },
          { status: 401 },
        );
      }
      if (now - createdAt > absoluteSeconds) {
        return Response.json(
          { error: "Session expired (absolute)" },
          { status: 401 },
        );
      }
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

    // Update last_active_at
    await query(
      getAuthPool(),
      `UPDATE sessions SET last_active_at = NOW() WHERE sid = $1`,
      [claims.sid],
    );

    const meta = extractRequestMeta(req);

    return handler(req, {
      accountId: claims.sub,
      sessionId: claims.sid,
      authContext: ctx,
      tokenVersion: claims.tv,
      iat: rotation.rotated && rotation.iat ? rotation.iat : claims.iat,
      meta,
    });
  };
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

    // Origin/Referer verification (mandatory for mutations).
    // Blocks cross-site POSTs regardless of token presence.
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

    const token = req.cookies.get(cookieName)?.value;

    if (!token) {
      return handler(req, {
        sessionId: null,
        accountId: null,
        iat: null,
        meta,
      });
    }

    const claims = await verifyJwtForLogout(token);

    if (!claims) {
      // Signature failed — proceed with cookie deletion only
      return handler(req, {
        sessionId: null,
        accountId: null,
        iat: null,
        meta,
      });
    }

    // CSRF verification (required when claims are valid)
    const csrfHeader =
      ctx === "general"
        ? req.headers.get("x-csrf-token")
        : req.headers.get("x-csrf-token-admin");

    if (!csrfHeader) {
      return Response.json({ error: "CSRF token required" }, { status: 403 });
    }

    const valid = validateCsrf({
      token: csrfHeader,
      ctx,
      sid: claims.sid,
      iat: claims.iat,
    });
    if (!valid) {
      return Response.json(
        { error: "CSRF validation failed" },
        { status: 403 },
      );
    }

    return handler(req, {
      sessionId: claims.sid,
      accountId: claims.sub,
      iat: claims.iat,
      meta,
    });
  };
}
