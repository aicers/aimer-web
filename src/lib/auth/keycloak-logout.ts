import { getIssuerUrl } from "./oidc";
import { getOidcDiscovery } from "./oidc-discovery";

/**
 * Build the Keycloak end_session_endpoint URL for IdP logout.
 * Uses client_id param since we don't store id_token_hint.
 */
export async function buildKeycloakLogoutUrl(
  origin: string,
  clientId?: string,
): Promise<string> {
  const issuerUrl = getIssuerUrl();
  const discovery = await getOidcDiscovery(issuerUrl);
  const cid = clientId ?? process.env.OIDC_GENERAL_CLIENT_ID ?? "aimer-web";

  const url = new URL(discovery.end_session_endpoint);
  url.searchParams.set("client_id", cid);
  url.searchParams.set("post_logout_redirect_uri", origin);
  return url.toString();
}
