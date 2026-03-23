import { type NextRequest, NextResponse } from "next/server";
import createIntlMiddleware from "next-intl/middleware";
import { routing } from "@/i18n/routing";
import { verifyJwtStateless } from "@/lib/auth/jwt-verify-stateless";

const intlMiddleware = createIntlMiddleware(routing);

const PUBLIC_PATHS = ["/api/auth/", "/deny"];

function isPublicPath(pathname: string): boolean {
  return PUBLIC_PATHS.some((p) => pathname.includes(p));
}

export default async function middleware(
  request: NextRequest,
): Promise<NextResponse> {
  const { pathname } = request.nextUrl;

  // Let public paths through without auth check
  if (isPublicPath(pathname)) {
    return intlMiddleware(request);
  }

  // Check for auth cookie
  const token = request.cookies.get("at")?.value;
  if (!token) {
    return NextResponse.redirect(new URL("/api/auth/sign-in", request.url));
  }

  try {
    await verifyJwtStateless(token);
    return intlMiddleware(request);
  } catch {
    // Invalid or expired token — redirect to sign-in
    return NextResponse.redirect(new URL("/api/auth/sign-in", request.url));
  }
}

export const config = {
  matcher: ["/((?!_next|favicon.ico|.*\\..*).*)", "/"],
};
