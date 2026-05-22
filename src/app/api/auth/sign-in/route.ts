import { type NextRequest, NextResponse } from "next/server";
import { canonicalOrigin } from "@/lib/auth/canonical-origin";
import {
  clearConnectionIdCookie,
  clearInvitationTokenCookie,
  clearOidcTempCookies,
  setOidcTempCookies,
} from "@/lib/auth/cookies";
import {
  buildAuthorizationUrl,
  generateCodeChallenge,
  generateCodeVerifier,
  generateNonce,
  generateState,
  getIssuerUrl,
} from "@/lib/auth/oidc";
import { getOidcDiscovery } from "@/lib/auth/oidc-discovery";

export async function GET(request: NextRequest): Promise<NextResponse> {
  const issuerUrl = getIssuerUrl();
  const discovery = await getOidcDiscovery(issuerUrl);

  const state = generateState();
  const nonce = generateNonce();
  const codeVerifier = generateCodeVerifier();
  const codeChallenge = generateCodeChallenge(codeVerifier);

  // Clean up stale temporary cookies from previous incomplete flows.
  // Preserve the active flow's cookie — only clear the OTHER flow's cookie.
  await clearOidcTempCookies("general");
  const flow = request.nextUrl.searchParams.get("flow");
  if (flow !== "bridge") await clearConnectionIdCookie();
  if (flow !== "invite") await clearInvitationTokenCookie();

  // Store OIDC parameters in cookies for callback verification
  await setOidcTempCookies("general", { state, nonce, codeVerifier });

  const clientId = process.env.OIDC_GENERAL_CLIENT_ID ?? "aimer-web";
  const origin = canonicalOrigin(request);
  const redirectUri = `${origin}/api/auth/callback`;

  const url = buildAuthorizationUrl({
    discovery,
    clientId,
    redirectUri,
    state,
    nonce,
    codeChallenge,
  });

  return NextResponse.redirect(url);
}
