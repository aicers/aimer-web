import { jwtVerify } from "jose";
import type { AuthContext } from "./cookies";
import { extractClaims, issuerForContext, type VerifiedJwt } from "./jwt";
import { getKeyPair } from "./jwt-keys";

/**
 * Stateless JWT verification for middleware — checks signature, expiry,
 * issuer, and audience only. No database lookup.
 */
export async function verifyJwtStateless(
  token: string,
  ctx?: AuthContext,
): Promise<VerifiedJwt> {
  const { publicKey } = await getKeyPair();

  const contexts: AuthContext[] = ctx ? [ctx] : ["general", "admin"];
  let lastError: unknown;
  for (const c of contexts) {
    try {
      const iss = issuerForContext(c);
      const { payload } = await jwtVerify(token, publicKey, {
        issuer: iss,
        audience: iss,
      });
      return extractClaims(payload as Record<string, unknown>);
    } catch (err) {
      lastError = err;
    }
  }
  throw lastError;
}
