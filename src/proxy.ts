import { type NextRequest, NextResponse } from "next/server";
import createIntlMiddleware from "next-intl/middleware";
import { routing } from "./i18n/routing";
import { canonicalOrigin } from "./lib/auth/canonical-origin";
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

  // RFC 0004 (#503) — `/customers` → `/subjects` inbound-compatibility
  // alias. The analysis surface moved from `/[locale]/customers/[id]/...`
  // to `/[locale]/subjects/[id]/...`; a customer's subject id IS its
  // customer id (a `kind='customer'` subject sharing the PK), so this is a
  // pure path swap that preserves the RFC 0002 deep-link contract
  // (`/customers/{customer_id}/analysis/...`). Freshly generated links
  // already emit `/subjects/...` (see `src/lib/navigation/routes.ts`);
  // this only catches inbound legacy / aice-web-next deep links. The
  // matcher already excludes `/api`, so the API has no alias (and must
  // not — all internal callers were moved to `/api/subjects/...`).
  const aliasMatch = pathname.match(/^\/([^/]+)\/customers(\/.*)?$/);
  if (
    aliasMatch &&
    (routing.locales as readonly string[]).includes(aliasMatch[1])
  ) {
    const url = request.nextUrl.clone();
    url.pathname = `/${aliasMatch[1]}/subjects${aliasMatch[2] ?? ""}`;
    return NextResponse.redirect(url);
  }

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
    return NextResponse.redirect(new URL(signInUrl, canonicalOrigin(request)));
  }

  try {
    await verifyJwtStateless(token);
    return intlMiddleware(request);
  } catch {
    return NextResponse.redirect(new URL(signInUrl, canonicalOrigin(request)));
  }
}

export const config = {
  matcher: "/((?!api|trpc|_next|_vercel|.*\\..*).*)",
};
