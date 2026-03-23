import { type NextRequest, NextResponse } from "next/server";
import createIntlMiddleware from "next-intl/middleware";
import { routing } from "./i18n/routing";
import { verifyJwtStateless } from "./lib/auth/jwt-verify-stateless";

const intlMiddleware = createIntlMiddleware(routing);

const PUBLIC_PATHS = ["/api/auth/", "/api/admin-auth/", "/deny"];

function isPublicPath(pathname: string): boolean {
  return PUBLIC_PATHS.some((p) => pathname.includes(p));
}

export default async function proxy(
  request: NextRequest,
): Promise<NextResponse> {
  const { pathname } = request.nextUrl;

  // Let public paths through without auth check
  if (isPublicPath(pathname)) {
    return intlMiddleware(request);
  }

  // Fail-closed in production when Keycloak is not configured.
  // In non-production (CI, local dev without IdP), skip auth.
  if (!process.env.KEYCLOAK_URL || !process.env.KEYCLOAK_REALM) {
    if (process.env.NODE_ENV === "production") {
      return new NextResponse("Auth provider not configured", { status: 503 });
    }
    return intlMiddleware(request);
  }

  // Admin pages require admin cookie; other pages require general cookie.
  // Admin page routes will live under /[locale]/admin/ (#43).
  const isAdminPath = /\/admin(\/|$)/.test(pathname);
  const cookieName = isAdminPath ? "at_admin" : "at";
  const signInUrl = isAdminPath
    ? "/api/admin-auth/sign-in"
    : "/api/auth/sign-in";

  const token = request.cookies.get(cookieName)?.value;
  if (!token) {
    return NextResponse.redirect(new URL(signInUrl, request.url));
  }

  try {
    await verifyJwtStateless(token);
    return intlMiddleware(request);
  } catch {
    return NextResponse.redirect(new URL(signInUrl, request.url));
  }
}

export const config = {
  matcher: "/((?!api|trpc|_next|_vercel|.*\\..*).*)",
};
