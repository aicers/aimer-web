import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { OidcDiscovery } from "./oidc-discovery";

// ---------------------------------------------------------------------------
// Environment helpers
// ---------------------------------------------------------------------------

export function getIssuerUrl(): string {
  const base = process.env.KEYCLOAK_URL;
  const realm = process.env.KEYCLOAK_REALM;
  if (!base || !realm) {
    throw new Error("KEYCLOAK_URL and KEYCLOAK_REALM must be set");
  }
  return `${base}/realms/${realm}`;
}

// ---------------------------------------------------------------------------
// PKCE helpers
// ---------------------------------------------------------------------------

export function generateCodeVerifier(): string {
  return randomBytes(32).toString("base64url");
}

export function generateCodeChallenge(verifier: string): string {
  return createHash("sha256").update(verifier).digest("base64url");
}

// ---------------------------------------------------------------------------
// State & nonce
// ---------------------------------------------------------------------------

export function generateState(): string {
  return randomUUID();
}

export function generateNonce(): string {
  return randomUUID();
}

// ---------------------------------------------------------------------------
// Authorization URL
// ---------------------------------------------------------------------------

export interface AuthorizationUrlParams {
  discovery: OidcDiscovery;
  clientId: string;
  redirectUri: string;
  state: string;
  nonce: string;
  codeChallenge: string;
  prompt?: "login" | "consent";
  maxAge?: number;
  locale?: string;
}

export function buildAuthorizationUrl(params: AuthorizationUrlParams): string {
  const url = new URL(params.discovery.authorization_endpoint);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", params.clientId);
  url.searchParams.set("redirect_uri", params.redirectUri);
  url.searchParams.set("scope", "openid profile email");
  url.searchParams.set("state", params.state);
  url.searchParams.set("nonce", params.nonce);
  url.searchParams.set("code_challenge", params.codeChallenge);
  url.searchParams.set("code_challenge_method", "S256");
  if (params.prompt) {
    url.searchParams.set("prompt", params.prompt);
  }
  if (params.maxAge !== undefined) {
    url.searchParams.set("max_age", String(params.maxAge));
  }
  if (params.locale) {
    url.searchParams.set("ui_locales", params.locale);
  }
  return url.toString();
}

// ---------------------------------------------------------------------------
// Token exchange
// ---------------------------------------------------------------------------

export interface TokenResponse {
  id_token: string;
  access_token: string;
  refresh_token?: string;
}

export async function exchangeCodeForTokens(params: {
  discovery: OidcDiscovery;
  clientId: string;
  clientSecret: string;
  code: string;
  redirectUri: string;
  codeVerifier: string;
}): Promise<TokenResponse> {
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code: params.code,
    redirect_uri: params.redirectUri,
    client_id: params.clientId,
    client_secret: params.clientSecret,
    code_verifier: params.codeVerifier,
  });

  const res = await fetch(params.discovery.token_endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Token exchange failed: ${res.status} ${text}`);
  }

  return (await res.json()) as TokenResponse;
}
