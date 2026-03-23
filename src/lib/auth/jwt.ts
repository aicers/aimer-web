import { jwtVerify, SignJWT } from "jose";
import { getAuthPool, query } from "../db/client";
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

const ISSUER = "aimer-web";
const AUDIENCE = "aimer-web";

function getExpirationSeconds(): number {
  const minutes = Number(process.env.JWT_EXPIRATION_MINUTES) || 15;
  return minutes * 60;
}

// ---------------------------------------------------------------------------
// Sign
// ---------------------------------------------------------------------------

export async function signJwt(claims: JwtClaims): Promise<{
  token: string;
  iat: number;
  exp: number;
}> {
  const { privateKey, kid } = await getKeyPair();
  const expSeconds = getExpirationSeconds();
  const iat = Math.floor(Date.now() / 1000);
  const exp = iat + expSeconds;

  const token = await new SignJWT({
    sid: claims.sid,
    ctx: claims.ctx,
    tv: claims.tv,
  })
    .setProtectedHeader({ alg: "ES256", kid })
    .setSubject(claims.sub)
    .setIssuer(ISSUER)
    .setAudience(AUDIENCE)
    .setIssuedAt(iat)
    .setExpirationTime(exp)
    .sign(privateKey);

  return { token, iat, exp };
}

// ---------------------------------------------------------------------------
// Verify (stateless — signature + exp + iss + aud)
// ---------------------------------------------------------------------------

async function verifyStateless(token: string): Promise<VerifiedJwt> {
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

// ---------------------------------------------------------------------------
// Verify full (stateless + DB lookup)
// ---------------------------------------------------------------------------

export async function verifyJwtFull(token: string): Promise<VerifiedJwt> {
  const claims = await verifyStateless(token);

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
): Promise<VerifiedJwt | null> {
  try {
    const { publicKey } = await getKeyPair();
    const { payload } = await jwtVerify(token, publicKey, {
      issuer: ISSUER,
      audience: AUDIENCE,
      clockTolerance: Number.MAX_SAFE_INTEGER,
    });

    return {
      sub: payload.sub as string,
      sid: payload.sid as string,
      ctx: payload.ctx as string,
      tv: payload.tv as number,
      iat: payload.iat as number,
      exp: payload.exp as number,
    };
  } catch {
    // Signature verification failed — return null so caller can
    // proceed with cookie deletion only
    return null;
  }
}
