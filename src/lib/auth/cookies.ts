import { cookies } from "next/headers";

export type AuthContext = "general" | "admin";

export function cookieNames(ctx: AuthContext) {
  return ctx === "general"
    ? { at: "at", csrf: "csrf", tokenExp: "token_exp" }
    : { at: "at_admin", csrf: "csrf_admin", tokenExp: "token_exp_admin" };
}

const isSecure = process.env.NODE_ENV === "production";

// ---------------------------------------------------------------------------
// Temporary OIDC cookies (SameSite=Lax for cross-site redirect)
// ---------------------------------------------------------------------------

const OIDC_TEMP_NAMES = {
  state: "oidc_state",
  nonce: "oidc_nonce",
  codeVerifier: "oidc_code_verifier",
} as const;

const OIDC_TEMP_MAX_AGE = 300; // 5 minutes

export async function setOidcTempCookies(params: {
  state: string;
  nonce: string;
  codeVerifier: string;
}): Promise<void> {
  const jar = await cookies();
  const opts = {
    httpOnly: true,
    secure: isSecure,
    sameSite: "lax" as const,
    path: "/",
    maxAge: OIDC_TEMP_MAX_AGE,
  };
  jar.set(OIDC_TEMP_NAMES.state, params.state, opts);
  jar.set(OIDC_TEMP_NAMES.nonce, params.nonce, opts);
  jar.set(OIDC_TEMP_NAMES.codeVerifier, params.codeVerifier, opts);
}

export async function getOidcTempCookies(): Promise<{
  state: string;
  nonce: string;
  codeVerifier: string;
} | null> {
  const jar = await cookies();
  const state = jar.get(OIDC_TEMP_NAMES.state)?.value;
  const nonce = jar.get(OIDC_TEMP_NAMES.nonce)?.value;
  const codeVerifier = jar.get(OIDC_TEMP_NAMES.codeVerifier)?.value;
  if (!state || !nonce || !codeVerifier) return null;
  return { state, nonce, codeVerifier };
}

export async function clearOidcTempCookies(): Promise<void> {
  const jar = await cookies();
  for (const name of Object.values(OIDC_TEMP_NAMES)) {
    jar.delete(name);
  }
}

// ---------------------------------------------------------------------------
// Cleanup for temporary flow cookies (prevent stale cookies)
// ---------------------------------------------------------------------------

export async function clearFlowCookies(): Promise<void> {
  const jar = await cookies();
  jar.delete("invitation_token");
  jar.delete("connection_id");
}

// ---------------------------------------------------------------------------
// Auth session cookies (SameSite=Strict)
// ---------------------------------------------------------------------------

export async function setAuthCookies(
  ctx: AuthContext,
  params: { jwt: string; csrfToken: string; expiresAt: number },
): Promise<void> {
  const names = cookieNames(ctx);
  const jar = await cookies();
  const strict = "strict" as const;
  const maxAge = params.expiresAt - Math.floor(Date.now() / 1000);

  // JWT — HttpOnly
  jar.set(names.at, params.jwt, {
    httpOnly: true,
    secure: isSecure,
    sameSite: strict,
    path: "/",
    maxAge,
  });

  // CSRF — NOT HttpOnly (client reads to send as X-CSRF-Token header)
  jar.set(names.csrf, params.csrfToken, {
    httpOnly: false,
    secure: isSecure,
    sameSite: strict,
    path: "/",
    maxAge,
  });

  // Token expiry — NOT HttpOnly (client reads for UI countdown)
  jar.set(names.tokenExp, String(params.expiresAt), {
    httpOnly: false,
    secure: isSecure,
    sameSite: strict,
    path: "/",
    maxAge,
  });
}

export async function getAuthCookie(ctx: AuthContext): Promise<string | null> {
  const jar = await cookies();
  return jar.get(cookieNames(ctx).at)?.value ?? null;
}

export async function clearAuthCookies(ctx: AuthContext): Promise<void> {
  const names = cookieNames(ctx);
  const jar = await cookies();
  jar.delete(names.at);
  jar.delete(names.csrf);
  jar.delete(names.tokenExp);
}

export async function clearAllAuthCookies(): Promise<void> {
  await clearAuthCookies("general");
  await clearAuthCookies("admin");
}
