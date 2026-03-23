import { jwtVerify } from "jose";
import type { VerifiedJwt } from "./jwt";
import { getKeyPair } from "./jwt-keys";

const ISSUER = "aimer-web";
const AUDIENCE = "aimer-web";

/**
 * Stateless JWT verification for middleware — checks signature, expiry,
 * issuer, and audience only. No database lookup.
 */
export async function verifyJwtStateless(token: string): Promise<VerifiedJwt> {
  const { publicKey } = await getKeyPair();
  const { payload } = await jwtVerify(token, publicKey, {
    issuer: ISSUER,
    audience: AUDIENCE,
  });

  return {
    sub: payload.sub as string,
    sid: payload.sid as string,
    ctx: payload.ctx as string,
    tv: payload.tv as number,
    iat: payload.iat as number,
    exp: payload.exp as number,
  };
}
