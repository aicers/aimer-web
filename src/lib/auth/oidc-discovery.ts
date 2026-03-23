export interface OidcDiscovery {
  issuer: string;
  authorization_endpoint: string;
  token_endpoint: string;
  userinfo_endpoint: string;
  end_session_endpoint: string;
  jwks_uri: string;
}

let cached: { doc: OidcDiscovery; expiresAt: number } | null = null;
const TTL_MS = 60 * 60 * 1000; // 1 hour

export async function getOidcDiscovery(
  issuerUrl: string,
): Promise<OidcDiscovery> {
  if (cached && Date.now() < cached.expiresAt) {
    return cached.doc;
  }

  const url = `${issuerUrl}/.well-known/openid-configuration`;
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(
      `OIDC discovery failed: ${res.status} ${res.statusText} (${url})`,
    );
  }

  const doc = (await res.json()) as OidcDiscovery;
  cached = { doc, expiresAt: Date.now() + TTL_MS };
  return doc;
}

/** Clear the cached discovery document (useful for tests). */
export function clearDiscoveryCache(): void {
  cached = null;
}
