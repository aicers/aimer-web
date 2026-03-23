import { type NextRequest, NextResponse } from "next/server";
import {
  clearFlowCookies,
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

  await clearOidcTempCookies("admin");
  await clearFlowCookies();

  await setOidcTempCookies("admin", { state, nonce, codeVerifier });

  const clientId = process.env.OIDC_ADMIN_CLIENT_ID ?? "aimer-web-admin";
  const origin = request.nextUrl.origin;
  const redirectUri = `${origin}/api/admin-auth/callback`;

  const url = buildAuthorizationUrl({
    discovery,
    clientId,
    redirectUri,
    state,
    nonce,
    codeChallenge,
    prompt: "login",
    maxAge: 0,
  });

  return NextResponse.redirect(url);
}
