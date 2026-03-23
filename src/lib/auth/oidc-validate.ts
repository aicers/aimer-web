import { createRemoteJWKSet, type JWTPayload, jwtVerify } from "jose";

export interface IdTokenClaims extends JWTPayload {
  sub: string;
  preferred_username: string;
  name: string;
  email?: string;
  email_verified?: boolean;
  acr?: string;
  auth_time?: number;
  realm_access?: { roles: string[] };
}

const jwksCache = new Map<string, ReturnType<typeof createRemoteJWKSet>>();

function getJwks(jwksUri: string): ReturnType<typeof createRemoteJWKSet> {
  let jwks = jwksCache.get(jwksUri);
  if (!jwks) {
    jwks = createRemoteJWKSet(new URL(jwksUri));
    jwksCache.set(jwksUri, jwks);
  }
  return jwks;
}

export async function validateIdToken(params: {
  idToken: string;
  jwksUri: string;
  issuer: string;
  clientId: string;
  nonce: string;
}): Promise<IdTokenClaims> {
  const jwks = getJwks(params.jwksUri);
  const { payload } = await jwtVerify(params.idToken, jwks, {
    issuer: params.issuer,
    audience: params.clientId,
  });

  if (payload.nonce !== params.nonce) {
    throw new Error("ID token nonce mismatch");
  }

  if (!payload.sub) {
    throw new Error("ID token missing sub claim");
  }

  return payload as IdTokenClaims;
}
