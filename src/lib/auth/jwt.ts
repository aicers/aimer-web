import { jwtVerify, SignJWT } from "jose";
import { getAuthPool, query } from "../db/client";
import type { AuthContext } from "./cookies";
import { getKeyPair } from "./jwt-keys";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface JwtClaims {
  sub: string; // account_id
  sid: string; // session UUID
  ctx: string; // auth_context: "general" | "admin"
  tv: number; // token_version
}

export interface VerifiedJwt extends JwtClaims {
  iat: number;
  exp: number;
}

// ---------------------------------------------------------------------------
// Issuer/audience mapping
// ---------------------------------------------------------------------------

const ISSUERS: Record<AuthContext, string> = {
  general: "aimer-web",
  admin: "aimer-web-admin",
};

export function issuerForContext(ctx: AuthContext): string {
  return ISSUERS[ctx];
}

function getExpirationSeconds(): number {
  const minutes = Number(process.env.JWT_EXPIRATION_MINUTES) || 15;
  return minutes * 60;
}

// ---------------------------------------------------------------------------
// Sign
// ---------------------------------------------------------------------------

export async function signJwt(
  claims: JwtClaims,
  ctx?: AuthContext,
): Promise<{
  token: string;
  iat: number;
  exp: number;
}> {
  const { privateKey, kid } = await getKeyPair();
  const expSeconds = getExpirationSeconds();
  const iat = Math.floor(Date.now() / 1000);
  const exp = iat + expSeconds;
  const iss = issuerForContext(ctx ?? (claims.ctx as AuthContext));

  const token = await new SignJWT({
    sid: claims.sid,
    ctx: claims.ctx,
    tv: claims.tv,
  })
    .setProtectedHeader({ alg: "ES256", kid })
    .setSubject(claims.sub)
    .setIssuer(iss)
    .setAudience(iss)
    .setIssuedAt(iat)
    .setExpirationTime(exp)
    .sign(privateKey);

  return { token, iat, exp };
}

// ---------------------------------------------------------------------------
// Verify (stateless — signature + exp + iss + aud)
// ---------------------------------------------------------------------------

export function extractClaims(payload: Record<string, unknown>): VerifiedJwt {
  const sub = payload.sub;
  const sid = payload.sid;
  const ctx = payload.ctx;
  const tv = payload.tv;
  const iat = payload.iat;
  const exp = payload.exp;

  if (
    typeof sub !== "string" ||
    typeof sid !== "string" ||
    typeof ctx !== "string" ||
    typeof tv !== "number" ||
    typeof iat !== "number" ||
    typeof exp !== "number"
  ) {
    throw new Error("JWT missing required claims");
  }

  return { sub, sid, ctx, tv, iat, exp };
}

async function verifyStateless(
  token: string,
  ctx?: AuthContext,
): Promise<VerifiedJwt> {
  const { publicKey } = await getKeyPair();

  // Try the specified context first, then fall back to trying both issuers.
  // This allows verifyJwtForLogout to work when the context is unknown.
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

// ---------------------------------------------------------------------------
// Verify full (stateless + DB lookup)
// ---------------------------------------------------------------------------

export async function verifyJwtFull(
  token: string,
  ctx?: AuthContext,
): Promise<VerifiedJwt> {
  const claims = await verifyStateless(token, ctx);

  const rows = await query<{
    revoked: boolean;
    needs_reauth: boolean;
    account_status: string;
    account_token_version: number;
  }>(
    getAuthPool(),
    `SELECT s.revoked, s.needs_reauth,
            a.status AS account_status,
            a.token_version AS account_token_version
     FROM sessions s
     JOIN accounts a ON a.id = s.account_id
     WHERE s.sid = $1`,
    [claims.sid],
  );

  if (rows.length === 0) {
    throw new Error("Session not found");
  }

  const row = rows[0];
  if (row.revoked) {
    throw new Error("Session revoked");
  }
  if (row.needs_reauth) {
    throw new Error("Session requires re-authentication");
  }
  if (row.account_status !== "active") {
    throw new Error(`Account status: ${row.account_status}`);
  }
  if (row.account_token_version !== claims.tv) {
    throw new Error("Token version mismatch");
  }

  return claims;
}

// ---------------------------------------------------------------------------
// Verify for logout (signature only, exp ignored)
// ---------------------------------------------------------------------------

export async function verifyJwtForLogout(
  token: string,
  ctx?: AuthContext,
): Promise<VerifiedJwt | null> {
  try {
    const { publicKey } = await getKeyPair();

    const contexts: AuthContext[] = ctx ? [ctx] : ["general", "admin"];
    let lastError: unknown;
    for (const c of contexts) {
      try {
        const iss = issuerForContext(c);
        const { payload } = await jwtVerify(token, publicKey, {
          issuer: iss,
          audience: iss,
          clockTolerance: Number.MAX_SAFE_INTEGER,
        });
        return extractClaims(payload as Record<string, unknown>);
      } catch (err) {
        lastError = err;
      }
    }
    throw lastError;
  } catch {
    return null;
  }
}
