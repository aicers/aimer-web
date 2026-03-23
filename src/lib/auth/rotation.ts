import type { AuthContext } from "./cookies";
import { generateCsrf } from "./csrf";
import { type JwtClaims, signJwt, type VerifiedJwt } from "./jwt";

export interface RotationResult {
  rotated: boolean;
  jwt?: string;
  csrfToken?: string;
  expiresAt?: number;
}

/**
 * Rotate the session JWT if the remaining lifetime is at most 1/3
 * of the total token lifetime.
 */
export async function maybeRotateSession(params: {
  claims: VerifiedJwt;
  ctx: AuthContext;
}): Promise<RotationResult> {
  const { claims, ctx } = params;
  const totalLifetime = claims.exp - claims.iat;
  const remaining = claims.exp - Math.floor(Date.now() / 1000);

  if (remaining > totalLifetime / 3) {
    return { rotated: false };
  }

  const newClaims: JwtClaims = {
    sub: claims.sub,
    sid: claims.sid,
    ctx: claims.ctx,
    tv: claims.tv,
  };

  const { token, iat, exp } = await signJwt(newClaims);
  const csrfToken = generateCsrf({ ctx, sid: claims.sid, iat });

  return { rotated: true, jwt: token, csrfToken, expiresAt: exp };
}
